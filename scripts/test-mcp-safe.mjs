// 测试安全版 QQ MCP server：工具清单 + 白名单发送校验
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
function currentMode() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'mode.json'), 'utf8')).mode;
  } catch {
    return 'chat';
  }
}
const MODE = currentMode();
const RESERVED2 = MODE === 'reserved2';

const entry = fileURLToPath(new URL('../src/mcp-snowluma-safe.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

try {
  await client.connect(transport);
  console.log('✅ 安全 MCP 连接成功');
  const tools = await client.listTools();
  console.log('工具:', tools.tools.map((t) => t.name).join(', '));

  const names = tools.tools.map((t) => t.name);
  const removed = ['qq_status','qq_reply','qq_send_group_message','qq_send_private_message','qq_send_burst','qq_social_state','qq_get_my_recent_messages','qq_search_meme_packs','qq_download_meme_pack','qq_memory_clear','qq_slang_submit','qq_get_self_image','qq_cross_group_query','qq_get_group_members'];
  for (const name of removed) {
    if (names.includes(name)) throw new Error(`已移除的工具仍暴露给模型: ${name}`);
  }
  for (const name of ['qq_send_message','qq_get_prompt','qq_get_unread_messages','qq_wait_for_messages','qq_search_memes']) {
    if (!names.includes(name)) throw new Error(`核心工具缺失: ${name}`);
  }
  console.log('✅ 核心工具存在，旧/管理工具已移除');

  const sendTool = tools.tools.find((t) => t.name === 'qq_send_message');
  const schemaText = JSON.stringify(sendTool?.inputSchema ?? {});
  console.log('✅ replyToMessageId 参数:', schemaText.includes('replyToMessageId') ? '存在 ✓' : '缺失 ✗');

  const denied = await client.callTool({ name: 'qq_send_message', arguments: { key: 'group:100003', messages: '测试', token: 'fixture' } });
  console.log('🚫 白名单外发送结果:', denied.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', denied.content?.[0]?.text?.slice(0, 120));

  const invalidReply = await client.callTool({ name: 'qq_send_message', arguments: { key: 'group:123456789', messages: '测试', token: 'fixture', replyToMessageId: 'abc' } });
  console.log('🚫 非法引用 id(abc) 结果:', invalidReply.isError ? '被拒绝 ✓' : '⚠️ 未被拒绝（异常！）', invalidReply.content?.[0]?.text?.slice(0, 120));

  process.exit(0);
} catch (error) {
  console.error('❌ 测试失败:', error?.message ?? error);
  process.exit(1);
}
