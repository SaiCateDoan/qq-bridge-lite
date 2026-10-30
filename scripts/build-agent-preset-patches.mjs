#!/usr/bin/env node
// build-agent-preset-patches.mjs — 兼容入口：真正的转换器在 src/preset-patches.js。
//
// 用法：
//   node scripts/build-agent-preset-patches.mjs           # 生成/刷新 patch 文件
//   node scripts/build-agent-preset-patches.mjs --check    # 只校验产物与源一致（不一致 exit 1）
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_DIR, GUARD_SPECIFIER, PRESETS, RELATIVE_ROW_REWRITES, REPO_ROOT,
  buildPatches, patchFileFor, presetRowId, renderPatch,
} from '../src/preset-patches.js';

export {
  BUNDLE_DIR, GUARD_SPECIFIER, PRESETS, RELATIVE_ROW_REWRITES, REPO_ROOT,
  buildPatches, patchFileFor, presetRowId, renderPatch,
};

// 直接执行时：默认生成，--check 只校验。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const results = buildPatches({ check, log: (line) => console.log(`[preset-patches] ${line}`) });
  const stale = results.filter((r) => r.changed);
  if (check && stale.length > 0) {
    console.error(`[preset-patches] ERROR: ${stale.length} 个 patch 文件与源不一致；请运行 node scripts/build-agent-preset-patches.mjs`);
    process.exit(1);
  }
  console.log('[preset-patches] Done');
}
