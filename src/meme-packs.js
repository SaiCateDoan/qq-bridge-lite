// AstrBot 表情包索引/仓库的只读解析与下载计划。
//
// 这个模块只负责「把远程包描述变成一组可下载图片」：
// - 社区索引：{ schema_version, packs: [{ id, name, description, tags, previews, source }] }
// - 单包 manifest：categories 里有分类说明；可选 extensions.semantic.file 指向逐图语义
// - 图片路径：memes/<category>/<file>；通过 GitHub tree 列举，raw.githubusercontent.com 下载
//
// 不在这里落盘、不在这里发 QQ；桥接负责异步队列、进度、通知和 MemeLibrary 写入。

import { safeFetch } from './safe-fetch.js';

const INDEX_MAX_BYTES = 2 * 1024 * 1024;
const TREE_MAX_BYTES = 8 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 4 * 1024 * 1024;
const SEMANTIC_MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function parseJson(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

async function fetchText(url, maxBytes) {
  const res = await safeFetch(url, maxBytes);
  if (!res || res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res?.statusCode ?? '?'}`);
  return res.body || '';
}

const CATEGORY_LABEL = Object.freeze({
  angry: '生气',
  baka: '笨蛋',
  color: '暧昧',
  confused: '困惑',
  cpu: '卡顿',
  fool: '自嘲',
  givemoney: '要钱',
  happy: '开心',
  like: '喜欢',
  meow: '卖萌',
  morning: '早安',
  reply: '回应',
  sad: '难过',
  see: '偷看',
  shy: '害羞',
  sigh: '无奈',
  sleep: '困倦',
  surprised: '惊讶',
  work: '工作',
  approval: '认可',
  affection: '亲近',
  food: '吃喝',
  money: '金钱',
  greeting: '问候',
  entertainment: '娱乐',
  teasing: '调侃',
  comfort: '安慰',
  tired: '疲惫',
  eating: '吃饭',
  tech: '技术',
  mischief: '调皮'
});

function text(value, max = 300) {
  const s = String(value ?? '').replace(/[\s\u00a0\u3000]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function tags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[,，\s]+/);
  return [...new Set(list.map((x) => text(x, 30)).filter(Boolean))].slice(0, 24);
}

function safeSubpath(value) {
  const raw = String(value ?? '').trim().replace(/\\/g, '/');
  if (!raw || raw === '.') return '';
  const parts = raw.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error('包的 subpath 非法');
  return parts.join('/');
}

function safeRepo(value) {
  const repo = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some((p) => p === '.' || p === '..')) throw new Error(`GitHub 仓库名非法：${repo || '空'}`);
  return repo;
}

function safeRef(value) {
  const ref = String(value ?? '').trim();
  if (!ref || ref.includes('..') || /[\s?#]/.test(ref)) throw new Error(`GitHub ref 非法：${ref || '空'}`);
  return ref;
}

function encodePath(path) {
  return String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

function rawUrl(repo, ref, relPath) {
  return `https://raw.githubusercontent.com/${repo}/${encodePath(ref)}/${encodePath(relPath)}`;
}

function treeUrl(repo, ref) {
  return `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
}

export function normalizePackEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = text(raw.id, 80);
  const name = text(raw.name, 120);
  if (!id || !name) return null;
  const source = raw.source;
  if (!source || typeof source !== 'object') return null;
  let repo;
  let ref;
  let subpath = '';
  try {
    repo = safeRepo(source.repo);
    ref = safeRef(source.ref || 'main');
    subpath = safeSubpath(source.subpath || '');
  } catch {
    return null;
  }
  return {
    id,
    name,
    version: text(raw.version, 40),
    description: text(raw.description, 1000),
    tags: tags(raw.tags),
    previews: (Array.isArray(raw.previews) ? raw.previews : []).map((u) => text(u, 1000)).filter(Boolean).slice(0, 6),
    source: { repo, ref, subpath }
  };
}

export function parsePackIndex(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.packs)) return [];
  return data.packs.map(normalizePackEntry).filter(Boolean);
}

export async function fetchPackIndex(url) {
  const raw = await fetchText(String(url), INDEX_MAX_BYTES);
  let data;
  try { data = parseJson(raw); } catch { throw new Error('图库索引返回的不是 JSON'); }
  const packs = parsePackIndex(data);
  if (!packs.length) throw new Error('图库索引没有可用的 packs[] 条目');
  return packs;
}

function categoryOf(relPath) {
  const parts = String(relPath).split('/').filter(Boolean);
  if (parts[0] === 'memes' && parts.length >= 3) return parts[1];
  return '';
}

function isImagePath(p) {
  const ext = String(p).split('.').pop().toLowerCase();
  return IMAGE_EXT.has(ext);
}

function decodeManifestCategories(manifest) {
  const out = {};
  for (const [key, value] of Object.entries(manifest?.categories || {})) {
    if (value && typeof value === 'object') out[key] = text(value.description, 300);
    else if (typeof value === 'string') out[key] = text(value, 300);
  }
  return out;
}

/**
 * 解析一个包，返回待下载图片列表（不下载图片本身）。
 * 返回 { images, manifest, categories, semanticUsed, truncated }。
 */
export async function planPackImages(pack, { maxImages = 800, log = () => {} } = {}) {
  if (!pack?.source?.repo) throw new Error('包缺少 GitHub source');
  const { repo, ref, subpath } = pack.source;
  const prefix = subpath ? `${subpath}/` : '';
  const manifestPath = `${prefix}manifest.json`;
  let manifest = {};
  try {
    const raw = await fetchText(rawUrl(repo, ref, manifestPath), MANIFEST_MAX_BYTES);
    manifest = parseJson(raw);
  } catch (error) {
    log(`[packs] ${pack.id} manifest 读取失败，按无元数据处理：${error?.message ?? error}`);
  }

  // 可选：逐图语义元数据（AstrBot 的 extensions.semantic.file）
  const semanticByPath = new Map();
  let semanticUsed = false;
  const semanticFile = text(manifest?.extensions?.semantic?.file, 200);
  const semanticRel = `${prefix}${semanticFile}`;
  if (semanticFile && !semanticRel.startsWith('/') && !semanticRel.split('/').includes('..')) {
    try {
      const raw = await fetchText(rawUrl(repo, ref, semanticRel), SEMANTIC_MAX_BYTES);
      const sem = parseJson(raw);
      const images = sem?.images;
      const values = Array.isArray(images) ? images : (images && typeof images === 'object' ? Object.values(images) : []);
      for (const item of values) {
        if (!item || typeof item !== 'object') continue;
        const rel = text(item.relative_path || item.path, 500);
        if (!rel) continue;
        semanticByPath.set(rel, item);
        semanticByPath.set(`${prefix}${rel}`, item);
      }
      semanticUsed = semanticByPath.size > 0;
    } catch (error) {
      log(`[packs] ${pack.id} 语义元数据读取失败，按分类说明兜底：${error?.message ?? error}`);
    }
  }

  const treeRaw = await fetchText(treeUrl(repo, ref), TREE_MAX_BYTES);
  let tree;
  try { tree = parseJson(treeRaw); } catch { throw new Error('GitHub tree 返回的不是 JSON'); }
  if (tree?.truncated) throw new Error('GitHub tree 被截断，仓库过大，暂不支持自动下载');
  const paths = (Array.isArray(tree?.tree) ? tree.tree : [])
    .filter((x) => x?.type === 'blob' && typeof x.path === 'string')
    .map((x) => x.path)
    .filter((p) => (!prefix || p.startsWith(prefix)) && isImagePath(p));
  if (!paths.length) throw new Error('这个包里没有找到图片（memes/ 为空或格式不支持）');

  const categories = decodeManifestCategories(manifest);
  const selected = paths.slice(0, Math.max(1, Math.min(2000, Number(maxImages) || 800)));
  const images = selected.map((fullPath) => {
    const relPath = prefix && fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
    const category = categoryOf(relPath);
    const label = CATEGORY_LABEL[category] || category;
    const sem = semanticByPath.get(relPath) || semanticByPath.get(fullPath) || {};
    const categoryDesc = categories[category] || '';
    const caption = text(sem.caption || `${pack.name}${label ? ` · ${label}` : ''}${categoryDesc ? `：${categoryDesc}` : ''}`, 300);
    return {
      url: rawUrl(repo, ref, fullPath),
      relativePath: relPath,
      category,
      caption,
      emotion: text(sem.emotion || label || '', 40),
      tags: tags([...(pack.tags || []), category, label, ...(Array.isArray(sem.tags) ? sem.tags : [])]),
      keywords: tags([...(categoryDesc ? categoryDesc.split(/[，,。；;\s]+/) : []), ...(Array.isArray(sem.tags) ? sem.tags : [])])
    };
  });

  return {
    images,
    manifest,
    categories,
    semanticUsed,
    truncated: paths.length > selected.length,
    totalPaths: paths.length
  };
}

/** 把一个包的预览图地址解析成绝对 URL（相对路径用 raw 仓库拼）。 */
export function packPreviewUrls(pack) {
  const base = pack?.source?.repo
    ? `https://raw.githubusercontent.com/${pack.source.repo}/${encodePath(pack.source.ref)}/`
    : '';
  return (Array.isArray(pack?.previews) ? pack.previews : [])
    .map((u) => String(u || '').trim())
    .filter(Boolean)
    .map((u) => (/^https?:\/\//i.test(u) ? u : (base ? base + encodePath((pack.source.subpath ? `${pack.source.subpath}/` : '') + u) : '')))
    .filter(Boolean)
    .slice(0, 4);
}
