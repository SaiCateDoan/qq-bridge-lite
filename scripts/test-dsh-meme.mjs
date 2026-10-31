// dsh-meme HTTP 适配：只测协议/过滤/下载/上传，不依赖真实 DSH。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshMemeClient } from '../src/dsh-meme-client.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=', 'base64');

function startServer() {
  const state = { uploads: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/dsh-memes-api' && req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true, total: 2, packId: 'p1',
        packs: [{ id: 'p1', name: '一号', count: 1 }, { id: 'p2', name: '二号', count: 1 }],
        memes: [
          { path: 'memes/happy/a.jpg', tag: 'happy', caption: '开心猫猫', keywords: '猫 开心', url: '/dsh-memes/p1/memes/happy/a.jpg' },
          { path: 'memes/work/b.jpg', tag: 'work', caption: '上班摸鱼', keywords: '摸鱼 上班', url: '/dsh-memes/p2/memes/work/b.jpg' }
        ]
      }));
      return;
    }
    if (url.pathname === '/dsh-memes/p1/memes/happy/a.jpg') {
      res.setHeader('content-type', 'image/png');
      res.end(png);
      return;
    }
    if (url.pathname === '/dsh-memes-api' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      state.uploads.push(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, meme: { path: 'memes/daily/x.png', tag: parsed.tag } }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })));
}

test('只读启用的图库，并支持描述/情绪检索、下载和上传', async () => {
  const { server, state, port } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meme-client-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ enabledPacks: ['p1'] }));
  const client = new DshMemeClient({ baseUrl: `http://127.0.0.1:${port}`, settingsPath });
  try {
    const all = await client.listAll();
    assert.deepEqual(all.enabled, ['p1']);
    assert.equal(all.memes.length, 1);
    const hit = await client.search({ query: '开心', limit: 3 });
    assert.equal(hit[0].caption, '开心猫猫');
    const got = await client.download(hit[0].id);
    assert.equal(got.buffer.length, png.length);
    assert.match(got.mimeType, /image\/png/);
    const up = await client.upload({ buffer: png, fileName: 'a.png', tag: 'daily', caption: '测试' });
    assert.equal(up.ok, true);
    assert.equal(state.uploads[0].op, 'upload');
    assert.equal(state.uploads[0].dataBase64.length > 0, true);
  } finally {
    client.close?.();
    server.close();
  }
});

test('enabledPacks 为空表示全关，不回落到全部', async () => {
  const { server, port } = await startServer();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-meme-client-'));
  const settingsPath = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ enabledPacks: [] }));
  const client = new DshMemeClient({ baseUrl: `http://127.0.0.1:${port}`, settingsPath });
  try {
    const all = await client.listAll();
    assert.equal(all.memes.length, 0);
  } finally { server.close(); }
});

test('唤醒提示优先引导 dsh-meme，不出现旧收藏工具', async () => {
  const h = await bridgeHarness();
  try {
    h.cfg.socialV2.memeBackend = 'dshmeme';
    const text = h.buildWakePromptV2('group:456', 'test');
    assert.match(text, /qq_dshmeme_search/);
    assert.match(text, /qq_dshmeme_send/);
    assert.match(text, /dsh-meme/);
    assert.doesNotMatch(text, /qq_list_stickers/);
  } finally { await h.close(); }
});
