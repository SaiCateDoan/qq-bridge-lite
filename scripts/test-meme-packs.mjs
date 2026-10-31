// AstrBot 包索引/下载计划：纯解析部分（不联网）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePackEntry, parsePackIndex, packPreviewUrls } from '../src/meme-packs.js';

test('community index 解析：保留包描述/标签/来源，拒绝非法 source', () => {
  const packs = parsePackIndex({ packs: [
    {
      id: 'cat-pack',
      name: '猫猫包',
      description: '猫猫表情',
      tags: ['cat', 'moe'],
      previews: ['previews/cover.png'],
      source: { type: 'github', repo: 'owner/cat-pack', ref: 'v1.0.0', subpath: '.' }
    },
    { id: 'bad', name: '坏包', source: { repo: '../escape', ref: 'main' } }
  ] });
  assert.equal(packs.length, 1);
  assert.equal(packs[0].id, 'cat-pack');
  assert.equal(packs[0].source.repo, 'owner/cat-pack');
  assert.equal(packs[0].source.ref, 'v1.0.0');
  assert.deepEqual(packs[0].tags, ['cat', 'moe']);
});

test('包封面：绝对 URL 原样保留，相对路径拼 raw 仓库', () => {
  const pack = normalizePackEntry({
    id: 'p', name: 'P', previews: ['previews/a.png', 'https://cdn.invalid/b.jpg'],
    source: { repo: 'owner/repo', ref: 'main', subpath: '.' }
  });
  const urls = packPreviewUrls(pack);
  assert.equal(urls[0], 'https://raw.githubusercontent.com/owner/repo/main/previews/a.png');
  assert.equal(urls[1], 'https://cdn.invalid/b.jpg');
});

test('包索引不是扁平图片清单，空 packs 返回空数组', () => {
  assert.deepEqual(parsePackIndex({ schema_version: '1.0.0', packs: [] }), []);
  assert.deepEqual(parsePackIndex({ memes: [] }), []);
});
