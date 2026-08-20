# Multi-Agent Office

一个参考 Cat Café / Clowder AI 协作方式的本地对等多 Agent 工作台。平台没有 Boss Agent，也没有固定角色；每个 Agent 都能独立接单、拒绝、向用户提问，或通过结构化 `post_message` 把任务交给队友。

Agent 交付的成果要由**另一个** Agent 把关后才算完成：自称做完了不等于做完了，声称可行的方案也要有人挑毛病。审核者是同侪而不是上级，由谁审核在运行时动态决定，不是花名册里写死的角色。是否需要审核由 Agent 自己判断——闲聊和提问不走审核，交付物才走。

## 默认团队

首次启动会原子创建 `.data/agents.json`：

- `@codex`：使用本机 Codex CLI 和 `workspace-write` 沙箱。
- `@pi`：使用 `MAO_PI_*` 模型配置，默认 `full`，开放 Bash/edit/write。

两者是对等协作者。桌面安装版首次使用 `@pi` 作为默认 Agent，并允许在首次启动页停用 `@codex`；源码启动可通过 `MAO_DEFAULT_AGENT=pi|codex` 选择。Web 的 Agent 花名册可以新增任意数量的 Pi/Codex Agent，编辑模型、身份、system prompt、能力和访问级别，停用 Agent，并切换默认 Agent。handle 保存后不可改；密钥不写入花名册或 API 响应，只写入本地 `config.env`，或直接从环境变量读取。

## 多个 Pi Agent

不接入 Codex 时，团队可以完全由 Pi Agent 组成，每个 Agent 用不同的 provider——例如一个走 DeepSeek、一个走 GLM。每个 Pi Agent 各自解析自己的 provider/model、各自判定凭据是否就绪、各自持有 session 绑定和 session 目录，互不干扰；审核时平台会自动挑选另一个在线 Agent，两个 Pi Agent 可以互审。

- **配置凭据**：花名册里选中一个 Pi Agent，在 provider 下方直接填写该 provider 的 API Key。密钥按 provider 分别保存，不会覆盖其他 provider，也不会改变已有 Agent 指向的 provider。保存后立即生效，无需重启；有 Agent 正在运行或排队时会拒绝保存，以免中断本轮对话。
- **前端区分**：头像颜色由 handle 哈希得出，首字母取每个连字符段的首字符（`pi-deepseek` → `PD`，`pi-glm` → `PG`），消息头的运行时标签为 `Pi · provider · model`，因此同模型不同 provider 的两个 Agent 也能分辨。
- **并发**：只读 Agent 可并行（上限 `MAO_MAX_PARALLEL_READ_RUNS`），同一工作目录内的写运行仍然串行，与 provider 无关。
- **选择模型**：provider 和 model 都是下拉列表，直接列出 pi 认识的全部提供商（按「自定义 / 已配置凭据 / 未配置凭据」分组）和该提供商的模型；两个下拉都保留「手动输入」，因此写在 pi 自己 `models.json` 里的 provider 依然可用。
- 换 provider 时，如果原来的模型在新 provider 上不存在，会自动切到该 provider 的第一个模型，而不是留下一个解析不出模型的 Agent。

## 模型提供商与第三方部署

内置提供商共 35 个，覆盖 Z.AI、DeepSeek、Kimi、通义千问、MiniMax、小米 MiMo、百灵、OpenAI、Anthropic、Gemini、xAI、OpenRouter、Vercel AI Gateway、Mistral、Groq、Cerebras、Together、Fireworks、Baseten、NVIDIA、Hugging Face、OpenCode、Azure OpenAI、Bedrock、Vertex 等。首次启动页先显示常用的几个，点「更多提供商」展开全部；花名册里则可以为其中任何一个直接填 API Key，密钥按提供商各写一份到本机配置文件，互不覆盖。

公司网关、代理和自建部署（vLLM、Ollama、LM Studio 等 OpenAI 兼容服务）不需要再手改 pi 的 `models.json`：在花名册里选中一个 Pi Agent，展开「自定义 / 第三方部署的模型」，填写名称、provider id、Base URL、API 类型和模型名即可。

