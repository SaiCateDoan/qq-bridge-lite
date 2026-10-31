# QQ ↔ DeepSeek Harness 桥接（轻量版）

把 QQ 好友/群消息接进 DeepSeek Harness，让 agent 在 QQ 里按会话自主收发、记忆、发表情和语音。
这是一个**个人自用、长期维护的轻量分支**：只保留 `reserved2` 二代仿真一条运行链路，不追求与任何上游版本一一对应。

## 两个上游

本仓库参考并合并了以下两个上游中适合本分支的内容，**不绑定其中任何一个具体版本**：

- [h-D-ACE/dsh-qq](https://github.com/h-D-ACE/dsh-qq)
- [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)

来源、MIT 授权与第三方边界见 [NOTICE.md](NOTICE.md) 和 [LICENSE](LICENSE)。本项目与两个上游的作者、DeepSeek、SnowLuma、腾讯均无隶属关系。

## 本分支的改良

以下功能是这条分支自己写或重写的；这里只描述做了什么，不展开到具体提交或代码文件。

### 收敛成单链路

- 删除 chat / closed-agent / 一代仿真，只保留 `reserved2` 二代仿真。
- 删除角色卡、L1~L3 管理面、审批/TOTP、模式切换等不再维护的分支。
- 把散落的提示词收敛为一套 `qq-chat-v2`：人设交给 DSH 全局提示词，桥接只负责 QQ 场景规则。
- 清掉旧社交状态机、自动转发等死代码，后续只在这条链路上加功能。

### 图片与动图处理

- 超大图不再直接丢弃，按 WebP 自适应压缩后再交给模型。
- 动图均匀抽帧，默认拼成 3×2 网格；可配置多帧，并统一单图/单条的下载、解码和体积预算。
- 补充时间感知、依赖告警清理等运行时改进。

### 三套表情链路

- 支持三套后端：AstrBot 本地图库/远程包（默认）、QQ 收藏、DSH dsh-meme，一次只启用一套。
- AstrBot 侧支持包级检索、manifest/目录解析、逐图语义、异步下载、封面和下载进度。
- 只注册当前链路的 MCP 工具，接口侧也做校验；三套图库的数据互不导入。
- 控制台可切换链路、管理 AstrBot 图库；远程包封面由桥接取回并内嵌，避开浏览器跨域/CSP 限制，同时做并发与缓存。

### 本地 GPT-SoVITS 语音

- AI 多了一个「把文字说成 QQ 语音条」的工具 `qq_speak`，不再只能发语音库里的旧音频。
- 打通本地 GPT-SoVITS 的合成、WAV 校验、临时文件、发送、限流、审计和落地回读。
- 控制台可配置参考音频/参考原话/语言/语速/字数/超时，并可试听；试听不会发到 QQ。
- 默认对合成结果做响度归一，避免模型原始音量过轻。

### 文档与运维

- 重整 README、配置说明和 SnowLuma 排障说明，明确 3099 控制中心与 3100 桥接控制台的分工。
- 补充 SnowLuma 只开 WebUI、没有 3000/3001 时的排查方法（QQ 进程注入/自动加载）。

## 从上游继承 / 合并的能力

这些能力来自两个上游或既有增强版的实现，本分支主要做适配、维护和修 bug，不把它们算作本分支从零实现：

| 能力 | 说明 |
| --- | --- |
| 桥接基础链路 | OneBot v11 客户端、QQ 消息与 DSH 会话映射、发送队列、白名单/会话令牌/审计、引用与合并转发读取 |
| `reserved2` 仿真骨架 | 工具自主收发、等待与潜水、唤醒条件、回复检查、拍一拍、群聊记忆的原始实现 |
| 人物与群记忆 | 按 QQ 号认人、群内/私聊/全局分层记忆、入群感知、群规、owner 私聊托付 |
| 提示词与 DSH 接入 | `qq-chat-v2` 原始提示词内容、preset bundle、DSH 协议适配、模型/思考强度选择、token/花费看板 |
| 控制中心与接口平台 | `3099` 控制中心、`interface-platform/` 统一接入层、SnowLuma/NapCat 生命周期、更新助手、NapCat 二维码 |
| 语音库 | `qq_send_voice` / `qq_list_voices`、音频探测与本地音量处理、独立 `../voice-tool/` |
| 上游修复合并 | 按需合入两个上游的修复（DSH 适配、接口平台健康检查等），具体见 [CHANGELOG.md](CHANGELOG.md) |

## 两个端口

| 端口 | 用途 |
| --- | --- |
| **3099** | **控制中心**：启动/停止桥接、绑定并启动 SnowLuma/NapCat、启动/配置本地 TTS、接口平台、版本与日志 |
| **3100** | **桥接控制台**：QQ 提示词、工具开关、表情图库、语音/TTS、会话与安全等桥接内部设置 |

**3100 没有“绑定/启动 SnowLuma”的入口是正常的，那个入口在 3099 的控制中心。**

启动控制中心（Windows 任选其一）：

```text
control-center.bat           # 带命令行窗口，关掉即退出控制中心及其子进程
control-center-hidden.vbs    # 无窗口
npm run control-center
```

macOS 双击 `control-center.command`；Linux 用 `npm run control-center` 或 systemd 服务。
页面：`http://127.0.0.1:3099/`，令牌在 `state/control-center-token`；自动打开时地址会带 `#t=...`。
控制中心只监听本机，启动它**不会**自动启动 SnowLuma 或桥接。

## 绑定并启动 SnowLuma

在控制中心：

1. 打开 **接口平台 → 概览**。
2. 找到 **接入实例 → 本机 SnowLuma 程序**，点「浏览…」，选中你的 SnowLuma 目录（含 `launcher.bat` / `index.mjs` 的那一层），或粘贴路径后点「使用这个目录」。
3. 点 **开启 SnowLuma**；第一次在它的 WebUI 里扫码登录机器人 QQ，并开启 OneBot WebSocket/HTTP。
4. 回到 **接口平台 → 设置**，点 **接入桥接**。
5. 切到 **桥接** 标签，点 **启动桥接**。
6. 底部状态栏全部正常：接口平台「1 账号就绪 · 桥接已接入」、QQ「在线」、DSH「已就绪」。

之后日常只需要打开控制中心 → 开启后端 → 启动桥接。不要在控制中心和 `start.bat` 同时启动桥接（桥接是单实例）。

> 如果 SnowLuma 只有 WebUI（5099）在监听、没有 3000/3001：说明 QQ 进程还没被注入。把 `SnowLuma\config\runtime.json` 的 `hookAutoLoad` 设为 `true` 并重启 SnowLuma；或在 SnowLuma WebUI 里手动加载 QQ 进程。日志出现 `[Hook] login detected` 与 `[OneBot.HTTP]/[OneBot.WS-Server] listening` 才算后端就绪。

## 快速开始

要求：Node.js ≥ 22.13、可用的 DSH、自己安装并能登录的 QQ 后端（SnowLuma 或 NapCat）。本项目不下载、不安装 QQ 后端。

```powershell
npm ci
Copy-Item config.example.json config.json
# 编辑 config.json：ownerQQ、allow.groups / allow.private、dsh.provider 等
node scripts/setup-dsh.mjs
# 重启 DSH
```

然后按上面的「两个端口」启动控制中心，完成 SnowLuma 绑定和桥接启动。

- 配置字段：[docs/guides/CONFIGURATION.md](docs/guides/CONFIGURATION.md)
- 控制中心：[docs/guides/CONTROL_CENTER.md](docs/guides/CONTROL_CENTER.md)
- DSH 部署：[docs/DSH_DEPLOYMENT.md](docs/DSH_DEPLOYMENT.md)
- 文档索引：[docs/README.md](docs/README.md)
- 目录约定：[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)

## 语音

**AI 发语音默认关闭**（`socialV2.voice.enabled` 与 `tools.sendVoice` 默认 `false`）：先把音频放进 `audio/`，再到控制台打开开关。
独立发语音工具在仓库上一级 `../voice-tool/`：`node voice-cli.mjs` / `node voice-gui.mjs`，也可以双击工作区的「发语音-图形界面.cmd」。

本地 GPT-SoVITS 在控制中心 **3099 的「本地 TTS」标签** 配置并启停；AI 用 `qq_speak` 合成并发送语音条，和语音库是两套。详细说明见 [docs/guides/VOICE.md](docs/guides/VOICE.md)。

## 测试

```powershell
npm run test:audit
```

当前离线回归为 **58 个脚本**。`test-platform` 偶发超时，单独重跑即可。

## 安全与边界

- 只把 QQ 消息发给配置的模型提供方；不要把 `state/`、令牌、SnowLuma 数据目录提交到仓库。
- QQ 群友消息属于不可信输入；工具调用仍受白名单、会话令牌、发送限流和审计约束。
- SnowLuma 是第三方非官方 QQ 协议实现，使用风险由你自行承担；本项目不包含、不下载、不启动它的程序文件。
- 具体权限边界见 [RULES.md](RULES.md)，来源与第三方许可见 [NOTICE.md](NOTICE.md)。
