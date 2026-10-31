// 本地表情图库：收集/去重、索引损坏重建、inbox 导入、单文件损坏隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { MemeLibrary } from '../src/meme-library.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-meme-lib-'));
const png = (r, g, b) => sharp({
  create: { width: 12, height: 12, channels: 3, background: { r, g, b } }
}).png().toBuffer();

test('收集/去重/统计/搜索', async () => {
  const root = tmp();
  const lib = new MemeLibrary({ root });
  lib.load({ scan: true });
  const a = await png(255, 0, 0);
  const b = await png(0, 255, 0);
  const r1 = lib.addBuffer(a, { source: 'chat', caption: '红色', tags: ['红'], emotion: '开心' });
  const r2 = lib.addBuffer(a, { source: 'chat' });
  assert.equal(r1.duplicate, false);
  assert.equal(r2.duplicate, true);
  assert.equal(r1.entry.id, '#01');
  lib.addBuffer(b, { source: 'chat', caption: '绿色', category: 'meme' });
  const stats = lib.stats();
  assert.equal(stats.available, 2);
  assert.equal(stats.total, 2);
  assert.equal(lib.list({ query: '红' }).total, 1);
  assert.equal(lib.list({ category: 'meme' }).total, 1);
  assert.ok(lib.rank('今天好开心', 2).length >= 1);
  await lib.readBuffer(r1.entry);
  assert.equal(fs.readdirSync(path.join(root, 'files')).length, 2);
});

test('索引 JSON 损坏：保留现场并从图片重建，不整体报废', async () => {
  const root = tmp();
  const lib = new MemeLibrary({ root });
  lib.load({ scan: true });
  lib.addBuffer(await png(10, 20, 30), { caption: '甲' });
  lib.addBuffer(await png(40, 50, 60), { caption: '乙' });
  fs.writeFileSync(path.join(root, 'index.json'), '{ this is not json', 'utf8');
  const lib2 = new MemeLibrary({ root });
  lib2.load({ scan: true });
  const stats = lib2.stats();
  assert.equal(stats.available, 2, '图片还在，应重建出 2 条');
  assert.match(stats.lastRecovery, /索引损坏/);
  assert.ok(fs.readdirSync(root).some((n) => n.startsWith('index.corrupt-')));
});

test('单条元数据坏了只跳过该条；备份可用时优先恢复', async () => {
  const root = tmp();
  const lib = new MemeLibrary({ root });
  lib.load({ scan: true });
  const a = lib.addBuffer(await png(1, 2, 3), { caption: '甲' });
  lib.note(a.entry.id, { caption: '甲2' }); // 第二次保存会留下 index.json.bak
  const idx = JSON.parse(fs.readFileSync(path.join(root, 'index.json'), 'utf8'));
  idx.entries.push({ id: 'bad', sha256: 'x', file: '../outside.png' });
  fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(idx), 'utf8');
  const lib2 = new MemeLibrary({ root });
  lib2.load({ scan: true });
  assert.ok(lib2.stats().available >= 1);
  fs.writeFileSync(path.join(root, 'index.json'), 'not-json', 'utf8');
  const lib3 = new MemeLibrary({ root });
  lib3.load({ scan: true });
  assert.ok(lib3.stats().available >= 1, '备份/重建后图片仍可用');
});

test('inbox 丢文件后 refresh 自动收编；文件损坏只标记该条', async () => {
  const root = tmp();
  const lib = new MemeLibrary({ root });
  lib.load({ scan: true });
  fs.mkdirSync(path.join(root, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, 'inbox', '手动.png'), await png(9, 9, 9));
  const r = lib.refresh();
  assert.ok(r.added >= 1);
  const entry = lib.list().entries[0];
  const abs = path.join(root, entry.file);
  fs.writeFileSync(abs, Buffer.from('corrupted'));
  assert.throws(() => lib.readBuffer(entry), /不是有效图片|哈希/);
  const stats = lib.stats();
  assert.ok(stats.broken >= 1);
  assert.ok(stats.available >= 0);
});

test('桥接接线：从聊天消息收图进本地图库', async () => {
  const KEY = 'group:456';
  const gif = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
  const h = await bridgeHarness({
    globals: { safeFetchBuffer: async () => ({ buffer: gif, mimeType: 'image/gif' }) }
  });
  try {
    await h.initControllerOnce('reserved2');
    h.setMode('reserved2');
    h.appendSocialV2Message(KEY, '甲', '[表情]', '[表情]', false, false, '777', [{ kind: 'image', url: 'https://public.invalid/a.gif' }], '20001');
    const r = await h.collectMemeV2(KEY, '777', '测试表情', ['测试']);
    assert.equal(r.duplicate, false);
    assert.equal(r.entry.caption, '测试表情');
    assert.ok(h.memeLibrary.list({ query: '测试' }).total >= 1);
    const again = await h.collectMemeV2(KEY, '777', '测试表情');
    assert.equal(again.duplicate, true);
  } finally {
    await h.close();
  }
});

test('远程图库：按描述检索候选项，发送时下载并缓存到本地', async () => {
  const KEY = 'group:456';
  const gif = Buffer.from('47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b', 'hex');
  const manifest = JSON.stringify({ memes: [
    { url: 'https://public.invalid/cat.gif', caption: '得意的猫', tags: ['猫', '得意'], emotion: '得意' },
    { url: 'https://public.invalid/dog.gif', caption: '无语的狗', tags: ['狗', '无语'], emotion: '无语' }
  ] });
  const h = await bridgeHarness({
    globals: {
      safeFetch: async () => manifest,
      safeFetchBuffer: async () => ({ buffer: gif, mimeType: 'image/gif' })
    }
  });
  try {
    h.cfg.socialV2.memes.remoteUrl = 'https://public.invalid/memes.json';
    const results = await h.searchMemes('得意的猫', 5);
    const remote = results.find((r) => r.source === 'remote');
    assert.ok(remote, '应返回远程候选');
    assert.equal(remote.caption, '得意的猫');
    const entry = await h.resolveMemeEntry(remote.id);
    assert.equal(entry.caption, '得意的猫');
    assert.ok(h.memeLibrary.get(entry.id));
  } finally {
    await h.close();
  }
});

test('包下载完成通知进入唤醒提示且只消费一次', async () => {
  const KEY = 'group:456';
  const h = await bridgeHarness();
  try {
    const st = h.getSocialV2State(KEY);
    st.packNotices = [{ packId: 'demo', packName: '测试包', downloaded: 3, duplicate: 1, failed: 0, at: Date.now() }];
    const text = h.buildWakePromptV2(KEY, 'pack');
    assert.match(text, /图库下载完成/);
    assert.match(text, /测试包/);
    assert.match(text, /不要主动发消息/);
    assert.equal(st.packNotices.length, 0);
    const again = h.buildWakePromptV2(KEY, 'pack');
    assert.doesNotMatch(again, /测试包/);
  } finally {
    await h.close();
  }
});

test('默认 backend=astrbot：唤醒提示只出现 AstrBot 工具', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2.memes.remoteUrl = 'https://example.invalid/memes.json';
    const text = h.buildWakePromptV2('group:456', 'test');
    assert.match(text, /qq_search_meme_packs/);
    assert.match(text, /qq_collect_meme/);
    assert.doesNotMatch(text, /qq_dshmeme_search/);
    assert.doesNotMatch(text, /qq_list_stickers/);
  } finally { await h.close(); }
});
