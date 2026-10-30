// 图片压缩 / 动图抽帧自检：用 sharp 生成测试图，验证“超限压缩 + 多帧抽取 + 首尾采样”。
// 运行：node scripts/test-media-compress.mjs
import assert from 'node:assert/strict';
import { randomFillSync } from 'node:crypto';
import sharp from 'sharp';
import { hasImageCodec, prepareImage } from '../src/media-compress.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `${name}${extra ? ` — ${extra}` : ''}`);
  passed += 1;
  console.log(`✅ ${name}${extra ? ` — ${extra}` : ''}`);
};

check('sharp/libvips 可用', hasImageCodec());

// 1) 限制内的静态图原样透传，避免无意义二次编码。
{
  const png = await sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } }
  }).png().toBuffer();
  const out = await prepareImage(png, { maxBytes: 1024 * 1024, maxLongEdge: 1280 });
  check('静态小图透传', out?.frames?.length === 1 && out.frames[0].passThrough === true, out?.frames?.[0]?.mimeType);
  check('透传字节不变', out.frames[0].buffer.equals(png));
}

// 2) 超大图不再直接丢弃：按预算压成 WebP，且长边受控。
{
  const width = 1200;
  const height = 900;
  const raw = Buffer.alloc(width * height * 3);
  randomFillSync(raw);
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const budget = 300 * 1024;
  const out = await prepareImage(png, { maxBytes: budget, maxLongEdge: 700, quality: 82 });
  const frame = out.frames[0];
  check('超大图被压缩而不是丢弃', Boolean(frame) && frame.passThrough !== true, `${Math.round(png.length / 1024)}KB -> ${Math.round(frame.buffer.length / 1024)}KB`);
  check('输出在字节预算内', frame.buffer.length <= budget, `${frame.buffer.length} <= ${budget}`);
  check('长边受控', Math.max(frame.width, frame.height) <= 700, `${frame.width}x${frame.height}`);
  check('输出为 WebP', frame.mimeType === 'image/webp');
}

// 3) 动图抽帧：三帧 GIF 应按顺序抽出三张静态图。
{
  const mk = (r, g, b) => sharp({
    create: { width: 96, height: 96, channels: 3, background: { r, g, b } }
  }).png().toBuffer();
  const frames = await Promise.all([mk(255, 0, 0), mk(0, 255, 0), mk(0, 0, 255)]);
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const out = await prepareImage(gif, { animatedFrames: 6, frameLongEdge: 96, frameBytes: 100 * 1024 });
  check('动图识别为多帧', out.animated === true && out.pages === 3);
  check('抽帧数量正确', out.frames.length === 3, `${out.frames.length}`);
  check('抽出的都是 WebP', out.frames.every((f) => f.mimeType === 'image/webp'));
  const colors = [];
  for (const frame of out.frames) {
    const raw = await sharp(frame.buffer).raw().toBuffer();
    colors.push([raw[0], raw[1], raw[2]]);
  }
  check('帧顺序正确', colors[0][0] > 200 && colors[1][1] > 200 && colors[2][2] > 200, JSON.stringify(colors));
}

// 4) 均匀抽帧：10 帧抽 4 帧时包含首帧和末帧。
{
  const frames = [];
  for (let i = 0; i < 10; i += 1) {
    frames.push(await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: i * 20, g: i * 10, b: 255 - i * 20 } }
    }).png().toBuffer());
  }
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const out = await prepareImage(gif, { animatedFrames: 4, frameLongEdge: 32, frameBytes: 50 * 1024 });
  const pages = out.frames.map((f) => f.page);
  check('抽帧数量受上限约束', out.frames.length === 4, pages.join(','));
  check('首尾均匀采样', pages[0] === 0 && pages.at(-1) === 9, pages.join(','));
}

// 5) 桥接接线：fetchMediaData 会把动图拆成多条带序号的图片条目。
{
  const mk = (r, g, b) => sharp({
    create: { width: 64, height: 64, channels: 3, background: { r, g, b } }
  }).png().toBuffer();
  const frames = await Promise.all([mk(255, 0, 0), mk(0, 255, 0), mk(0, 0, 255)]);
  const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
  const h = await bridgeHarness({
    config: { dsh: { provider: 'deepseek-account', model: 'deepseek-flash', vision: 'auto' } },
    globals: {
      hasImageCodec,
      prepareImage,
      safeFetchBuffer: async () => ({ buffer: gif, mimeType: 'image/gif' })
    }
  });
  try {
    const entries = await h.fetchMediaData([{ kind: 'image', url: 'https://example.invalid/a.gif' }]);
    check('桥接把动图拆成多条图片', entries.length === 3, `${entries.length}`);
    check('帧带顺序标注', entries.every((e, i) => String(e.text).includes(`第${i + 1}/3帧`)), JSON.stringify(entries.map((e) => e.text)));
    check('帧都是 WebP', entries.every((e) => e.mimeType === 'image/webp'));
  } finally {
    await h.close();
  }
}

console.log(`\n结果：${passed} 通过，0 失败`);