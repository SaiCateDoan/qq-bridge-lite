// 本地表情图库：把聊天里收到的图片 / 手动放进来的图片，变成 AI 可收集、可发送的图库。
//
// 设计要点：
// - 图片按内容寻址存 files/<sha256>.<ext>，索引只存元数据；同一张图只存一份。
// - 索引损坏时不整体报废：先保留现场，再尝试 .bak，最后从 files/ 重建；
//   单条元数据坏了只跳过这一条，图片仍在。
// - 用户手动往 inbox/ 或 files/ 丢图片，refresh() 会按 magic 识别并补进索引。
// - 所有路径都限制在 root 内；写索引原子替换并保留上一份备份。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { looksLikeImageBuffer } from './safe-fetch.js';

const INDEX_VERSION = 1;
const MIME_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
});

const clampText = (value, max = 200) => {
  const s = String(value ?? '')
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .trim();
  return s.length > max ? s.slice(0, max) : s;
};

const clampTags = (value) => {
  const list = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[,，\s]+/);
  return [...new Set(list.map((t) => clampText(t, 24)).filter(Boolean))].slice(0, 20);
};

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function mimeFromBuffer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return '';
}

function extFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

function mimeFromExt(file) {
  return MIME_BY_EXT[String(path.extname(file)).slice(1).toLowerCase()] || '';
}

function formatId(n) {
  const value = Math.max(1, Math.round(Number(n) || 1));
  return `#${String(value).padStart(2, '0')}`;
}

function parseId(id) {
  const m = /^#(\d+)$/.exec(String(id ?? '').trim());
  return m ? Number(m[1]) : 0;
}

function safeRelInside(root, rel) {
  const resolved = path.resolve(root, String(rel ?? ''));
  const prefix = path.resolve(root) + path.sep;
  return resolved === path.resolve(root) || resolved.startsWith(prefix) ? resolved : null;
}

