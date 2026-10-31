# 配置说明（v0.3.0 新增字段）

原版字段（`dsh.*`、`snowluma.*`、`allow/deny`、`social*`、`slang` 等）的说明见 [../../README.md](../../README.md)「安装与配置」，含义未变。
本文只列 v0.3.0 新增的三段与新增的工具开关。所有字段都可省略，省略即取下表默认值；**默认值都是安全的**。
修改 `config.json` 后需要重启桥接；修改 `socialV2.tools.*` 还需要重启 DSH（MCP 工具清单在 DSH 启动时读取）。

## `continuity` —— 人际连续性

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后不记录人物、不处理成员事件、不注入【在场人物】 |
| `sharePolicy` | `"identity"` | `none` / `identity` / `shared`，见 [CONTINUITY.md](CONTINUITY.md) §4；非法值按 identity 处理 |
| `injectPeople` | `true` | 是否在二代唤醒提示词里注入【在场人物】 |
| `injectMaxPeople` | `8` | 每次最多注入几个人 |
| `injectMaxChars` | `1500` | 【在场人物】小节的字数上限（成本护栏） |
| `reconcileOnConnect` | `true` | 连上 SnowLuma 后拉成员名单对账（首次部署建档 / 补记漏掉的入退群） |
| `joinEvents.wake` | `true` | 入群事件是否唤醒二代会话 |
| `joinEvents.wakeOn` | `["stranger","knownElsewhere","returning"]` | 哪些入群分类会唤醒 |
| `leaveEvents.wake` | `false` | 退群事件是否唤醒 |
| `dedupeWindowMs` | `600000` | 入/退群事件去重窗口 |
| `pruneListedAfterDays` | `0`（关） | 保留策略：删除这么多天未出现、无记忆、未被管理员设定的 `listed` 记录 |
| `groups.<群号>.label` | `""` | 群标签。在 `identity`/`shared` 策略下，别的群里会显示「也在『标签』见过」；不设则只显示「另外 N 个群」 |
| `groups.<群号>.sharePolicy` | 继承 | 只能比全局更严 |
| `groups.<群号>.recordable` | `true` | `false`：该群不写人物库、不被其它群看见、AI 不能在该群记人 |

> `config.example.json` 里的 `groups` 用的是**示例群号 10001 / 20002**，部署时请删除或改成真实群号。

## `admin`（已移除）

桥接只保留 `reserved2` 二代仿真一条运行链路，模式切换 / 权限分级（L1~L3）/ 审批 / TOTP 管理通道已整体删除；`config.json` 里残留的 `admin`、`social`、`role` 段会被忽略，可以手工删掉。

## `crossGroup` —— 跨群受控查询

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 总开关 |
| `links` | `[]` | 有向链接：`{ "from": "<群号>", "to": "<群号>", "allow": ["presence", "activity"] }`。模板里的链接是示例 |

## `socialV2.tools` 新增开关（默认都是 `true`）

| 开关 | 工具 | 说明 |
| --- | --- | --- |
| `personProfile` | `qq_get_person` / `qq_note_person` | 按 QQ 号查看/记录人物（按可见范围过滤；只能写当前会话作用域） |
| `requestMode` | `qq_request_mode_change` | 只在 owner 私聊会话里登记申请；不能执行、不能确认 |
| `crossGroup` | `qq_cross_group_query` | 还需要 `crossGroup.enabled` 与链接授权 |

## 管理员私聊托付群会话（v0.4.2，默认关闭）

