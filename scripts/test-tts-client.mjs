import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GptSovitsClient } from '../src/tts-client.js';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const REF = 'D:/tmp/reference.wav';
const PROMPT = '参考音频原话';

test('TTS 客户端：回环地址、请求参数与 WAV 返回', async () => {
  let received = null;
  const server = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received = JSON.parse(body);
      const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(8)]);
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length });
      res.end(wav);
    });
  });
  try {
    const port = server.address().port;
    const client = new GptSovitsClient({
      baseUrl: `http://127.0.0.1:${port}`,
      refAudioPath: REF,
      promptText: PROMPT,
      promptLang: 'zh',
      textLang: 'zh',
      timeoutMs: 5000
    });
    const out = await client.synthesize('你好');
    assert.equal(out.mimeType, 'audio/wav');
    assert.equal(received.text, '你好');
    assert.equal(received.ref_audio_path, REF);
    assert.equal(received.prompt_text, PROMPT);
    assert.equal(received.media_type, 'wav');
    assert.equal(received.streaming_mode, false);
  } finally {
    server.close();
  }
});

test('TTS 客户端：拒绝非回环地址', () => {
  assert.throws(() => new GptSovitsClient({
    baseUrl: 'http://example.com:9880',
    refAudioPath: REF,
    promptText: PROMPT
  }), /回环地址/);
});

test('TTS 客户端：400 JSON 错误转成可读异常', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'tts failed', Exception: 'No module named resampy' }));
  });
  try {
    const client = new GptSovitsClient({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      refAudioPath: REF,
      promptText: PROMPT,
      timeoutMs: 5000
    });
    await assert.rejects(() => client.synthesize('你好'), /No module named resampy/);
  } finally {
    server.close();
  }
});