function normalizeEntry(raw, { root } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id || '').trim();
  if (!/^#\d+$/.test(id)) return null;
  const sha = String(raw.sha256 || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return null;
  const file = String(raw.file || '').replace(/\\/g, '/').trim();
  if (!file) return null;
  const abs = safeRelInside(root, file);
  if (!abs) return null;
  const mime = String(raw.mime || mimeFromExt(file) || 'image/png').trim();
  if (!mime.startsWith('image/')) return null;
  const size = clampInt(raw.bytes, 0, 200 * 1024 * 1024, 0);
  return {
    id,
    sha256: sha,
    file: path.relative(root, abs).replace(/\\/g, '/'),
    mime,
    bytes: size,
    width: clampInt(raw.width, 0, 100_000, 0),
    height: clampInt(raw.height, 0, 100_000, 0),
    source: ['chat', 'inbox', 'files', 'remote', 'pack', 'manual'].includes(raw.source) ? raw.source : 'manual',
    sourceUrl: clampText(raw.sourceUrl, 500),
    packId: clampText(raw.packId, 80),
    packName: clampText(raw.packName, 120),
    packVersion: clampText(raw.packVersion, 40),
    originalName: clampText(raw.originalName, 120),
    category: clampText(raw.category, 40),
    emotion: clampText(raw.emotion, 40),
    emotionAlt: clampTags(raw.emotionAlt),
    caption: clampText(raw.caption, 300),
    tags: clampTags(raw.tags),
    keywords: clampTags(raw.keywords),
    useCount: clampInt(raw.useCount, 0, 1_000_000, 0),
    lastUsedAt: clampInt(raw.lastUsedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    createdAt: String(raw.createdAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    broken: raw.broken === true,
    brokenReason: clampText(raw.brokenReason, 120)
  };
}

export class MemeLibrary {
  constructor({ root, maxBytes = 10 * 1024 * 1024, maxEntries = 3000, log = () => {} } = {}) {
    if (!root) throw new Error('MemeLibrary 缺少 root');
    this.root = path.resolve(String(root));
    this.filesDir = path.join(this.root, 'files');
    this.inboxDir = path.join(this.root, 'inbox');
    this.indexFile = path.join(this.root, 'index.json');
    this.backupFile = `${this.indexFile}.bak`;
    this.maxBytes = clampInt(maxBytes, 256 * 1024, 40 * 1024 * 1024, 10 * 1024 * 1024);
    this.maxEntries = clampInt(maxEntries, 10, 20_000, 3000);
    this.log = typeof log === 'function' ? log : () => {};
    this.entries = [];
    this.loaded = false;
    this.lastScanAt = 0;
    this.lastRecovery = '';
    this.dirMtime = 0;
    this.indexMtimeCache = 0;
  }

  ensureDirs() {
    for (const dir of [this.root, this.filesDir, this.inboxDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try { fs.chmodSync(this.root, 0o700); } catch {}
  }

  indexMtime() {
    try { return fs.statSync(this.indexFile).mtimeMs; } catch { return 0; }
  }

  filesMtime() {
    try { return fs.statSync(this.filesDir).mtimeMs; } catch { return 0; }
  }

  watchMtime() {
    let max = this.filesMtime();
    try { max = Math.max(max, fs.statSync(this.inboxDir).mtimeMs); } catch {}
    return max;
  }

  nextId(entries = this.entries) {
    let max = 0;
    for (const e of entries) max = Math.max(max, parseId(e.id));
    return max + 1;
  }

  normalizeAll(rawList) {
    const seenId = new Set();
    const seenSha = new Set();
    const out = [];
    let skipped = 0;
    for (const raw of Array.isArray(rawList) ? rawList : []) {
      const entry = normalizeEntry(raw, { root: this.root });
      if (!entry) { skipped += 1; continue; }
      if (seenId.has(entry.id) || seenSha.has(entry.sha256)) { skipped += 1; continue; }
      seenId.add(entry.id);
      seenSha.add(entry.sha256);
      out.push(entry);
    }
    return { entries: out, skipped };
  }

  readIndexFile(file) {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const parsed = JSON.parse(text);
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
    if (!list) throw new Error('索引顶层不是数组或 {entries:[]}');
    return list;
  }

  loadIndexWithRecovery() {
    this.ensureDirs();
    if (!fs.existsSync(this.indexFile)) {
      if (fs.existsSync(this.backupFile)) {
        try {
          const entries = this.readIndexFile(this.backupFile);
          this.log('[memes] index.json 缺失，已从 .bak 恢复');
          return { entries, recovery: 'index.json 缺失，已从 .bak 恢复' };
        } catch {}
      }
      return { entries: [], recovery: '' };
    }

    try {
      return { entries: this.readIndexFile(this.indexFile), recovery: '' };
    } catch (error) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const corrupt = path.join(this.root, `index.corrupt-${stamp}.json`);
      try { fs.copyFileSync(this.indexFile, corrupt); } catch {}
      try { fs.renameSync(this.indexFile, `${this.indexFile}.corrupt-${stamp}`); } catch {}
      const note = `索引损坏，已保留现场：${path.basename(corrupt)}（${error?.message ?? error}）`;
      this.log(`[memes] ${note}`);

      // 先尝试上一份好备份；备份也坏就重建。
      if (fs.existsSync(this.backupFile)) {
        try {
          const entries = this.readIndexFile(this.backupFile);
          this.log('[memes] 已从 index.json.bak 恢复');
          return { entries, recovery: `${note}；已从 .bak 恢复` };
        } catch (backupError) {
          this.log(`[memes] 备份也不可用：${backupError?.message ?? backupError}`);
        }
      }
      return { entries: [], recovery: `${note}；将从 files/ 重建` };
    }
  }

  readIndexRaw() {
    try {
      const raw = this.readIndexFile(this.indexFile);
      return this.normalizeAll(raw);
    } catch {
      return { entries: [], skipped: 0 };
    }
  }

  save() {
    this.ensureDirs();
    const payload = {
      version: INDEX_VERSION,
      savedAt: new Date().toISOString(),
      entries: this.entries
    };
    const tmp = `${this.indexFile}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      // 仅当前索引可解析时才把它留作备份，避免把坏文件备份成“好文件”。
      try {
        this.readIndexFile(this.indexFile);
        fs.copyFileSync(this.indexFile, this.backupFile);
      } catch {}
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.indexFile);
      this.dirMtime = this.watchMtime();
      this.indexMtimeCache = this.indexMtime();
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch {}
      throw error;
    }
  }

  /** 扫描 files/ 与 inbox/，补齐/修复索引。可反复调用。 */
  refresh({ save = true } = {}) {
    this.ensureDirs();
    const before = this.entries.length;
    const missingBefore = this.entries.filter((e) => e.broken || !fs.existsSync(path.join(this.root, e.file))).length;
    const bySha = new Map(this.entries.map((e) => [e.sha256, e]));
    const byFile = new Map(this.entries.map((e) => [e.file, e]));
    let added = 0;
    let repaired = 0;

    // 1) inbox/ 递归导入：先复制到 files/，成功后再删；失败不影响其它文件。
    const walkInbox = (dir) => {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of names) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) { walkInbox(p); continue; }
        if (!ent.isFile()) continue;
        try {
          const buf = fs.readFileSync(p);
          if (!looksLikeImageBuffer(buf)) continue;
          const result = this.addBuffer(buf, {
            mime: mimeFromBuffer(buf),
            source: 'inbox',
            originalName: ent.name,
            caption: path.basename(ent.name, path.extname(ent.name))
          }, { save: false });
          if (!result.duplicate) added += 1;
          fs.unlinkSync(p);
        } catch (error) {
          this.log(`[memes] inbox 导入失败 ${ent.name}: ${error?.message ?? error}`);
        }
      }
    };
    walkInbox(this.inboxDir);

    // 1b) 根目录直接丢的图片也收编（用户打开文件夹后最容易这么做）。
    let loose = [];
    try { loose = fs.readdirSync(this.root, { withFileTypes: true }); } catch {}
    for (const ent of loose) {
      if (!ent.isFile()) continue;
      const abs = path.join(this.root, ent.name);
      try {
        const buf = fs.readFileSync(abs);
        if (!looksLikeImageBuffer(buf)) continue;
        const result = this.addBuffer(buf, {
          mime: mimeFromBuffer(buf),
          source: 'files',
          originalName: ent.name,
          caption: path.basename(ent.name, path.extname(ent.name))
        }, { save: false });
        if (!result.duplicate) added += 1;
        fs.unlinkSync(abs);
      } catch (error) {
        this.log(`[memes] 根目录图片导入失败 ${ent.name}: ${error?.message ?? error}`);
      }
    }

    // 2) files/ 里用户手动丢进来的图片（以及重命名后的文件）补索引/重连。
    let files = [];
    try { files = fs.readdirSync(this.filesDir, { withFileTypes: true }); } catch {}
    for (const ent of files) {
      if (!ent.isFile()) continue;
      const abs = path.join(this.filesDir, ent.name);
      let buf;
      try { buf = fs.readFileSync(abs); } catch { continue; }
      if (!looksLikeImageBuffer(buf)) continue;
      const sha = sha256(buf);
      const rel = path.relative(this.root, abs).replace(/\\/g, '/');
      const existing = bySha.get(sha);
      if (existing) {
        if (existing.file !== rel) {
          const oldAbs = path.join(this.root, existing.file);
          if (!fs.existsSync(oldAbs)) {
            existing.file = rel;
            repaired += 1;
          }
        }
        continue;
      }
      const byPath = byFile.get(rel);
      if (byPath) continue;
      try {
        const result = this.addBuffer(buf, {
          mime: mimeFromBuffer(buf),
          source: 'files',
          originalName: ent.name,
          caption: path.basename(ent.name, path.extname(ent.name))
        }, { save: false });
        if (!result.duplicate) added += 1;
      } catch (error) {
        this.log(`[memes] files 补索引失败 ${ent.name}: ${error?.message ?? error}`);
      }
    }

    // 3) 校验每条记录：文件在不在、大小对不对；内容哈希只在读取/发送时验（避免每次启动全量哈希）。
    for (const entry of this.entries) {
      const abs = path.join(this.root, entry.file);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile()) throw new Error('不是文件');
        if (entry.bytes !== stat.size) {
          entry.bytes = stat.size;
          entry.updatedAt = new Date().toISOString();
        }
        if (entry.broken) { entry.broken = false; entry.brokenReason = ''; repaired += 1; }
      } catch {
        if (!entry.broken) {
          entry.broken = true;
          entry.brokenReason = '文件不存在';
          repaired += 1;
        }
      }
    }

    this.lastScanAt = Date.now();
    this.dirMtime = this.watchMtime();
    if (save) this.save();
    const missingAfter = this.entries.filter((e) => e.broken).length;
    return {
      added,
      repaired,
      removed: 0,
      before,
      after: this.entries.length,
      missing: missingAfter,
      missingBefore,
      skipped: 0
    };
  }

  load({ scan = true } = {}) {
    if (this.loaded && !scan) return this;
    this.ensureDirs();
    const { entries: rawEntries, recovery } = this.loadIndexWithRecovery();
    const normalized = this.normalizeAll(rawEntries);
    this.entries = normalized.entries;
    this.lastRecovery = recovery || (normalized.skipped ? `已跳过 ${normalized.skipped} 条损坏元数据` : '');
    this.loaded = true;
    if (scan) this.refresh({ save: true });
    else this.save();
    this.indexMtimeCache = this.indexMtime();
    return this;
  }

  ensureFresh() {
    const idxMtime = this.indexMtime();
    if (!this.loaded) this.load({ scan: true });
    else if (idxMtime !== this.indexMtimeCache) this.load({ scan: true });
    else if (this.watchMtime() !== this.dirMtime) this.refresh({ save: true });
    this.indexMtimeCache = this.indexMtime();
  }

  addBuffer(buffer, meta = {}, { save = true } = {}) {
    this.ensureDirs();
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片字节为空');
    if (buffer.length > this.maxBytes) throw new Error(`图片超过上限（${Math.round(buffer.length / 1024)}KB > ${Math.round(this.maxBytes / 1024)}KB）`);
    if (!looksLikeImageBuffer(buffer)) throw new Error('不是有效图片（PNG/JPEG/GIF/WebP）');

    const sha = sha256(buffer);
    const existing = this.entries.find((e) => e.sha256 === sha);
    if (existing) return { entry: existing, duplicate: true };
    if (this.entries.length >= this.maxEntries) throw new Error(`图库条目已达上限 ${this.maxEntries}`);

    const mime = mimeFromBuffer(buffer) || String(meta.mime || 'image/png');
    const ext = extFromMime(mime);
    const rel = `files/${sha}.${ext}`;
    const abs = path.join(this.root, rel);
    if (!fs.existsSync(abs)) {
      fs.writeFileSync(abs, buffer, { mode: 0o600, flag: 'wx' });
    }

    const now = new Date().toISOString();
    const entry = normalizeEntry({
      id: formatId(this.nextId()),
      sha256: sha,
      file: rel,
      mime,
      bytes: buffer.length,
      width: meta.width,
      height: meta.height,
      source: meta.source || 'manual',
      sourceUrl: meta.sourceUrl,
      packId: meta.packId,
      packName: meta.packName,
      packVersion: meta.packVersion,
      originalName: meta.originalName,
      category: meta.category,
      emotion: meta.emotion,
      emotionAlt: meta.emotionAlt,
      caption: meta.caption,
      tags: meta.tags,
      keywords: meta.keywords,
      useCount: 0,
      lastUsedAt: 0,
      createdAt: now,
      updatedAt: now
    }, { root: this.root });
    if (!entry) throw new Error('图片元数据无效');
    this.entries.push(entry);
    if (save) this.save();
    return { entry, duplicate: false };
  }

  get(id) {
    this.ensureFresh();
    const ref = String(id ?? '').trim();
    if (!ref) return null;
    return this.entries.find((e) => e.id === ref || e.sha256 === ref.toLowerCase()) || null;
  }

  list({ query = '', category = '', emotion = '', limit = 100, offset = 0 } = {}) {
    this.ensureFresh();
    const q = String(query ?? '').trim().toLowerCase();
    const cat = String(category ?? '').trim().toLowerCase();
    const emo = String(emotion ?? '').trim().toLowerCase();
    let list = this.entries.filter((e) => {
      if (e.broken) return false;
      if (cat && String(e.category || '').toLowerCase() !== cat) return false;
      if (emo && !`${e.emotion} ${(e.emotionAlt || []).join(' ')}`.toLowerCase().includes(emo)) return false;
      if (!q) return true;
      const haystack = [e.id, e.packName, e.caption, e.category, e.emotion, ...(e.emotionAlt || []), ...(e.tags || []), ...(e.keywords || [])].join(' ').toLowerCase();
      return haystack.includes(q);
    });
    list.sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const max = clampInt(limit, 1, 500, 100);
    const start = clampInt(offset, 0, 100_000, 0);
    return { total: list.length, offset: start, limit: max, entries: list.slice(start, start + max) };
  }

  /** 按当前对话文本做轻量排序：关键词/标签/情绪命中 + 使用次数，不依赖 embedding。 */
  rank(contextText = '', limit = 5) {
    this.ensureFresh();
    const text = String(contextText ?? '').toLowerCase();
    const scored = this.entries.filter((e) => !e.broken).map((e) => {
      let score = Math.min(8, e.useCount || 0) * 0.05;
      const terms = [e.category, e.emotion, ...(e.emotionAlt || []), ...(e.tags || []), ...(e.keywords || []), e.caption]
        .map((s) => String(s || '').trim().toLowerCase())
        .filter((s) => s.length >= 2);
      for (const term of terms) {
        if (text.includes(term)) score += term.length >= 3 ? 0.35 : 0.18;
      }
      return { entry: e, score: Math.min(1, Number(score.toFixed(2))) };
    });
    scored.sort((a, b) => b.score - a.score || (b.entry.useCount || 0) - (a.entry.useCount || 0));
    return scored.slice(0, clampInt(limit, 1, 20, 5));
  }

  readBuffer(entry) {
    if (!entry) throw new Error('表情不存在');
    const abs = safeRelInside(this.root, entry.file);
    if (!abs) throw new Error('表情路径越界');
    let buf;
    try { buf = fs.readFileSync(abs); } catch (error) {
      entry.broken = true;
      entry.brokenReason = `文件读取失败：${error?.message ?? error}`;
      this.save();
      throw new Error(`表情文件不可读：${entry.brokenReason}`);
    }
    if (buf.length !== entry.bytes) {
      entry.bytes = buf.length;
      entry.updatedAt = new Date().toISOString();
    }
    if (!looksLikeImageBuffer(buf)) {
      entry.broken = true;
      entry.brokenReason = '文件内容已不是有效图片';
      this.save();
      throw new Error(entry.brokenReason);
    }
    if (sha256(buf) !== entry.sha256) {
      entry.broken = true;
      entry.brokenReason = '文件内容与索引哈希不一致（可能被手动改过）';
      this.save();
      throw new Error(entry.brokenReason);
    }
    return buf;
  }

  note(id, patch = {}) {
    this.ensureFresh();
    const entry = this.get(id);
    if (!entry) return null;
    if (patch.caption !== undefined) entry.caption = clampText(patch.caption, 300);
    if (patch.category !== undefined) entry.category = clampText(patch.category, 40);
    if (patch.emotion !== undefined) entry.emotion = clampText(patch.emotion, 40);
    if (patch.emotionAlt !== undefined) entry.emotionAlt = clampTags(patch.emotionAlt);
    if (patch.tags !== undefined) entry.tags = clampTags(patch.tags);
    if (patch.keywords !== undefined) entry.keywords = clampTags(patch.keywords);
    entry.updatedAt = new Date().toISOString();
    this.save();
    return entry;
  }

  markUsed(id, context = '') {
    const entry = this.get(id);
    if (!entry) return null;
    entry.useCount = (entry.useCount || 0) + 1;
    entry.lastUsedAt = Date.now();
    entry.updatedAt = new Date().toISOString();
    this.save();
    return entry;
  }

  stats() {
    this.ensureFresh();
    const categories = {};
    const emotions = {};
    const sources = {};
    let available = 0;
    let broken = 0;
    let boldBytes = 0;
    for (const e of this.entries) {
      if (e.broken) { broken += 1; continue; }
      available += 1;
      boldBytes += e.bytes || 0;
      const c = e.category || '未分类';
      categories[c] = (categories[c] || 0) + 1;
      const em = e.emotion || '未标注';
      emotions[em] = (emotions[em] || 0) + 1;
      sources[e.source || 'manual'] = (sources[e.source || 'manual'] || 0) + 1;
    }
    return {
      total: this.entries.length,
      available,
      broken,
      missing: broken,
      totalBytes: boldBytes,
      categories,
      emotions,
      sources,
      lastScanAt: this.lastScanAt,
      lastRecovery: this.lastRecovery,
      root: this.root
    };
  }

  publicEntry(entry) {
    return {
      id: entry.id,
      sha256: entry.sha256,
      mime: entry.mime,
      bytes: entry.bytes,
      width: entry.width,
      height: entry.height,
      source: entry.source,
      packId: entry.packId,
      packName: entry.packName,
      packVersion: entry.packVersion,
      category: entry.category,
      emotion: entry.emotion,
      emotionAlt: entry.emotionAlt,
      caption: entry.caption,
      tags: entry.tags,
      keywords: entry.keywords,
      useCount: entry.useCount,
      lastUsedAt: entry.lastUsedAt,
      createdAt: entry.createdAt,
      broken: entry.broken,
      brokenReason: entry.brokenReason
    };
  }
}