- 定义保存在 `.data/custom-providers.json`，保存后立即注册到 pi 的模型运行时，无需重启；密钥仍然单独存放（环境变量 `MAO_CUSTOM_<ID>_API_KEY`），定义本身不含密钥。
- API 类型支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`，多数第三方与自建服务用 `openai-completions`。勾选「服务端不支持 developer 角色」可兼容 vLLM、Ollama 一类不接受 `developer` 角色和 `reasoning_effort` 的服务。
- 有 Agent 正在运行或排队时拒绝保存；删除仍被某个 Agent 使用的提供商会被拒绝，而不是让那个 Agent 悄悄离线。
- 一个自定义定义写错不会拖垮其他 Agent：注册失败只记录为警告并显示在花名册里，其余提供商照常可用。
- 走订阅或系统凭据登录的提供商（Codex 订阅、Copilot、Vertex ADC 等）仍然请用 `pi` 的 `/login` 写入 `auth.json`，界面会如实说明。

## 路由语义

- 用户可以在普通正文中写 `@handle`，一条消息最多唤醒两个不同 Agent。
- 代码块、行内代码、URL 和引用字符串中的 `@handle` 不参与路由。
- 没有显式 mention 时，依次选择该 Thread 最近成功回复且在线的 Agent、花名册中配置的默认 Agent、第一个在线 Agent。
- Agent 只能通过结构化 `post_message({ content, intent?, idempotencyKey })` 发布协作消息并触发 A2A；目标从行首、列表或引用前缀后的 `@handle` 解析。
- 普通最终输出中的 `@handle` 永远不会触发另一个 Agent。
- 未知、停用或离线目标会返回明确错误，不会静默回退。

平台保留深度 4、每条协作链最多 8 次运行、幂等去重、同一对 Agent 连续 4 次乒乓限制和整链取消。

## 同侪审核

审核门看的是这一轮**产出了什么**，不是"谁发起的"。默认 `MAO_REVIEW_GATE=smart`：

- **Agent 自己判断**产出是不是交付物。完成人类交给的活，调 `complete_task({ summary, evidence? })`，`evidence` 写清改了哪些文件、跑了什么命令、怎么验证；产出的是方案、设计、计划，调 `submit_plan({ summary, evidence? })`。闲聊、回答问题、解释说明不声明，也就没人审。
- **不声明也逃不掉**：depth-0 的用户任务只要动过工作区（`file_change` / `edit` / `write`），照样进审核门。自称完成不可信，不吭声就改文件更不可信。只读运行和纯 shell 读命令不触发——审核者自己读文件时不该把自己送审。
- 两种审核类型走同一套返工机器：`verify` 核对完成声明，审核者被要求**去看证据**而不是信作者的话（读它说改过的文件、跑它给的验证命令，只批准自己验证过的部分）；`critique` 评审方案，要求给出优点、风险、具体改进建议，`approved` 表示方案可执行。
- 审核者优先取花名册中该 Agent 的 `reviewerAgentId`；未配置、指向自己或对方离线时，按花名册顺序回退到任意其他在线 Agent。审核者永远不等于执行者，也不能给自己声明交付物。
- 审核 Agent 只能通过结构化 `submit_review({ verdict, summary, findings? })` 给出结论。`changes-requested` 必须至少给出一条具体意见，否则被拒绝。
- `changes-requested` 会把审核意见作为可见消息回送给执行者返工，最多 `MAO_MAX_REVIEW_ROUNDS`（默认 2）轮；用满后升级给用户，不再自动循环。
- 以下四种情况一律记为"需要人工介入"，**绝不当作通过**：没有其他可用 Agent 可以审核；审核 run 结束却没有调用 `submit_review`；审核 run 失败或审核者中途不可用；返工轮数用尽仍未通过。
- 整链取消会一并取消进行中的审核，标记为"已取消"而不是升级——那是人工动作，不是质量信号。
- 审核与返工 run 由平台发起，不占用每链 8 次运行的额度，也不增加 A2A 深度或乒乓计数；它们只受审核轮数约束。用户消息可指定两个 Agent，沿用 A2A 额度会随机撞限。
- A2A 协作产生的 run（depth ≥ 1）不进入审核门，只有用户直接发起的任务会。
- 用户插话不会新建 run，因此沿用当前这一轮所属任务的审核状态。
- `MAO_REVIEW_GATE=on`（或 `required`）恢复旧行为：用户发起的每个任务一律送审，包括一句"你好"。`MAO_REVIEW_GATE=off` 关闭审核，只用于演示和离线测试。

审核过程在 Thread 里完全可见：送审和审核意见都是普通消息，交付声明以 `deliverable.declared` 记录，审核结论以 `review.requested` / `review.submitted` / `review.rework` / `review.resolved` 事件记录（前两者带 `reviewType`）。

Agent 正在运行时，用户可以直接插话：消息会送进当前这一轮（Pi 在本轮工具调用结束、下一次模型请求之前收到），而不是排队等下一轮。只有用户消息可以插话；`post_message` 的 A2A 仍然走完整的排队与限额，协作链语义不变。运行时不支持插话时自动回退为排队。

消息可以附带图片。Pi 直接把图片交给模型；Codex CLI 不接受内联图片，因此改为在 prompt 里给出附件的绝对路径。图片保存在数据目录的 `attachments/`，事件日志里只记录引用。

## 会话、并发与恢复

- 每个 `{threadId, agentId}` 都有独立的持久 session。
- Pi session 位于 `.data/runtime-sessions/pi/...`；Codex 保存 `codex exec --json` 返回的 Thread ID，并使用 `codex exec resume` 续接。
- 新 Agent 首次进入 Thread 时注入最近 20 条、最多 24,000 字符的共享上下文；后续只交付尚未看到的消息。
- 同一个 Agent 同时只运行一个 session。
- `read-only` Agent 最多四个并行；可写 Agent 按规范化工作目录互斥。同目录写入串行，不同目录可并行。
- 重启后恢复尚未开始的 queued run；上次进程里已 running 的 run 标记为 `interrupted`，不会自动重试可能产生副作用的调用。排队中的审核会照常继续；上次进程里正在运行的审核标记为中断并升级给用户，不会重跑。
- 旧事件日志里没有审核事件，回放时不会给历史任务补发审核；没有 `reviewType` 的历史审核按 `verify` 回放。

JSONL EventStore 使用串行 append。旧日志中的 `recipientAgentId`、`rootRunId` 和旧 Agent 名称会在读取时规范化，源事件不会被覆盖。

## 给普通用户：安装后使用

桌面版把 Electron/Node.js 运行时、服务端和网页界面打进同一个应用。用户不需要安装 Node.js 或 pnpm：

1. 下载自己系统对应的文件：macOS 使用 `.dmg`，Windows x64 使用文件名包含 `Setup` 的 `.exe`，Linux 使用 `.AppImage`。
2. 安装并双击桌面上的 **Multi-Agent Office** 快捷方式。应用会立即显示启动窗口，等本地服务就绪后自动进入前端界面（首次启动或磁盘较慢、杀毒软件扫描时可能需要一分钟左右）；再次双击快捷方式会把已有窗口显示到前台。第一个界面会要求选择 API 提供商并输入 API Key。
3. 选择“仅使用 API”即可完全不使用 Codex；如本机已经安装并登录 Codex CLI，也可以选择“API + Codex”。
4. 点击“保存并进入工作台”。配置会立即生效，不需要打开配置文件或重启应用。

首次启动页默认列出常用提供商（Z.AI 中国区/全球版、DeepSeek、Kimi、通义千问、OpenAI、Anthropic、Gemini、OpenRouter），点「更多提供商」可展开全部 35 个；第三方或自建部署的模型进入工作台后在 Agent 花名册里添加。选择 DeepSeek 时默认使用官方 `deepseek-v4-flash` 模型和 `DEEPSEEK_API_KEY`。密钥只发送给应用自身绑定在 `127.0.0.1` 的本地服务，并以仅当前用户可读的方式写入用户数据目录。已经通过旧版 `config.env` 配置过密钥的用户会直接进入工作台，不会被重复拦截。

桌面版默认配置为：

```dotenv
ZAI_CODING_CN_API_KEY=在这里填写密钥
MAO_PI_PROVIDER=zai-coding-cn
MAO_PI_MODEL=glm-5.2
MAO_PI_THINKING=medium
MAO_DEFAULT_AGENT=pi
MAO_SETUP_COMPLETED=1
```

配置和运行数据都在用户目录，不会写进安装目录，也不会随安装包分发：

- macOS：`~/Library/Application Support/Multi-Agent Office/`
- Windows：`%APPDATA%\Multi-Agent Office\`
- Linux：`~/.config/Multi-Agent Office/`

其中 `config.env` 保存密钥，`data/` 保存 Agent 花名册、事件和 session，`desktop.log` 用于排查启动问题。不要把 `config.env` 发给别人或提交到 Git。

Windows 旧版曾错误地把这些文件放在 `%APPDATA%\multi-agent-pi-mvp\`。新版首次启动时会把旧配置、数据和日志复制到正确目录；已存在的新目录内容不会被覆盖，旧目录也会保留以便恢复。

Windows 版运行时会在通知区域保留图标，以便重新打开窗口、在默认浏览器中打开、查看配置或日志以及退出应用。关闭窗口只会隐藏到通知区域，不会停止本地服务；要完全退出，请右键通知区域图标并选择“退出”。

### 应用内更新

Windows 和已使用 Developer ID 签名的 macOS 安装版会在启动 30 秒后检查一次更新，此后每 6 小时后台检查。首次启动设置页提供 **检查更新** 按钮；进入工作台后，也可以随时点击侧边栏底部带文字的 **更新** 按钮，或从应用的 **帮助 → 检查更新** 手动检查；Windows 通知区域图标的右键菜单也保留同一入口。发现新版后，应用会在后台下载安装包并显示下载进度；下载完成后可以立即重启安装，也可以在稍后退出应用时自动安装。用户目录中的 `config.env`、Agent 花名册、任务记录和日志不会被覆盖。

浏览器和桌面安装版使用同一套 Web 界面，因此更新入口在两者中位置一致。普通浏览器无需单独更新；只有桌面安装版会通过安全的 preload/IPC 桥接执行系统级安装。源码开发模式不会连接发布更新服务。

macOS Release 同时包含通用架构 DMG 安装包和自动更新所需的 ZIP。macOS 自动更新必须使用 Developer ID 签名并通过 Apple 公证；在仓库 Secrets 中配置 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD` 和 `APPLE_TEAM_ID` 后，流水线会自动完成签名、公证和发布前验证。没有这些 Secrets 时只会生成保留 7 天的未签名测试 artifact，不会创建或覆盖 GitHub latest Release，避免客户端收到无法安装的更新。

