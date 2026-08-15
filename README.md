# Multi-Agent Pi MVP

这是一个最小但完整的多 Agent 平台骨架。平台拥有线程、消息、因果链、A2A 路由、上下文编译、事件日志和取消；Pi 只是一个可替换的 Agent Runtime。

## 已实现的链路

```text
human @architect
  -> architect run
  -> send_message(reviewer)
  -> platform queue
  -> reviewer run
  -> send_message(architect)
  -> platform queue
  -> architect synthesizes review
```

关键约束：Agent 的普通输出永远不会被解析为 A2A 指令。只有结构化 `send_message` 工具可以产生新的 Agent Run。

## 项目结构

```text
src/core/platform.ts             调度、路由、去重、深度限制、整链取消
src/core/event-store.ts          JSONL 和内存事件存储
src/core/context-compiler.ts     每一轮的上下文选择
src/runtime/runtime.ts           与具体 Agent 无关的运行时协议
src/runtime/pi-runtime.ts        Pi SDK 适配器
src/runtime/deterministic-runtime.ts  无凭证可运行的确定性演示
src/config/agents.ts             Architect / Reviewer 身份定义
src/demo.ts                      命令行演示入口
```

## 启动

需要 Node.js 20+ 和 pnpm。

```bash
pnpm install
pnpm test
pnpm demo
```

默认使用确定性运行时，不需要模型或 API 凭证：

```bash
pnpm demo -- "@architect 设计一个支持共享记忆的多 Agent MVP"
```

事件会追加到 `.data/events.jsonl`，新平台实例可以从中恢复 Thread 消息。

## 使用真实 Pi

复制环境变量模板；真实 Key 只保存在被 Git 忽略的 `.env` 中：

```bash
cp .env.example .env
```

中国区 Z.AI/智谱 Coding Plan 使用 `ZAI_CODING_CN_API_KEY` 和
`zai-coding-cn`；全球版使用 `ZAI_API_KEY` 和 `zai`。默认示例模型是
`glm-5.3`。配置完成后执行：

```bash
pnpm demo -- --runtime=pi "@architect 评审当前多 Agent 架构"
```

也可以在命令行覆盖模型选择：

```bash
pnpm demo -- --runtime=pi --provider=zai-coding-cn --model=glm-5.3 --thinking=medium "@architect 评审当前架构"
```

Pi 适配器默认只提供只读工具和 `send_message`。如果明确希望 Agent 修改当前仓库：

```bash
pnpm demo -- --runtime=pi --pi-write "@architect 实现一个小改动并交给 reviewer"
```

注意：Pi 本身不提供完整的文件、进程和网络权限沙箱。启用写入及 Bash 工具前，应在容器或隔离工作区中运行。

## 当前 MVP 边界

- 调度器是单进程串行队列。
- Pi 每个 Run 使用独立的内存 Session；平台事件和编译后的 Thread Context 才是事实来源。
- 还没有 HTTP/WebSocket API 和 Web UI。
- 还没有长期记忆提取与检索；`ContextCompiler` 是后续接入点。
- 重启可以恢复消息，但不会自动恢复中断到一半的 Run。

下一阶段建议先增加 `MemoryStore` 与可解释的 `ContextCompiler`，然后再做并发调度和进程隔离。
