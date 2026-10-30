// 图片压缩 / 动图抽帧：sharp（libvips）+ WebP。
//
// 设计取舍（为什么不是“随手写个缩放”）：
// - 解码/缩放/编码全部交给 libvips（sharp），用 Lanczos3 重采样和 WebP 有损编码；
//   不再自己写双线性/最近邻，也不把 JPEG 再压成更差的 JPEG。
// - 输出格式固定 WebP：DSH 的图片白名单包含 image/webp，同质量下体积通常明显小于 JPEG，
//   且支持 alpha；不会因为“为了压小而换格式”被 DSH / 模型拒收。
// - 静态图在限制内原样透传，避免无意义的二次编码；只有超限才重编码。
// - 动图默认抽帧拼成一张 contact sheet（3×2，行优先）：模型侧（DSH 归一化）本来就会把动画压成
//   单帧，拼图才能让模型看到变化过程，同时只占一次图片 admission / 一份 token；也支持
//   animatedLayout='frames' 退回多张独立帧。抽帧数量、单格尺寸和字节数都有上限。
// - 自适应：先按目标质量编码；超预算就逐步降质量，再缩小尺寸，保留“能看清”的最低成本版本。

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  sharp = null;
}

export function hasImageCodec() {
  return Boolean(sharp);
}

const MIME_BY_FORMAT = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp'
});

const DEFAULTS = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxPixels: 64_000_000,
  maxLongEdge: 1280,
  quality: 82,
  animatedFrames: 6,
  animatedLayout: 'collage',
  tileWidth: 240,
  frameLongEdge: 1024,
  frameBytes: 1024 * 1024,
  maxDecodePixels: 100_000_000
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function normalizeOptions(options = {}) {
  return {
    maxBytes: clampInt(options.maxBytes, 64 * 1024, 20 * 1024 * 1024, DEFAULTS.maxBytes),
    maxPixels: clampInt(options.maxPixels, 1_000_000, 64_000_000, DEFAULTS.maxPixels),
    maxLongEdge: clampInt(options.maxLongEdge, 512, 2048, DEFAULTS.maxLongEdge),
    quality: clampInt(options.quality, 55, 95, DEFAULTS.quality),
    animatedFrames: clampInt(options.animatedFrames, 1, 10, DEFAULTS.animatedFrames),
    animatedLayout: options.animatedLayout === 'frames' ? 'frames' : 'collage',
    tileWidth: clampInt(options.tileWidth, 64, 400, DEFAULTS.tileWidth),
    frameLongEdge: clampInt(options.frameLongEdge, 512, 1600, DEFAULTS.frameLongEdge),
    frameBytes: clampInt(options.frameBytes, 128 * 1024, 4 * 1024 * 1024, DEFAULTS.frameBytes),
    maxDecodePixels: clampInt(options.maxDecodePixels, 64_000_000, 150_000_000, DEFAULTS.maxDecodePixels)
  };
}

/** 在不放大的前提下，把宽高收进「长边 + 总像素」两个上限。 */
function fitDimensions(width, height, maxLongEdge, maxPixels) {
  let scale = Math.min(1, maxLongEdge / Math.max(width, height));
  const pixels = width * height * scale * scale;
  if (pixels > maxPixels) scale *= Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

/** 均匀抽帧：包含首帧和末帧，避免只看到开头。 */
function sampleIndices(pages, count) {
  if (count >= pages) return Array.from({ length: pages }, (_, i) => i);
  if (count <= 1) return [0];
  const out = new Set();
  for (let i = 0; i < count; i += 1) {
    out.add(Math.round((i * (pages - 1)) / (count - 1)));
  }
  return [...out].sort((a, b) => a - b);
}

const LAYOUTS = Object.freeze({
  1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2],
  7: [4, 2], 8: [4, 2], 9: [3, 3], 10: [5, 2], 11: [4, 3], 12: [4, 3]
});

function layoutFor(count) {
  return LAYOUTS[count] ?? [Math.ceil(Math.sqrt(count)), Math.ceil(count / Math.ceil(Math.sqrt(count)))];
}

/**
 * 把抽出的帧拼成一张 contact sheet（行优先，左上→右下）。
 * 相比发 6 张独立图：只占一次图片 admission / 一份 token，信息密度更高。
 */