每个 QQ 会话（群、私聊）在 DSH 里是独立的 AI 会话，会话令牌只能发到自己的会话。所以你在私聊里说「去 X 群说两句」，
私聊里的 AI 发不出去（以前会回答「令牌不对」）。打开这个工具后，私聊里的 AI 可以把这件事**托付**给 X 群**自己的**会话：
桥接把托付交过去并唤醒它，由群会话看着群里的上下文自己组织语言、用自己的令牌发言。会话之间的隔离不变。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `socialV2.tools.ownerRelay` | `false` | 开关，对应工具 `qq_ask_group_session`。必须显式设为 `true`；改动后重启 DSH 才会出现在工具列表里 |
| `socialV2.ownerRelay.maxPerHour` | `10` | 每小时最多托付次数（全部群合计） |
| `socialV2.ownerRelay.maxPerTargetPerHour` | `5` | 同一个群每小时最多托付次数 |
| `socialV2.ownerRelay.maxChars` | `300` | 托付内容最长字数 |
| `socialV2.ownerRelay.ttlMs` | `1800000` | 托付等待群会话处理的最长时间（30 分钟），过期丢弃 |
| `socialV2.ownerRelay.notifyOwner` | `true` | 每次托付后桥接私聊告诉你转交了什么 |

限制：只在二代仿真（reserved2）下可用；只有你本人私聊（`private:<ownerQQ>`）的会话能托付；目标只能是白名单里的群；
目标群开着静默模式时拒绝；托付内容会过敏感信息过滤，只保存在内存里（不落盘）；每次托付或被拒都记入管理审计（`/audit`）。
群会话按群里的情况决定怎么说；明显不合适的托付（比如会泄露私聊内容）它可以不做。

## 管理员私聊跨群查看与群长期规则（默认关闭）

会话之间默认互相隔离：私聊里的 AI 看不到群里的消息，它记下的东西也只存在私聊会话自己的记忆里，所以你在私聊里说「群里以后要这样」，群里的 AI 是看不到的。打开这个开关后，**只有你本人的私聊**会话多两个工具：

| 工具 | 作用 |
| --- | --- |
| `qq_owner_peek_group` | 只读查看某个白名单群最近的消息（≤50 条）、该群会话的记忆摘要和长期规则。不会标记那个群的已读，也不能在那个群发言 |
| `qq_owner_group_rule` | 给白名单群增删「长期规则」（每群 ≤10 条，每条 ≤200 字）。规则由**桥接**写进那个群会话的记忆，之后每次唤醒都注入【管理员为本群设定的长期规则】；群会话自己的记忆工具改不动、清不掉 |

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `socialV2.tools.ownerGroupAccess` | `false` | 开关。必须显式设为 `true`；改动后重启桥接，并重启 DSH 才会出现在工具列表里 |

不变的边界：在群里说话仍然只能走托付（`qq_ask_group_session`），私聊的令牌依旧不能直接往群里发；规则只用于说话习惯，不能改模式、权限或安全设置（那些只能用管理通道命令）；查看与增删规则都记入管理审计，增删规则会私聊通知你。

## `socialV2.sticker.maxBytes` —— 表情单张大小上限（默认 `10485760`，即 10MB）

AI **收藏**群友的表情、**发送**收藏表情时，桥接会先自己下载并校验图片（DNS 固定、逐跳校验、限制大小），再以 base64 交给网关；超过这个上限就拒绝。

- 取值范围 256KB ～ 40MB，超出按边界处理，非法值回到 10MB。上界是给传输留的余量：base64 会膨胀约 1/3，40MB 编码后约 54MB，仍在接口平台单条消息 64MB 的上限内。
- **不影响图片识别**：把聊天图片 / 表情图交给模型看（含 `qq_get_sticker_image`）用的是另一个配置 `socialV2.media.maxBytes`（上游 r4 引入，默认 8MB，范围 256KB～20MB；同组还有 `maxPixels` 默认 64MP、`maxCount` 默认 5 张）。
- 直连 SnowLuma（不经接口平台）时，SnowLuma 自身对单条消息的大小限制没有实测过；遇到发送失败可以先调小这个值。

## `socialV2.dshMeme` —— 与 DSH 的 dsh-meme 图库联动

