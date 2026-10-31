// dsh-meme 只读/写入适配：qq-bridge 通过 DSH Web 的 /dsh-memes-api 使用它的图库能力。
//
// dsh-meme 是 DSH 同进程插件，本身不暴露 MCP；但它注册了：
//   GET  /dsh-memes-api?packId=all          → 所有图库 + 图片元数据
//   GET  /dsh-memes/<pack>/<relative-path>  → 原图
//   POST /dsh-memes-api { op: 'upload', ... } → 存入「我的收藏」
// 这些路由默认只接受回环请求，qq-bridge 在同一台机器上，用原生 fetch 直连即可。
//
// 注意：这里不能走 safeFetch（它会拒绝 127.0.0.1）。调用方必须把 DSH base URL
// 限制在本机回环地址，不能把用户输入拼成任意 host。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MOOD_BUCKETS = Object.freeze({
  happy: new Set(['happy', 'like', 'meow', 'givemoney', 'color']),
  angry: new Set(['angry', 'fool', 'baka']),
  sad: new Set(['sad', 'sigh']),
  shy: new Set(['shy']),
  confused: new Set(['confused', 'surprised', 'see']),
  daily: new Set(['daily', 'sleep', 'morning', 'work', 'cpu', 'reply'])
});

const MOOD_ALIASES = Object.freeze({
  开心: 'happy', 高兴: 'happy', 喜欢: 'happy', 卖萌: 'happy',
  生气: 'angry', 愤怒: 'angry', 吐槽: 'angry',
  难过: 'sad', 无语: 'sad', 委屈: 'sad',
  害羞: 'shy', 不好意思: 'shy',
  困惑: 'confused', 惊讶: 'confused', 震惊: 'confused',
  日常: 'daily', 睡觉: 'daily', 工作: 'daily', 早安: 'daily'
});

