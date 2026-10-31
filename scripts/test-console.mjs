// 控制台综合测试（node 直接调 API；需要桥接已在 3100 运行）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:3100';

function readConsoleToken() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg.consoleToken) return String(cfg.consoleToken);
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}
const TOKEN = readConsoleToken();
const authHeaders = TOKEN ? { 'x-console-token': TOKEN } : {};
const api = async (p, method, body) => {
  const headers = { ...authHeaders, ...(body ? { 'content-type': 'application/json' } : {}) };
  const res = await fetch(BASE + p, { method: method || 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) failed += 1;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

// 1. 页面
const page = await fetch(BASE + '/', { headers: authHeaders });
const html = await page.text();
ok('页面加载', page.status === 200 && html.includes('白名单 / 管理员') && html.includes('QQ 提示词') && html.includes('测试发送'), `长度 ${html.length}`);
ok('dsh-meme 联动页', html.includes('id="dshMemeStatus"') && html.includes('id="dshMemePanelLink"') && html.includes('data-v2-tool="dshMemeSearch"'), '状态/面板/工具开关');
ok('表情链路选择器', html.includes('id="v2MemeBackend"') && html.includes('data-meme-backend="astrbot"') && html.includes('data-meme-backend="qq"'), '三套链路');
ok('AstrBot 图库页', html.includes('id="section-memes"') && html.includes('data-page="memes"'), '本地图库/远程包');

// 2. QQ 提示词（唯一一套）
let r = await api('/api/memes/stats');
ok('AstrBot 图库统计接口', r.body.ok === true || r.body.enabled === false, JSON.stringify({ ok: r.body.ok, error: r.body.error }));
r = await api('/api/dsh-meme/status');
ok('dsh-meme 状态接口', r.body.ok === true && typeof r.body.total === 'number', JSON.stringify({ ok: r.body.ok, total: r.body.total, error: r.body.error }));
r = await api('/api/preset/sim-prompt');
ok('提示词读取', r.body.ok === true && typeof r.body.content === 'string' && r.body.content.length > 500, `共 ${r.body.chars} 字符`);
ok('提示词状态是 qq-chat-v2', r.body.status?.preset === 'qq-chat-v2', JSON.stringify(r.body.status));
ok('提示词默认快照可用', typeof r.body.defaultContent === 'string' && r.body.defaultContent.length > 500);

// 原样保存应返回 unchanged，不写文件
r = await api('/api/preset/sim-prompt', 'POST', { content: r.body.content });
ok('原样保存不写文件', r.body.ok === true && r.body.unchanged === true, JSON.stringify(r.body));

// 3. 会话映射
r = await api('/api/sessions');
ok('会话映射', Array.isArray(r.body.sessions), `共 ${r.body.sessions.length} 个`);

// 4. 白名单：读原值 → 加测试群 → 恢复
const sameIds = (a, b) => JSON.stringify((a || []).map(String).sort()) === JSON.stringify((b || []).map(String).sort());
r = await api('/api/whitelist');
const origAllow = r.body.allow;
ok('白名单读取', origAllow && Array.isArray(origAllow.groups), JSON.stringify(origAllow));
const testGroups = [...new Set([...(origAllow.groups || []), 123456789])];
r = await api('/api/whitelist', 'POST', { allow: { private: origAllow.private || [], groups: testGroups }, deny: { private: [], groups: [] } });
ok('白名单写入（含测试群）', r.body.ok === true && (r.body.allow.groups || []).map(String).includes('123456789'), JSON.stringify(r.body.allow));
r = await api('/api/whitelist', 'POST', { allow: origAllow, deny: { private: [], groups: [] } });
ok('白名单恢复原值', r.body.ok === true && sameIds(r.body.allow.groups, origAllow.groups) && sameIds(r.body.allow.private, origAllow.private), JSON.stringify(r.body.allow));

// 5. 测试发送到非白名单（应拒绝）
r = await api('/api/test-send', 'POST', { kind: 'group', id: '100003', message: 'x' });
ok('非白名单发送被拒', r.body.ok === false && r.status === 403, JSON.stringify(r.body));

if (failed > 0) {
  console.log(`\n❌ ${failed} 项失败`);
  process.exit(1);
}
console.log('\n🎉 测试完成');