async function composeContactSheet(buffer, meta, opts, pages) {
  const [cols, rows] = layoutFor(pages.length);
  const margin = 4;
  const padding = 4;
  const cellW = opts.tileWidth;
  // 极端竖图不要把画布撑爆：单格高度封顶 480px，内容按 contain 居中。
  const cellH = Math.min(480, Math.max(1, Math.round((meta.height * cellW) / Math.max(1, meta.width))));
  const sheetW = margin * 2 + cols * cellW + (cols - 1) * padding;
  const sheetH = margin * 2 + rows * cellH + (rows - 1) * padding;
  const composites = [];

  for (let i = 0; i < pages.length; i += 1) {
    const { data, info } = await sharp(buffer, {
      page: pages[i],
      pages: 1,
      limitInputPixels: opts.maxDecodePixels
    })
      .rotate()
      .resize({ width: cellW, height: cellH, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
      .png()
      .toBuffer({ resolveWithObject: true });
    const col = i % cols;
    const row = Math.floor(i / cols);
    composites.push({
      input: data,
      left: margin + col * (cellW + padding) + Math.floor((cellW - info.width) / 2),
      top: margin + row * (cellH + padding) + Math.floor((cellH - info.height) / 2)
    });
  }

  let quality = opts.quality;
  let smallest = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const out = await sharp({
      create: { width: sheetW, height: sheetH, channels: 3, background: { r: 255, g: 255, b: 255 } }
    })
      .composite(composites)
      .webp({ quality, effort: 4, smartSubsample: true })
      .toBuffer();
    if (!smallest || out.length < smallest.buffer.length) smallest = { buffer: out, quality };
    if (out.length <= opts.maxBytes) {
      smallest = { buffer: out, quality };
      break;
    }
    if (quality <= 55) break;
    quality = Math.max(55, quality - 8);
  }

  const durationMs = (meta.delay || []).reduce((sum, ms) => sum + (Number.isFinite(Number(ms)) ? Number(ms) : 0), 0);
  const duration = durationMs > 0 ? `/${(durationMs / 1000).toFixed(1)}s` : '';
  return {
    buffer: smallest.buffer,
    mimeType: 'image/webp',
    width: sheetW,
    height: sheetH,
    quality: smallest.quality,
    note: `动图 ${meta.pages} 帧${duration}，已抽 ${pages.length} 帧拼成 ${cols}×${rows} 网格（行优先，左上→右下）`
  };
}

async function probe(buffer, opts) {
  const meta = await sharp(buffer, { limitInputPixels: opts.maxDecodePixels }).metadata();
  return {
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    pages: Math.max(1, Number(meta.pages) || 1),
    format: String(meta.format || ''),
    delay: Array.isArray(meta.delay) ? meta.delay : []
  };
}

async function encodeStill(buffer, meta, opts, { page, maxBytes, maxLongEdge }) {
  let dims = fitDimensions(meta.width, meta.height, maxLongEdge, opts.maxPixels);
  let quality = opts.quality;
  let smallest = null;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const out = await sharp(buffer, {
      page,
      pages: 1,
      limitInputPixels: opts.maxDecodePixels
    })
      .rotate()
      .resize({
        width: dims.width,
        height: dims.height,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: 'lanczos3'
      })
      .webp({ quality, effort: 4, smartSubsample: true })
      .toBuffer();

    const candidate = {
      buffer: out,
      mimeType: 'image/webp',
      width: dims.width,
      height: dims.height,
      quality
    };
    if (!smallest || out.length < smallest.buffer.length) smallest = candidate;
    if (out.length <= maxBytes) return candidate;

    if (quality > 55) {
      quality = Math.max(55, quality - 8);
    } else {
      const width = Math.round(dims.width * 0.82);
      const height = Math.round(dims.height * 0.82);
      if (Math.min(width, height) < 320) break;
      dims = { width, height };
    }
  }

  return smallest;
}

/**
 * 把一张原始图片准备成适合给模型看的帧列表。
 * 未超限的静态图会原样返回（passThrough），动图则抽成多张 WebP。
 *
 * @returns {Promise<null | {
 *   animated: boolean, pages: number,
 *   frames: Array<{buffer: Buffer, mimeType: string, width: number, height: number,
 *     page: number, quality?: number, passThrough?: boolean,
 *     index?: number, total?: number, delay?: number | null}>
 * }>}
 */
export async function prepareImage(buffer, options = {}) {
  if (!sharp || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const opts = normalizeOptions(options);
  const meta = await probe(buffer, opts);
  if (!meta.width || !meta.height) return null;

  const formatMime = MIME_BY_FORMAT[meta.format];
  if (meta.pages === 1) {
    const withinLimits = Boolean(formatMime)
      && buffer.length <= opts.maxBytes
      && meta.width * meta.height <= opts.maxPixels
      && Math.max(meta.width, meta.height) <= opts.maxLongEdge;
    if (withinLimits) {
      return {
        animated: false,
        pages: 1,
        frames: [{
          buffer,
          mimeType: formatMime,
          width: meta.width,
          height: meta.height,
          page: 0,
          passThrough: true
        }]
      };
    }
    const still = await encodeStill(buffer, meta, opts, {
      page: 0,
      maxBytes: opts.maxBytes,
      maxLongEdge: opts.maxLongEdge
    });
    return { animated: false, pages: 1, frames: [still] };
  }

  const count = Math.min(opts.animatedFrames, meta.pages);
  const pages = sampleIndices(meta.pages, count);

  // 默认拼图：一帧一张图在 MCP 里是多次 admission / 多份 token；拼成一张信息密度更高。
  // 拼图失败时退回多帧，至少不让模型失明。
  if (opts.animatedLayout === 'collage') {
    try {
      const sheet = await composeContactSheet(buffer, meta, opts, pages);
      return {
        animated: true,
        pages: meta.pages,
        collage: true,
        note: sheet.note,
        frames: [{
          buffer: sheet.buffer,
          mimeType: sheet.mimeType,
          width: sheet.width,
          height: sheet.height,
          page: 0,
          index: 1,
          total: 1,
          collage: true,
          quality: sheet.quality
        }]
      };
    } catch {
      // fall through to multi-frame extraction
    }
  }

  const frames = [];
  for (const page of pages) {
    const still = await encodeStill(buffer, meta, opts, {
      page,
      maxBytes: opts.frameBytes,
      maxLongEdge: opts.frameLongEdge
    });
    frames.push({
      ...still,
      page,
      delay: meta.delay[page] ?? null,
      index: frames.length + 1,
      total: pages.length
    });
  }
  return { animated: true, pages: meta.pages, frames };
}