应用启动时会验证当前 macOS 安装包是否具有有效的 Developer ID 签名。旧的未签名版本不会再尝试运行必然失败的自动更新器，而会明确显示 **手动下载更新**。用户需要从 GitHub Releases 手动安装一次已签名版本；此后即可进入正常的应用内自动更新通道。

Pi 运行时已包含在桌面应用中。`@codex` 仍需要用户另外安装并登录 Codex CLI；如果命令不在系统 PATH 中，请在 `config.env` 配置绝对路径：

```dotenv
MAO_CODEX_COMMAND=/absolute/path/to/codex
```

## 生成安装包

打包机需要 Node.js 22.13+ 和 pnpm。先安装依赖，然后按打包机当前系统生成安装包：

```bash
pnpm install
pnpm dist:desktop
```

产物位于 `release/`。也可以显式运行：

```bash
pnpm dist:mac
pnpm dist:win
pnpm dist:linux
```

建议分别在 macOS、Windows、Linux 构建并测试对应产物。公开分发前还应为 macOS 应用和 Windows 安装包配置代码签名；未签名的测试包可能触发系统安全警告，macOS 自动更新还会因缺少有效签名而不可用。

Windows 安装包固定为 x64 NSIS 安装器，文件名格式为
`Multi-Agent Office-Setup-<version>-windows-x64.exe`。仓库中的 **Desktop installers** GitHub Actions 工作流会分别在原生 Windows 和 macOS 环境完成构建与启动验证，并发布 Windows x64 NSIS 安装器、macOS universal DMG/ZIP，以及各平台的 `.blockmap`、`latest.yml` / `latest-mac.yml`。macOS 签名和公证凭据齐全、且签名验证通过时，每次推送 `main` 都会自动发布标记为 latest 的 Release，推送 `v*` 标签则会创建对应标签的正式 Release；缺少凭据时仍会完成 Windows 构建和未签名 macOS 冒烟测试，但产物仅保留为 Actions artifact，不会进入任何客户端更新通道。流水线会根据 `package.json` 的 major/minor/patch 与 GitHub run number 生成单调递增的安装版版本号，供两个平台的应用内更新共同使用。