qq-bridge 不自己维护表情图库，直接使用 DSH 插件 **dsh-meme** 的图库、开关和元数据。桥接通过 DSH Web 的 `/dsh-memes-api`（只回环）读取候选，再从 `/dsh-memes/<pack>/<path>` 取原图发给 QQ。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 联动开关；关闭后 3 个工具和状态接口都不可用 |
| `baseUrl` | 空 | 留空 = 用桥接已识别的 DSH 地址；一般不用填 |
| `maxBytes` | 10485760（10MB） | 单张图片发送上限（dsh-meme 自身入库上限是 8MB） |

AI 工具：

- `qq_search_memes(query?, tag?, limit?)`：按描述/关键词/情绪桶搜 dsh-meme 图库；返回候选 id、图库、caption、tag。
- `qq_send_meme(memeId, replyToMessageId?, atUserId?)`：把候选下载成字节，走原有 QQ 白名单/限流/发送队列；一条一张，不带文字。
- `qq_learn_meme(messageId, tag?, caption?, keywords?)`：把当前会话的图片上传到 dsh-meme 的「我的收藏」。

图库管理、启用哪些图库、发图尺寸等仍在 **DSH 设置 → 表情包**；qq-bridge 控制台「二代仿真」里会显示连接状态和「打开 dsh-meme 图库面板」。

## `socialV2.media` —— 图片压缩与动图抽帧（默认开启，需要 `sharp`）

聊天图片不再因为过大直接丢掉：桥接用 `sharp`（libvips）解码，静态图超限时按 Lanczos3 重采样并压成 WebP；动图会均匀抽帧成多张静态 WebP（含首帧/末帧），让模型能看到变化过程。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `maxBytes` | 8388608（8MB） | 单条消息所有图片/帧的总字节预算 |
| `maxModelBytes` | 1048576（1MB） | 交给 DSH/MCP 的**单张**图片上限。DSH 的 MCP 图片通道在 base64 ≥4,474,880 字符（原始约 3.2MB）时会压爆正则栈并丢图；默认 1MB，上界 3MB |
| `maxPixels` | 64000000 | 单张压缩后的像素上限 |
| `maxCount` | 5 | 单条消息最多处理几个媒体条目 |
| `maxDownloadBytes` | 25165824（24MB） | 压缩前允许下载的原图上限；超过才放弃 |
| `maxDecodePixels` | 100000000 | 解码安全上限（防图片炸弹），超过直接拒绝 |
| `maxLongEdge` | 1280 | 静态图长边上限（同时受像素上限约束） |
| `quality` | 82 | WebP 初始质量（55～95）；超预算会自适应下调 |
| `animatedFrames` | 6 | 动图最多抽几帧（首尾均匀采样） |
| `animatedLayout` | `collage` | `collage` = 拼成一张 3×2 网格（默认，省 token/admission）；`frames` = 返回多张独立帧 |
| `gifTile` | 240 | 拼图每格宽度（px），高按原图比例，单格高度封顶 480 |
| `frameLongEdge` | 1024 | 动图单帧长边上限（仅 `frames` 模式） |
| `frameBytes` | 1048576（1MB） | 动图单帧字节预算 |
| `maxImageParts` | 8 | 一条消息最多送给模型多少张图（含动图帧） |

- 静态图在限制内会原样透传，不做二次编码；只有超限才压缩。
- 动图默认拼成一张网格（`collage`，行优先），返回里会说明帧数/网格；`frames` 模式则按 `动图第 1/6 帧` 标注多张图。
- 没有安装 `sharp` 时会退回旧行为（超限跳过）并在日志里提示；`npm ci` 会一并安装。

## `socialV2.sticker.collect.tempDir` —— NapCat 收藏表情用的临时目录（默认留空）

只在网关是 NapCat 时用到：NapCat 的 `add_custom_face` 只接受本地文件路径，桥接会把已校验的表情字节写成一个随机名、权限 0600 的临时文件交给它，调用结束立即删除。
留空时：macOS 用 QQ 沙盒容器里的 `~/Library/Containers/com.tencent.qq/Data/tmp`（App Store 版 QQ 读不到系统临时目录），其它系统用系统临时目录。SnowLuma 不用这个目录。