function text(value, max = 300) {
  const s = String(value ?? '').replace(/[\s\u00a0\u3000]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function splitTerms(value) {
  return String(value ?? '').toLowerCase().split(/[\s,，;；、]+/).map((x) => x.trim()).filter(Boolean);
}

function moodOf(tag) {
  const raw = String(tag || '').trim().toLowerCase();
  if (!raw) return '';
  if (MOOD_ALIASES[raw]) return MOOD_ALIASES[raw];
  if (MOOD_BUCKETS[raw]) return raw;
  for (const [mood, set] of Object.entries(MOOD_BUCKETS)) if (set.has(raw)) return mood;
  return raw;
}

function normalizeBase(baseUrl) {
  const raw = String(baseUrl || '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(raw); } catch { throw new Error('DSH 地址无效'); }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw new Error('只允许连接本机回环地址的 DSH');
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('DSH 地址必须是 http(s)');
  return raw;
}

export class DshMemeClient {
  constructor({ baseUrl, settingsPath, timeoutMs = 20000 } = {}) {
    this.baseUrl = normalizeBase(baseUrl);
    this.settingsPath = settingsPath || path.join(os.homedir(), '.dsh', 'dsh-expression.json');
    this.timeoutMs = timeoutMs;
  }

  setBaseUrl(baseUrl) {
    this.baseUrl = normalizeBase(baseUrl);
  }

  readSettings() {
    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  async requestJson(pathname, { method = 'GET', body } = {}) {
    const res = await fetch(this.baseUrl + pathname, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) throw new Error(`dsh-meme HTTP ${res.status}${data?.error ? `：${data.error}` : ''}`);
    return data;
  }

  async listAll() {
    const data = await this.requestJson('/dsh-memes-api?packId=all');
    const packs = Array.isArray(data.packs) ? data.packs : [];
    const activeId = String(data.packId || '').trim();
    const settings = this.readSettings();
    const saved = Array.isArray(settings.enabledPacks) ? settings.enabledPacks.map(String) : null;
    const enabled = saved === null
      ? (String(settings.packId || activeId) ? [String(settings.packId || activeId)] : packs.map((p) => String(p.id)))
      : saved;
    const enabledSet = new Set(enabled.filter((id) => packs.some((p) => String(p.id) === id)));
    // 显式 enabledPacks=[] 表示用户全关；只有从没设置过开关时才回落到全部。
    if (!enabledSet.size && saved === null) for (const p of packs) enabledSet.add(String(p.id));
    const packName = new Map(packs.map((p) => [String(p.id), String(p.name || p.id)]));
    const memes = [];
    for (const m of Array.isArray(data.memes) ? data.memes : []) {
      if (!m || typeof m !== 'object' || !m.url) continue;
      let packId = '';
      try {
        const u = new URL(String(m.url), this.baseUrl);
        const parts = u.pathname.split('/').filter(Boolean);
        // /dsh-memes/<packId>/<relative...>
        if (parts[0] === 'dsh-memes' && parts.length >= 3) packId = decodeURIComponent(parts[1]);
      } catch {}
      if (!packId) continue;
      if (!enabledSet.has(packId)) continue;
      const rel = text(m.path || '', 500);
      if (!rel) continue;
      const tag = text(m.tag || '', 40);
      memes.push({
        id: `${packId}/${rel}`,
        pack: packId,
        packName: packName.get(packId) || packId,
        path: rel,
        url: String(m.url),
        tag,
        mood: moodOf(tag),
        caption: text(m.caption || '', 300),
        keywords: text(m.keywords || '', 300)
      });
    }
    return { packs: packs.map((p) => ({ id: String(p.id), name: String(p.name || p.id), count: Number(p.count) || 0 })), enabled: [...enabledSet], memes };
  }

  async search({ query = '', tag = '', limit = 8 } = {}) {
    const { memes } = await this.listAll();
    const max = Math.max(1, Math.min(20, Number(limit) || 8));
    const q = String(query || '').trim().toLowerCase();
    const wantMood = moodOf(tag);
    const terms = splitTerms(q);
    let rows = memes;
    if (wantMood) rows = rows.filter((m) => m.mood === wantMood || MOOD_BUCKETS[wantMood]?.has(m.tag));
    if (!q) {
      // 没有关键词时随机抽，避免每次都撞同一张；和 dsh-meme 的 pick 行为一致。
      rows = rows.slice().sort(() => Math.random() - 0.5).slice(0, max);
      return rows;
    }
    const scored = rows.map((m) => {
      const hay = `${m.caption} ${m.keywords} ${m.path} ${m.tag}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (hay.includes(term)) score += 1;
        if (String(m.caption || '').toLowerCase().includes(term)) score += 1;
      }
      return { m, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.slice(0, max).map((x) => x.m);
  }

  async get(id) {
    const wanted = String(id || '').trim();
    if (!wanted) return null;
    const { memes } = await this.listAll();
    return memes.find((m) => m.id === wanted || m.path === wanted) || null;
  }

  async download(id, { maxBytes = 8 * 1024 * 1024 } = {}) {
    const meme = await this.get(id);
    if (!meme) throw new Error(`dsh-meme 里找不到这张图：${id}`);
    const u = new URL(meme.url, this.baseUrl);
    if (u.origin !== new URL(this.baseUrl).origin || !u.pathname.startsWith('/dsh-memes/')) {
      throw new Error('dsh-meme 返回了非法图片地址');
    }
    const res = await fetch(u, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`dsh-meme 图片 HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) throw new Error(`dsh-meme 返回的不是图片（${type || '未知'}）`);
    const length = Number(res.headers.get('content-length') || 0);
    if (length > maxBytes) throw new Error('dsh-meme 图片超过大小上限');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.length || buffer.length > maxBytes) throw new Error('dsh-meme 图片为空或超过大小上限');
    return { meme, buffer, mimeType: type.split(';')[0] || 'image/png' };
  }

  async upload({ buffer, fileName, tag = 'daily', caption = '', keywords = '' }) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片为空');
    if (buffer.length > 8 * 1024 * 1024) throw new Error('图片超过 dsh-meme 的 8MB 上限');
    const safeTag = String(tag || 'daily').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'daily';
    const safeName = text(fileName || `qq-${Date.now()}.png`, 100).replace(/[\\/:*?"<>|]/g, '_');
    return this.requestJson('/dsh-memes-api', {
      method: 'POST',
      body: {
        op: 'upload',
        tag: safeTag,
        fileName: safeName,
        dataBase64: buffer.toString('base64'),
        caption: text(caption, 200),
        keywords: text(keywords, 200)
      }
    });
  }
}