仅生成当前平台可直接运行、但不制作安装器的目录：

```bash
pnpm pack:desktop
```

## 从源码启动

需要 Node.js 22.13+ 和 pnpm：

```bash
pnpm install
cp .env.example .env
pnpm dev
```

打开 `http://127.0.0.1:4173`。服务只绑定 `127.0.0.1`；桌面版会自动选择空闲的本地端口。

中国区 Z.AI/智谱 Coding Plan 使用 `ZAI_CODING_CN_API_KEY` 和 `zai-coding-cn`；全球版使用 `ZAI_API_KEY` 和 `zai`。Codex 可以使用本机 ChatGPT 登录或环境变量中的 `OPENAI_API_KEY`。运行时状态会显示在花名册和运行详情中。

Pi 的凭据同时从环境变量和 `~/.pi/agent/auth.json` 读取，因此用 `pi` 登录过的 API Key 与 OAuth 订阅（Claude Pro/Max、ChatGPT、GitHub Copilot、xAI、OpenRouter 等）可以直接使用，不必再设一遍环境变量。花名册里的在线状态以这两者的并集为准。

生产构建与启动：

```bash
pnpm build
pnpm start
```

确定性演示（不调用模型）：

```bash
pnpm demo -- "@pi @codex 请独立评估这个方案"
```