## `dsh.provider` / `dsh.model` / `dsh.reasoningEffort` / `dsh.vision` —— 模型选择（v1.0.2 起可在控制台改）

推荐在桥接控制台「运行总览 → DSH 模型与思考强度」里选：提供方、模型、思考强度三个下拉联动，选项全部来自 DSH 的模型目录（`session.modelCatalog`），
保存后对已有会话的下一条消息生效，不用重启桥接。手改 `config.json` 也可以，重启桥接后生效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dsh.provider` | `deepseek-official` | 提供方。DSH 桌面版 0.2.1 起 DeepSeek 自家的提供方叫 `deepseek-account`。其它提供方是第三方：QQ 里的聊天内容会发给它们，控制台会提示隐私并在保存前再确认一次 |
| `dsh.model` | `deepseek-flash` | 模型 id（DeepSeek-V4.1-Flash，能看图） |
| `dsh.reasoningEffort` | `max` | 思考档位：`off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`，具体模型支持哪些以 DSH 目录为准；留空 = 用模型默认。`off` 是关闭思考，回复更快但工具调用和人格一致性可能变差。模型没有思考档位时自动不带这个参数 |
| `dsh.vision` | `auto` | 看图能力：`auto` = 只有核实过能看图的模型（目前是 DeepSeek 的 `deepseek-flash`）才把 QQ 图片交给它，其余模型把图片、表情改成文字占位（避免整条消息被拒）；`yes` / `no` = 手动指定 |

- 控制台保存时由服务端按目录硬校验：提供方 / 模型不在目录里、档位不在该模型的列表里都会拒绝；目录读不到时**不保存**（返回 503），聊天照常按原配置进行。
- 价格表（`src/model-prices.js`）只收录 DeepSeek 自家的价目；换到其它模型后，「令牌与花费」的金额按 DeepSeek-V4.1-Flash 估算并标「估算」。
- 只有控制台能改模型：AI 的令牌调不了这些接口，QQ 私聊管理通道也没有改模型的命令。
- 和思考强度一样，切换会同时写入 DSH 的全局默认（`~/.dsh/settings.yaml` 的 `agent-default-model`），Web GUI 里新建会话的默认模型也会跟着变。

## `dsh.baseUrl` —— DSH 地址（默认留空 = 自动识别）

留空时按顺序识别：桌面版固定端口 19387 / 命令行版 3080 → 都连不上时查 DSH 桌面版进程正在监听的回环端口（DSH 桌面版 0.2.1 起每次启动换随机端口），
并用未登录请求的 401 提示文字确认确实是 DSH。DSH 不可用期间桥接每 10 秒重新识别一次，DSH 重启换端口后会自动跟上。
显式填写时一律照用、不做发现（DSH 跑在别处或别的端口时才需要填）。

## `snowluma.viaPlatform` —— 经接口平台连接（默认 `false`）

为 `true` 时，`snowluma.wsUrl` / `httpUrl` / `accessToken` 指向接口平台（与桥接平行的 `interface-platform/`）的 OneBot 兼容入口，令牌是平台的数据令牌：

- token 自愈不再扫描 SnowLuma 目录（`homeDir` / `launcherPath` / `SNOWLUMA_HOME` 一律忽略），也不跟随发现到的端点 —— 否则会拿到 SnowLuma 的真实地址、绕过平台直连；
- 等同于强制 `followDiscoveredEndpoint: false`。

一般不用手改：在控制中心「接口平台 → 设置」点「接入桥接」，会写好这几个字段并把原值备份到 `state/platform-link-backup.json`，「恢复直连」可还原。「接入桥接」时数据令牌和地址由平台经管理接口交给控制中心，控制中心不读平台的文件，所以平台必须正在运行。详见同级目录的 `interface-platform/README.md`。

## 状态文件（`state/`，不入库）

| 文件 | 内容 |
| --- | --- |
| `state/social/people.json`（+ `backups/`） | 人物库 |
| `state/chat-mode.json`（可选） | 旧的静默/活跃开关；只保留兼容读取 |
