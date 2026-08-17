# Multi-Agent Office

一个参考 Cat Café / Clowder AI 协作方式的本地对等多 Agent 工作台。平台没有 Boss Agent，也没有固定的 Architect → Reviewer 流程；每个 Agent 都能独立接单、拒绝、向用户提问，或通过结构化 `post_message` 把任务交给队友。

## 默认团队

首次启动会原子创建 `.data/agents.json`：

- `@codex`：使用本机 Codex CLI 和 `workspace-write` 沙箱。
- `@pi`：使用 `MAO_PI_*` 模型配置，默认 `full`，开放 Bash/edit/write。

两者是对等协作者。桌面安装版首次使用 `@pi` 作为默认 Agent，并允许在首次启动页停用 `@codex`；源码启动可通过 `MAO_DEFAULT_AGENT=pi|codex` 选择。Web 的 Agent 花名册可以新增任意数量的 Pi/Codex Agent，编辑模型、身份、system prompt、能力和访问级别，停用 Agent，并切换默认 Agent。handle 保存后不可改；密钥只从首次启动页写入本地 `config.env`，或直接从环境变量读取，不写入花名册或 API 响应。

## 路由语义

- 用户可以在普通正文中写 `@handle`，一条消息最多唤醒两个不同 Agent。
- 代码块、行内代码、URL 和引用字符串中的 `@handle` 不参与路由。
- 没有显式 mention 时，依次选择该 Thread 最近成功回复且在线的 Agent、花名册中配置的默认 Agent、第一个在线 Agent。
- Agent 只能通过结构化 `post_message({ content, intent?, idempotencyKey })` 发布协作消息并触发 A2A；目标从行首、列表或引用前缀后的 `@handle` 解析。
- 普通最终输出中的 `@handle` 永远不会触发另一个 Agent。
- 未知、停用或离线目标会返回明确错误，不会静默回退。

平台保留深度 4、每条协作链最多 8 次运行、幂等去重、同一对 Agent 连续 4 次乒乓限制和整链取消。

## 会话、并发与恢复

- 每个 `{threadId, agentId}` 都有独立的持久 session。
- Pi session 位于 `.data/runtime-sessions/pi/...`；Codex 保存 `codex exec --json` 返回的 Thread ID，并使用 `codex exec resume` 续接。
- 新 Agent 首次进入 Thread 时注入最近 20 条、最多 24,000 字符的共享上下文；后续只交付尚未看到的消息。
- 同一个 Agent 同时只运行一个 session。
- `read-only` Agent 最多四个并行；可写 Agent 按规范化工作目录互斥。同目录写入串行，不同目录可并行。
- 重启后恢复尚未开始的 queued run；上次进程里已 running 的 run 标记为 `interrupted`，不会自动重试可能产生副作用的调用。

JSONL EventStore 使用串行 append。旧日志中的 `recipientAgentId`、`rootRunId` 和旧 Agent 名称会在读取时规范化，源事件不会被覆盖。

## 给普通用户：安装后使用

桌面版把 Electron/Node.js 运行时、服务端和网页界面打进同一个应用。用户不需要安装 Node.js 或 pnpm：

1. 下载自己系统对应的文件：macOS 使用 `.dmg`，Windows x64 使用文件名包含 `Setup` 的 `.exe`，Linux 使用 `.AppImage`。
2. 安装并双击桌面上的 **Multi-Agent Office** 快捷方式。Windows 版会启动本地服务并打开应用窗口；再次双击快捷方式会把已有窗口显示到前台。第一个界面会要求选择 API 提供商并输入 API Key。
3. 选择“仅使用 API”即可完全不使用 Codex；如本机已经安装并登录 Codex CLI，也可以选择“API + Codex”。
4. 点击“保存并进入工作台”。配置会立即生效，不需要打开配置文件或重启应用。

首次启动页支持 Z.AI 中国区/全球版、DeepSeek、OpenAI、Anthropic 和 Google Gemini。选择 DeepSeek 时默认使用官方 `deepseek-v4-flash` 模型和 `DEEPSEEK_API_KEY`。密钥只发送给应用自身绑定在 `127.0.0.1` 的本地服务，并以仅当前用户可读的方式写入用户数据目录。已经通过旧版 `config.env` 配置过密钥的用户会直接进入工作台，不会被重复拦截。

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

Windows 版运行时会在通知区域保留图标，以便重新打开窗口、在默认浏览器中打开、查看配置或日志以及退出应用。关闭窗口只会隐藏到通知区域；要完全退出，请右键通知区域图标并选择“退出”。

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

建议分别在 macOS、Windows、Linux 构建并测试对应产物。公开分发前还应为 macOS 应用和 Windows 安装包配置代码签名；未签名的测试包可能触发系统安全警告。

Windows 安装包固定为 x64 NSIS 安装器，文件名格式为
`Multi-Agent Office-Setup-<version>-windows-x64.exe`。仓库中的 **Windows installer** GitHub Actions 工作流会在原生 Windows 环境完成类型检查、测试、安装以及真实窗口启动验证：可以在 Actions 页面手动运行并下载构建产物；每次推送 `main` 都会创建预发布版 Release，推送 `v*` 标签则会创建正式 Release。这样无需在 macOS 上安装 Wine，也不会再只生成 macOS 产物。

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
- `POST /api/messages`：接收 `content`、可选 `threadId` 和新 Thread 的 `workspacePath`。
- `POST /api/chains/:chainId/cancel`：取消整条协作链。
- `GET /api/events`：SSE 事件投影。

Codex 的 `post_message` 通过本机 MCP stdio server 回调内部端点。每次 run 使用独立随机 token，并校验 run、Thread 和 Agent 身份；token 在 run 结束后立即失效。

## 验证

```bash
pnpm run check
pnpm test
pnpm build
```

测试覆盖花名册、mention 解析、对等路由、A2A、幂等与乒乓限制、读写调度、整链取消、上下文游标、session 隔离、Codex JSONL 首次执行与 resume、MCP token，以及现有历史事件的完整兼容回放。

## 安全边界

Pi 的 `full` 模式会开放 Bash/edit/write，但 Pi SDK 本身不提供完整文件系统沙箱。只应在可信的本地工作目录或额外隔离环境中使用。Codex v1 即使配置 `full` 也只映射为 `workspace-write`，不会启用 `danger-full-access`。