## 本地 API

- `GET /api/agents`：安全花名册、revision、运行时在线/认证状态。
- `PUT /api/agents`：用 revision 乐观锁原子替换花名册；不接受或返回密钥。
- `POST /api/messages`：接收 `content`、可选 `threadId`、新 Thread 的 `workspacePath`、`attachments`（PNG/JPEG/WebP/GIF，最多 4 张、每张 5 MB）和 `steer`。
- `POST /api/chains/:chainId/cancel`：取消整条协作链。
- `GET /api/events`：SSE 事件投影。
- `GET /api/models`：Pi 可用的 provider 与模型目录，以及每个 provider 是否已配置凭据；不返回密钥。
- `POST /api/providers/credential`：为单个内置 provider 写入 API Key 并热更新 Pi 的凭据缓存；只接受本机同源请求，不返回密钥，有 Agent 在跑时返回 409。
- `GET /api/agents/:agentId/session?threadId=`：该 Agent 在此 Thread 的 session 统计。
- `POST /api/agents/:agentId/session?threadId=&action=compact|export&format=html|jsonl`：手动压缩上下文或导出 session。

Codex 的 `post_message` 与 `submit_review` 通过本机 MCP stdio server 回调内部端点 `/internal/agent-message` 与 `/internal/agent-review`。每次 run 使用独立随机 token，并校验 run、Thread 和 Agent 身份；token 在 run 结束后立即失效。

## 验证

```bash
pnpm run check
pnpm test
pnpm build
```

测试覆盖花名册、mention 解析、对等路由、A2A、幂等与乒乓限制、读写调度、整链取消、上下文游标、session 隔离、Codex JSONL 首次执行与 resume、MCP token、Pi 凭据判定、多 provider 凭据互不覆盖、Agent 头像标识去重、可观测性事件投影、运行中插话与回退、图片附件，以及现有历史事件的完整兼容回放。

审核相关覆盖：强制送审与审核者选取（配置优先、离线回退）、通过后终结、不通过返工并复审、轮数上限升级、无结论/无审核者/审核失败一律不通过、审核中取消、重启后中断的审核升级、审核 run 不占用链额度与深度、审核者不会变成 Thread 的默认应答者，以及旧日志回放不补发审核。smart 门另有覆盖：闲聊不送审、声明完成走 verify 且证据进入审核简报、提交方案走 critique 且返工仍是 critique、改文件不声明也送审、只读运行与 shell 读命令不触发、审核者不能自我声明、声明不能改口径、`required` 模式语义不变，以及带声明的日志回放。

## 安全边界

Pi 的 `full` 模式会开放 Bash/edit/write，但 Pi SDK 本身不提供完整文件系统沙箱。只应在可信的本地工作目录或额外隔离环境中使用。Codex v1 即使配置 `full` 也只映射为 `workspace-write`，不会启用 `danger-full-access`。

工作目录里的 `.pi/extensions`、`.pi/skills`、`.pi/settings.json` 等项目级资源属于可执行代码，默认**不**加载。这与 pi 非交互模式的默认行为一致。已经用 `pi` 保存过信任决定的目录按该决定处理；其余目录需要显式开启：

```dotenv
MAO_PI_PROJECT_TRUST=always
```

只在你信任该仓库时才打开。用户级的 `~/.pi/agent/extensions` 与 `~/.agents/skills` 始终加载，它们属于你自己的配置。
