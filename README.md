# Multi-Agent Office

一个本地对等多 Agent 工作台。平台没有 Boss Agent，也没有固定角色；每个 Agent 都能独立接单、拒绝、向用户提问，或通过结构化 `post_message` 把任务交给队友。

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

- 用户可以在普通正文中写 `@handle`，一条消息最多唤醒三个不同 Agent。
- 代码块、行内代码、URL 和引用字符串中的 `@handle` 不参与路由。
- 没有显式 mention 时，依次选择该 Thread 最近成功回复且在线的 Agent、花名册中配置的默认 Agent、第一个在线 Agent。
- 用户与 Agent 的多目标消息都有明确 `routingMode`：默认 `serial`，按 mention 顺序逐棒执行；选择 `parallel` 时才并行扇出。平台不再从自然语言猜测并发意图。
- Agent 只能通过结构化 `post_message({ content, collaborationIntent, routingMode, idempotencyKey })` 发布协作消息并触发 A2A；目标从行首、列表或引用前缀后的 `@handle` 解析。`collaborationIntent` 为 `handoff`（交棒）、`fyi`（仅同步）或 `done_notify`（完成通知）。
- 普通最终输出中的 `@handle` 永远不会触发另一个 Agent。
- 未知、停用或离线目标会返回明确错误，不会静默回退。

平台保留深度 4、每条协作链最多 8 次运行、幂等去重、同一对 Agent 连续 4 次乒乓限制和整链取消。

### Clowder 风格的协作内核

多 Agent 框架参考 [clowder-ai](https://github.com/zts212653/clowder-ai) 的交互模型，落成四个彼此独立、可回放的协议层：

- **显式路由**：`serial` 是有前驱约束的顺序交棒，`parallel` 是同一批次的独立分支；每个 run 持有 `batchId / index / total / predecessorRunId` 投影。
- **球权（ball custody）**：`ball.handed`、`ball.held`、`ball.wake_sent`、`ball.handed_user`、`ball.void_pass`、`task.done` 等事件构成唯一事实源。球权状态可从 JSONL 事件重建，不依赖内存里的隐式布尔值。
- **有依据的等待**：Agent 可调用 `hold_ball({ wakeAfterMs, waitSourceRef })` 暂存球权；`waitSourceRef` 必须说明等待对象、预期信号和可选 SLA。到时平台给原 Agent 发送 `wake` 消息并恢复同一协作链；重启后未到期的等待会重新挂载，取消整链也会取消等待。
- **分层协作提示**：Pi 与 Codex 都注入 L0–L7 协议层，依次覆盖身份、平行世界认知、客观事实继承、路由与球权、安全法则、交付/审核协议、实时花名册和协作哲学。实时 roster、当前路由位置与可用工具不再散落在一段不可审计的提示词中。
- **失败封闭的批次语义**：串行前驱只有在成功完成后才会放行下一棒；失败、取消或中断会抑制依赖它的后续 run。并行批次只要有一个分支失败，就不会被最后完成的成功分支覆盖成 `task.done`，而是把球交回用户处理。
- **协作链只读投影**：运行界面从同一份事件日志重建 `queued / active / waiting-external / waiting-human / needs-attention / completed / cancelled`，显示当前持球者、等待依据、异常分支，以及每条 `post_message` 对每个目标的排队、执行和终态回执；它不是另一套会漂移的调度状态。

在这四层之上，**审核时机**与**人工介入**同样按 Clowder 的口径落成两条独立协议：

- **审核者路由**：硬规则（非作者、`peer-reviewer` 角色、在线）加偏好排序（链内独立 → 明确指派 → 跨模型家族 → 本 Thread 活跃 → 花名册顺序）；拿不到理想人选时降级而不是不审，但降级原因必须留痕，且同一个任务的多轮协商固定同一位审核者。详见下面的「同侪审核」。
- **异议分级与收敛判据**：每条审核意见都带 `blocking` / `major` / `minor` 严重度（对齐 clowder 的 P1/P2/P3 分诊）。决定任务是否被卡住的是严重度，不是 verdict——只剩小建议就是"带评论的共识"，不再多走一轮。协商什么时候结束也不看轮数：同一条异议连续多轮既没被解决也没被撤回，才算真的谈不拢（clowder 的「≥3 轮升级规则」）。详见下面的「同侪审核」。
- **统一待办**：所有需要人拍板、裁决、补充信息或接手失败链的闸门，都进同一个跨 Thread 索引，带触发原文与审批卡的双锚点，过期只标 stale 不自动拒绝。详见下面的「统一待办」。

原有的计划模式、写锁和深度/乒乓保护继续作为本地策略层运行；它们不替代路由和球权协议。

这仍是轻量本地实现，不等同于完整 Clowder。**审核时机**上仍然缺少 Clowder 的多验证源分流（本项目只有本地同侪，没有云端 review，也没有终态的「愿景守护」）、按行为/数据/安全/契约/不可逆五轴风险选择验证深度，以及 `skip` / `reuse` / `continuityProof` 这类「机械变化不重开 reviewer」的凭据；本项目改用一条更机械也更保守的触发口径：声明了交付物、或动过工作区，就送审。Clowder 的 P1/P2/P3 分诊和「≥3 轮同型 finding 就升级」已按本项目的口径落成（见「同侪审核」的严重度与停滞判据），但两处仍有差距：严重度和 `kind=question` 都由审核者自己申报，平台既不按五轴风险独立复核严重度，也读不出一条没标 question 的意见其实只有人能拍板——那种意见只会被当成普通异议派回作者，靠的是审核简报里的措辞判据兜着；「同型」在 Clowder 是 Agent 对 failure mode 的语义判断，这里退化成措辞重合度这一条机械近似，阈值取高、宁漏勿误。**人工介入**上仍然缺少 Clowder 的跨 Thread 任务派发审批（`assign_work` effect-class）与多用户权限域——单机对等工作台里只有一个 operator，跨 Thread 派发也不是本项目的协作形态。**计划前的业界调研**上已按留痕口径落成一层（见下面的「业界先例」），但仍然缺少 clowder 的多路 Deep Research 管线与开源拆解流程本身——本项目只规定先例怎么算数，不提供去查的执行面。其余差异同前：当前没有跨 Thread/跨项目共享记忆与证据索引、按需 Skills/SOP Guardian、分布式队列租约与多进程恢复，或外部平台网关。这些能力应按本项目“单机、对等 Agent 工作台”的边界逐项引入，而不是直接复制 Clowder 的 Redis/服务化架构。

## 同侪审核

审核门看的是这一轮**产出了什么**，不是"谁发起的"。默认 `MAO_REVIEW_GATE=smart`：

- **Agent 自己判断**产出是不是交付物。完成人类交给的活，调 `complete_task({ summary, evidence? })`，`evidence` 写清改了哪些文件、跑了什么命令、怎么验证；产出的是方案、设计、计划，调 `submit_plan({ summary, evidence? })`。闲聊、回答问题、解释说明不声明，也就没人审。
- **先澄清，再交付，再审核**：如果缺失信息会实质改变目标、架构、验收标准或实现，Agent 必须先调 `request_clarification({ questions })`，在回复中向人类提出最多 5 个必要问题，然后停下等待；这一轮不会送同伴审核，也不能再调 `submit_plan` / `complete_task`。能从代码或资料查到的事实，以及可用安全、可逆假设解决的细节，不应打断用户。人类补充后，Agent 才生成方案或执行，完成后照常送审。
- **协商轮里也能问人，而且不必先放下手里的活**：第一轮的口径是"问就别做"——已经动过工作区的 run 不能再调 `request_clarification`，那一轮欠的是交付物或一句老实的失败。进入审核协商之后口径反过来：作者常常是把能改的异议改完，才撞上一条只有人能定的，所以这时的 `request_clarification` 即使在写入之后也照样接受。改了一半、正等着同一个答案的修订版不是拿去给审核者看的东西——本轮直接以 `clarification-needed` 结束审核并把问题递给用户，不再排下一轮。之所以要专门放开这一条：不放开的话，执行者在协商轮里唯一能走完流程的方式就是猜一个，而"猜一个交上去"正是审核门存在的理由。
- **不声明也逃不掉**：depth-0 的用户任务只要动过工作区（`file_change` / `edit` / `write`），照样进审核门。自称完成不可信，不吭声就改文件更不可信。只读运行和纯 shell 读命令不触发——审核者自己读文件时不该把自己送审。
- **审核者是独立的怀疑者，不是第二双友善的眼睛**：审核简报和审核者的系统提示都把默认立场设为"未通过"——举证责任在作者一方，怀疑不需要理由。作者的 summary 和 evidence 只是待检验的断言，审核者被要求自己去看一手材料（亲自打开它说改过的文件、亲自跑它说跑过的命令、亲自看真实输出），并主动去找一个自信的结论会掩盖什么：被悄悄丢掉的原始需求、没覆盖的边界、错误分支、什么都没断言的测试、只字未提的改动。凡是以自己的权限查不了的，一律算未验证，说清楚，且不得据此通过。
- 两种审核类型走同一套协商机器：`verify` 核对完成声明；`critique` 评审方案——默认立场是"还不能执行"，要求正面攻击它没论证的假设、跳过的失败模式、被一句话带过的工作量。两者都对照人类的原始任务判断，而不是对照作者对任务的转述；`approved` 表示双方已得到一版都愿意负责的定稿。
- **审核者按固定优先级路由，降级必须留痕**（对齐 clowder 的 reviewer matcher）。硬规则先过：不能是作者本人；花名册里只要有 Agent 声明了 `peer-reviewer` 能力，就只在声明者中选（没人声明时全员可选，等于这条规则不存在）；必须在线。剩下的候选按下列顺序排：
  1. **与本次工作无关**：在同一条协作链里产出过东西的 Agent（比如被转交过一段实现的 peer）不算独立——它是在给自己挑毛病。
  2. **花名册里为该作者配置的 `reviewerAgentId`**：这是人对这个作者做的明确指派，不是启发式，所以压过下面两条。
  3. **与作者不同的模型家族**（Pi 看 provider，Codex 自成一族）：同一家族的两个 Agent 共享同一套盲区，换一个家族才是真的换一双眼睛。
  4. **最近在本 Thread 说过话**，最后按花名册顺序兜底。
- **降级要说出口**：拿不到理想人选时仍然会审——有人看总比没人看强——但降级原因会写进 `review.requested` 的 `reviewerMatch`，并直接出现在审核简报里：`chain-contributor` 明说"你不是中立方"，`same-family` 明说"你和作者同一模型家族，共享它的盲区，先查你自己也会犯的那类错"。审核者永远不等于执行者，也不能给自己声明交付物；离线候选按花名册顺序回退。
- **一个任务认一个审核者**：同一个任务的多轮协商固定由同一位同侪判断——提出异议的人才有资格评价作者对这条异议的回应；只有该同侪掉线时才重新路由。
- 审核 Agent 只能通过结构化 `submit_review({ verdict, summary, findings?, checks? })` 登记每轮结论。`changes-requested` 是审核者当前的有据异议，不是给作者下命令；它必须至少包含一条具体意见。`approved` 必须在 `checks` 里至少列出一条**自己动手做过的**核验（读了哪个文件、跑了什么命令、看到什么输出），否则一律被拒——说不出自己查过什么的共识，只是把作者的话复述了一遍。怀疑永远不比同意更费力：带阻塞性异议的 `changes-requested` 不要求 `checks`。
- **卡住任务的是严重度，不是 verdict**。每条 finding 写成 `{ detail, severity, kind? }`：`blocking` 是不能就这样交付，`major` 是作者必须正面回应，`minor` 是挑剔、偏好或后续想法。只有 `blocking`/`major` 会把任务留在门里；`minor` 照样记录、照样交给作者，但不占一轮协商，也不会因此惊动人。审核者手里只剩 `minor` 时提交 `changes-requested`，平台按"带评论的共识"结案——但既然它放行了，就和任何一次 `approved` 一样欠一条自己做过的核验。
- **只有人能拍板的异议直接去问人**。`kind: "question"` 标记的是原始任务从来没定过的事：多走一轮只会换来一个论证更漂亮的猜测。带 `blocking`/`major` 的 question 会立刻结束协商并把问题原样递给用户，而不是等轮数烧完。这条留给"两个 Agent 自己怎么讨论都定不了"的情况，能自己查、能用安全可逆假设兜住的，不许往这儿塞。反过来，平台读不出一条没标记的意见其实是想问人——审核简报因此给了一条机械判据：凡是写成"请作者与用户确认/对齐"的意见，就是 question，必须标出来；不标就只会被当成普通异议派回给作者去争论，想问的那个人根本不会看到。
- `changes-requested` 会把意见作为普通可见消息交给作者继续讨论。作者不需要执行正式的“接受/反驳”动作，也不能机械照单全收：认为意见正确就改，认为不正确就用证据说明，或提出更好的折中方案；下一轮要给出完整候选定稿，而不只是回复清单。审核者必须重新评价作者的理由和最新版，不能不回应论证就重复上一轮意见。双方任何一方都可以改变判断。
- **结束协商的是停滞，不是轮数**。轮数是时钟，不是分歧探测器：把最后一轮花掉，只说明谈话次数用完了，不说明两个 Agent 谈不拢——按轮数升级，等于几乎每个任务最后都要找人。真正的死锁长这样：同一条阻塞性异议连续 `MAO_REVIEW_STALL_ROUNDS`（默认 2）轮既没被解决，也没被撤回。异议在换、在减少，就说明讨论还在推进，平台不打断。判断"是不是同一条异议"看的是措辞的实质重合度（中文按字二元组，其余按词），阈值取得偏高：宁可漏判让讨论多走一轮，也不要误判提前叫人。
- `MAO_MAX_REVIEW_ROUNDS`（默认 4）只是硬止损，不是正常的收场方式。走到这一步，说明双方每一轮都在提新的阻塞性异议、也在真的回应——那时才按"到顶了仍有未解决的阻塞性异议"升级。
- 以下五种情况一律记为"需要人工介入"，**绝不当作通过**：没有其他可用 Agent 可以审核；审核 run 结束却没有调用 `submit_review`；审核 run 失败或审核者中途不可用；同一条异议连续多轮没有进展（`deadlock`）；到达硬止损轮数时仍有未解决的阻塞性异议（`max-rounds`）。另有一种是主动去问，而不是卡住了才问：审核者提出只有人能拍板的 question，或作者自己调 `request_clarification`——首轮的澄清，以及协商轮里作者发现"这条只有人能定"时的澄清，都记为 `clarification-needed`。这些都会进入下面的统一待办。
- 整链取消会一并取消进行中的审核，标记为"已取消"而不是升级——那是人工动作，不是质量信号。
- 审核与协商 run 由平台发起，不占用每链 8 次运行的额度，也不增加 A2A 深度或乒乓计数；它们只受审核轮数约束。用户消息可指定三个 Agent，沿用 A2A 额度会随机撞限。
- A2A 协作产生的 run（depth ≥ 1）不进入审核门，只有用户直接发起的任务会。
- 用户插话不会新建 run，因此沿用当前这一轮所属任务的审核状态。
- `MAO_REVIEW_GATE=on`（或 `required`）恢复旧行为：用户发起的每个任务一律送审，包括一句"你好"。`MAO_REVIEW_GATE=off` 关闭审核，只用于演示和离线测试。

审核过程在 Thread 里完全可见：送审、异议、作者的自然回复和候选定稿都在同一条对话中（审核结论卡片画在哪一行见「对话视图」）。交付声明以 `deliverable.declared` 记录，审核结论以 `review.requested` / `review.submitted` / `review.rework` / `review.resolved` 事件记录（兼容性原因仍沿用 `review.rework` 事件名，界面语义是“继续协商”；`review.submitted` 带审核者自查的 `checks`）。

Agent 正在运行时，用户可以直接插话：消息会送进当前这一轮（Pi 在本轮工具调用结束、下一次模型请求之前收到），而不是排队等下一轮。只有用户消息可以插话；`post_message` 的 A2A 仍然走完整的排队与限额，协作链语义不变。运行时不支持插话时自动回退为排队。

消息可以附带图片。Pi 直接把图片交给模型；Codex CLI 不接受内联图片，因此改为在 prompt 里给出附件的绝对路径。图片保存在数据目录的 `attachments/`，事件日志里只记录引用。

## 计划模式

计划模式是一条流水线上的两道闸门：**同侪先评审，人类最后拍板**。在输入框点亮"计划模式"再发任务即可进入。

- **只读是构造出来的，不是约定出来的**：计划模式下的 run 一律以 `read-only` 执行，Pi 摘掉 `bash`/`edit`/`write`，Codex 的 sandbox 降为 `read-only`——哪怕这个 Agent 在花名册里是可写的。被要求出方案的 Agent 没有"顺手先改一点"这个选项。
- **忘了调工具也算方案**：除正式调用 `request_clarification` 的澄清轮外，计划模式的 run 必定进审核门，走 `critique`；即使 Agent 没调 `submit_plan`，它也不会被当成闲聊放过去。反过来，计划模式下调 `complete_task` 会被拒绝——什么都还没做，谈不上完成。
- **澄清优先于计划门**：计划模式下如果 Agent 正式调用 `request_clarification` 且没有声明交付物，本轮只等待人类补充，不会把带着未决问题的草案送审，也不会出现计划审批卡；收到回答后再形成可直接执行的计划并调用 `submit_plan`。计划模式的 run 本来就是只读的，所以这里不存在"已经写过所以不能问"的情况——那条限制只对首轮的可写 run 生效。
- **同侪评审照旧**：`critique` 与普通审核共用一套协商机器和轮数上限，审核者仍是独立的怀疑者，`changes-requested` 会让作者回应异议并给出下一版完整方案。**协商轮依然是计划**：作者可以修改、举证反驳或提出替代方案，但 run 仍然只读、仍然是计划模式，不会借讨论之名开始实现。
- **同侪意见不等于放行**：评审结束（无论 `approved` 还是升级）后，平台记录 `plan.awaiting-approval` 并**停在这里**，不排任何 run。同侪给建议，人拍板。评审没通过的方案也照样送到人面前，并附上审核者的疑虑和升级原因——需要人判断的时刻，正是最不该把方案丢掉的时刻。
- **人类的两个选择**：
  - **通过并执行**：以人类消息的形式把定稿方案回送给作者，恢复其原本的写权限开始执行；这一轮按普通任务处理，交付时走 `verify` 核对。批注可留空。
  - **打回重做**：必须写明要改什么——不说理由的打回只会让下一轮重复上一轮。打回同样以人类消息回送，仍然是只读的计划模式，修订后再次评审、再次送到人面前。
- 决定先于派发落盘：`plan.decided` 在后续消息创建之前记录，进程在两者之间崩溃也不会让一个已经拍过板的方案看起来还在等人。同一个方案只能拍板一次。
- 关掉审核门（`MAO_REVIEW_GATE=off`）撤掉的是同侪，不是人：计划模式下的方案仍然停在人这里，`peerOutcome` 记为 `skipped`，界面上明说"没有同伴评审"。
- 计划模式的消息不会插话进正在运行的 run——插话进的那一轮是可写的，模式和权限都改不了，所以它总是另起一轮只读的 run。

整个过程在 Thread 里可见：`plan.awaiting-approval` / `plan.decided` 事件，界面上是方案原文加通过/打回按钮的确认卡片——看不到的方案谈不上批准。

### 业界先例：方案的"读过什么"也是方案的一部分

一个方案值不值得建，一半看它自己论证得怎么样，另一半看它有没有对照过别人已经解决过的同一个问题。这一层对齐 clowder 的调研车道（`deep-research` / `open-source-teardown` / `source-audit`），但**平台不判定哪个方案该查业界**——它读不到那个意图，硬猜出来的期待正是 clowder 筛子 0 警告的"给一个以为自己没这工具的猫弹提示"。平台管的是另外两件事：交出来的先例必须可核验，以及**查没查都要留痕**。

- **计划模式的 Agent 多一个 `record_prior_art` 工具**。每条记录写清四件事：`source`（看的是哪个仓库/文档/论文/路径）、`sourceKind`（看到了多深）、`claim`（它到底怎么做的，写成一句能被证伪的话）、`verdict`（`adopt` 照做 / `adapt` 改造后采用 / `reject` 不跟）。这是台账，不是一段自信的综述——同侪可以一条一条核，而不是重新调研一遍。
- **`adopt` 要有一手证据**。`sourceKind` 只有 `source`（读了实现）和 `docs`（读了官方文档/论文正文）才允许 `adopt`；只看了 `marketing`（README、落地页、发布稿）或 `secondhand`（别人的转述、自己的印象）就想照做，平台直接拒收，并提示改记成 `adapt` / `reject` 并写明取舍——这正是 clowder teardown 的铁律"不许只看 README 下判断"。`adopt` 还必须填 `checked`：读了哪个文件、跑了什么命令。这跟本项目要求审核者 `approved` 必须列出自查动作是同一条口径——**举证责任落在那个错了代价更大的判断上，保守的那一档永远不该更费力**。
- **不跟也要说理由**。`adapt` 和 `reject` 必须填 `tradeoff`。不写理由的"不跟"教不会下一轮任何事，同一个先例下轮还会被重新提出来——和"打回方案必须写明要改什么"是同一个道理。
- **三态留痕，沉默是唯一交代不过去的答案**。`recorded`（查了）/ `abstained`（明说没查，并给出理由：没有可比先例、这一轮够不着任何来源、改动太局部）/ `none`（什么都没说）。`abstained` 是一等公民而不是缺省值，因为 clowder 筛子 0 那条教训是——"一个你以为够不着的能力，miss 不是因为懒，是从没进考虑"。得让"够不着"能被便宜地说出口，它才不会伪装成沉默。
- **留痕不拦路**。没记台账的方案照样送到同侪、照样送到人面前；变的是评审简报和审批卡片上会明写"未记录业界先例——这个方案没有对照过别人怎么解决，也没有说明为什么不用对照"。同侪拿到的是三态里的哪一态就按哪一态压：查了就抽查它最吃重的那几条，弃权就先判理由成不成立，什么都没说就把"这个设计是自然而然的"当成未论证的断言。
- **台账挂在任务上，不挂在这一轮 run 上**。协商轮改方案不等于把读过的东西忘了；同一个 `source` 再记一次是修正上一轮的结论，不是并排堆两条。一旦有任何一轮记了实打实的先例，之前的 `abstained` 就不再成立，卡片上不会再显示"没查"。
- 记录以 `prior-art.recorded` 事件落盘，随 `plan.awaiting-approval` 一起进审批卡片；重启回放重建出来的是同一份台账。

**和 clowder 的差距**：clowder 的调研是真的会出去查——三路 Deep Research 并行加云端模型审阅（`deep-research`），拆解明星项目时要 clone 下来追到代码路径、记 commit SHA、做算法剥皮表（`open-source-teardown`）。本项目没有这套管线，也没有跨 Thread 的证据索引来复用往次调研；能查多深完全取决于这只 Agent 自己的 harness 够得到什么。所以这里落的是**契约层不是执行层**：平台规定什么样的先例算数、什么样的结论必须留证据，具体去哪儿查、查得动查不动，由 Agent 自己交代。

## 对话视图：跟随和落点

界面读的是同一份事件投影，但**显示位置**是单独的一层判断——投影说这条状态属于谁，不等于它该画在哪一行。

- **审核结论跟着最新一轮走**：`review` 状态归属被审核的那次交付（`applyReviewEvent` 挂在 taskRunId 上），这一点不变；但卡片渲染在这条审核链**最新一次审核运行**下面，也就是审核者自己那条消息里。否则谈了三轮，三轮结论全部堆在任务的第一条 Agent 回复底下，越审离视线越远。交付那一侧留一行去向（"X 的核对结论见下方第 N 轮"），"送审了没有"不会在原地消失。还没有审核运行时（`review.requested` 刚落库）卡片留在交付本身，等待状态不会凭空消失；升级到人工裁决的仍然统一收进对话末尾的「需要你处理」，不在正文里重复一份。
- **滚动跟随是有条件的**：只有当用户本来就贴着底部（距底 64px 以内）时，新内容才把视图带到底部。往上翻一行就被拽回去，等于流式输出期间没法读前面的内容。翻上去之后底部出现「回到最新」，点一下重新贴回；换任务、新建任务、自己发出一条消息都会重新贴回底部。

## 统一待办：人工介入的唯一入口

球交回给人以后，问题不是"人会不会拍板"，而是"人看不看得见"。审批卡片留在它自己的 Thread 里，人在别的任务里就永远发现不了它——这正是 clowder Approval Hub 要解决的事，本项目按同样的口径落成一层跨 Thread 的待办索引（顶栏"待我处理"，带计数徽标）。

- **一个索引收齐所有人工闸门**：方案待拍板（`plan-approval`）、审核升级需裁决（`review-escalation`）、Agent 等你补充信息（`clarification`）、执行链失败后无人接手（`runtime-failure`）。这四种正好是 `ball.handed_user` 已有的四个 reason——球没有交给人的，就不是人工闸门，索引因此天然完整。
- **它是投影，不是第二份状态**：待办从同一份 append-only 事件日志重建（`src/core/approval-index.ts`），平台、HTTP 接口和界面读的是同一批驱动了执行的事实，条目不会和它代表的闸门漂移，重启后也不需要回填。
- **双锚点：去哪儿处理，和它是被什么触发的**。每条待办同时带"审批卡位置"和"触发原文"。查不到原文消息时（例如日志被截断），条目明确标成**事件来源**，而不是给一个只会跳到 Thread 顶部、却假装是原文的链接。
- **过期不等于自动拒绝**：超过 `MAO_APPROVAL_STALE_HOURS`（默认 24 小时）的待办标为"上下文可能已过期"，提醒你它可能需要刷新——但它仍然是未答复，不是被拒绝。没有任何东西会替人做决定。
- **结清方式按闸门形状区分**：方案是二选一的决定，只有 `plan.decided` 能消费它，人在 Thread 里随口说句话不算拍板；另外三种要的是人的注意力，人在该 Thread 里的下一条消息就把球还给了 Agent，条目随之结清。整链取消会一并结清它挂着的待办——取消是人的动作，不是没人答复。
- **就地处理是有条件的**：只有二选一且正文齐备的方案卡才允许在待办里直接拍板；其余一律跳转到卡片本身——回答它所需要的上下文在那里，不在列表里。

## 会话、并发与恢复

- 每个 `{threadId, agentId}` 都有独立的持久 session。
- Pi session 位于 `.data/runtime-sessions/pi/...`；Codex 保存 `codex exec --json` 返回的 Thread ID，并使用 `codex exec resume` 续接。
- 新 Agent 首次进入 Thread 时注入最近 20 条、最多 24,000 字符的共享上下文；后续只交付尚未看到的消息。
- 同一个 Agent 同时只运行一个 session。
- `read-only` Agent 最多四个并行；可写 Agent 按规范化工作目录互斥。同目录写入串行，不同目录可并行。
- 重启后恢复尚未开始的 queued run；上次进程里已 running 的 run 标记为 `interrupted`，不会自动重试可能产生副作用的调用。排队中的审核会照常继续；上次进程里正在运行的审核标记为中断并升级给用户，不会重跑。
- 旧事件日志里没有审核事件，回放时不会给历史任务补发审核；没有 `reviewType` 的历史审核按 `verify` 回放，没有 `checks` 的历史审核结论原样回放，不会被追认为无效。

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

其中 `config.env` 保存密钥，`data/` 保存 Agent 花名册、事件和 session，`desktop.log` 用于排查启动问题，`graphics-mode.json` 记录本机可用的图形模式。不要把 `config.env` 发给别人或提交到 Git。

Windows 旧版曾错误地把这些文件放在 `%APPDATA%\multi-agent-pi-mvp\`。新版首次启动时会把旧配置、数据和日志复制到正确目录；已存在的新目录内容不会被覆盖，旧目录也会保留以便恢复。

Windows 版运行时会在通知区域保留图标，以便重新打开窗口、在默认浏览器中打开、查看配置或日志以及退出应用。关闭窗口只会隐藏到通知区域，不会停止本地服务；要完全退出，请右键通知区域图标并选择“退出”。

### 启动闪退或黑屏（GPU 进程报错）

少数 Windows 机器上，Chromium 的 GPU 进程会在第一帧之前被显卡驱动或安全软件结束，双击快捷方式后窗口一闪而过，命令行里是这样的日志：

```
ERROR:gpu_process_host.cc GPU process exited unexpectedly: exit_code=-2147483645
FATAL:gpu_data_manager_impl_private.cc GPU process isn't usable. Goodbye.
```

这种情况由应用自己处理，用户不需要改用命令行启动，继续双击快捷方式即可：

1. 每次启动会先把本次使用的图形模式写进 `graphics-mode.json`，窗口显示出来后才标记为“已验证”。
2. GPU 进程崩溃时应用会自动重启一次，降到下一档模式；如果连重启的机会都没有（进程被直接结束），下一次双击快捷方式会读到未验证的记录并自动降档。三档依次是：
   - `hardware`：默认，保留硬件加速，绝大多数机器一直停在这一档；
   - `software`：`--disable-gpu --disable-gpu-compositing --disable-gpu-sandbox --in-process-gpu`；
   - `compatibility`：在上一档基础上再加 `--no-sandbox`。
3. 可用的模式会被记住，之后每次启动都直接使用它，不会再闪退，也不会反复重启。

正常机器不受影响：窗口成功显示过一次，就一直停留在硬件加速。

更新显卡驱动后想恢复硬件加速，或者画面显示异常想手动切到软件渲染，可以在菜单 **配置 → 图形兼容模式** 点击切换（Windows 也可以右键通知区域图标），应用会重启并记住新的选择。临时覆盖（不写入记录）用命令行参数或环境变量：

```
Multi-Agent-Office.exe --graphics-mode=hardware
Multi-Agent-Office.exe --graphics-mode=software
Multi-Agent-Office.exe --safe-graphics      # 等价于 --graphics-mode=compatibility
```

```dotenv
MAO_GRAPHICS_MODE=compatibility
```

降级和重启的原因都会写进 `desktop.log`，排查时可以从菜单里的“打开运行日志”查看。

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

走一遍计划模式的完整流水线（出方案 → 同侪评审 → 人工拍板 → 执行），`--reject` 改为打回重做：

```bash
pnpm demo -- --plan
pnpm demo -- --plan --reject
```

## 本地 API

- `GET /api/agents`：安全花名册、revision、运行时在线/认证状态。
- `PUT /api/agents`：用 revision 乐观锁原子替换花名册；不接受或返回密钥。
- `POST /api/messages`：接收 `content`、可选 `threadId`、新 Thread 的 `workspacePath`、`attachments`（PNG/JPEG/WebP/GIF，最多 4 张、每张 5 MB）、`steer`、`planMode` 和 `routingMode`（`serial` / `parallel`，默认串行）。
- `GET /api/approvals?threadId=`：跨 Thread 的统一待办索引；省略 `threadId` 时返回所有等待人工处理的闸门。
- `GET /api/plans?threadId=`：正在等待人工拍板的方案。
- `POST /api/plans/:taskRunId/decision`：人工拍板，接收 `decision`（`approved` / `rejected`）与 `note`；打回时 `note` 必填。
- `POST /api/chains/:chainId/cancel`：取消整条协作链。
- `GET /api/events`：SSE 事件投影。
- `GET /api/models`：Pi 可用的 provider 与模型目录，以及每个 provider 是否已配置凭据；不返回密钥。
- `POST /api/providers/credential`：为单个内置 provider 写入 API Key 并热更新 Pi 的凭据缓存；只接受本机同源请求，不返回密钥，有 Agent 在跑时返回 409。
- `GET /api/agents/:agentId/session?threadId=`：该 Agent 在此 Thread 的 session 统计。
- `POST /api/agents/:agentId/session?threadId=&action=compact|export&format=html|jsonl`：手动压缩上下文或导出 session。

Codex 通过 app-server 的原生动态 tool 暴露 `post_message`、`hold_ball`、`submit_review`、`request_clarification`、`record_prior_art`、`complete_task` 与 `submit_plan`，tool handler 在同一进程内直接调用平台能力，不再启动自建 MCP server，也不再经过本机 HTTP callback。Pi Agent 同样使用进程内 tool；所有路由、等待、澄清请求、verdict、checks、findings 与交付声明都直接交给平台校验。Codex 会话协议有独立版本标记，升级 tool contract 后不会误续接缺少新工具的旧会话。

## 验证

```bash
pnpm run check
pnpm test
pnpm build
```

`pnpm run check` 除了两个 TypeScript 工程，还跑一道 **lessons 闸门**（`pnpm run check:lessons`）：
这次改动碰了 `src/`、`test/` 或构建配置，[lessons/](lessons/) 的某一卷就必须多出一条变更日志条目。
这个项目踩过的坑和沉淀下来的规矩按维度分卷记在那里，只记判断不记流水账；
真的没有值得记的判断，就写一条 `### YYYY-MM-DD · 无教训 · <为什么>`——出口留着，
但要付一句话，否则"这次没有"和"忘了写"在记录上分不出来。判断逻辑在
`src/tools/lessons-guard.ts`（纯函数，有单元测试），git 那一侧在 `src/tools/lessons-check.ts`。
CI 在每个 PR 上跑同一道闸门（`.github/workflows/checks.yml`）。

先读 [lessons/rules.md](lessons/rules.md)，路由表在 [lessons/README.md](lessons/README.md)。
对 Agent 的完整约定见 [CLAUDE.md](CLAUDE.md)。

测试覆盖花名册、mention 解析、显式串行/并行路由、球权事件投影、`hold_ball` 唤醒、A2A、幂等与乒乓限制、读写调度、整链取消、上下文游标、业界先例台账的校验与三态留痕、session 隔离、Codex app-server 首次执行与 resume、原生动态 tool 调用、Pi 凭据判定、多 provider 凭据互不覆盖、Agent 头像标识去重、可观测性事件投影、运行中插话与回退、图片附件、现有历史事件的完整兼容回放，以及 lessons 闸门的裁决规则（哪些路径算欠教训、无教训记录的理由长度下限、只往规矩卷里加不算数、分卷骨架校验）。

审核相关覆盖：强制送审与审核者选取（配置优先、离线回退、同链共作者让位给未参与的同侪、无人可让时仍然送审并标记为不中立）、怀疑立场与平等协商（审核简报要求自己查一手材料、意见不是命令、作者可自然反驳、后续轮必须重新评价、`approved` 缺少自查项被拒、`changes-requested` 不要求自查项）、达成共识后终结、存在异议时继续协商、硬止损轮数用尽仍有阻塞性异议时交给人类裁决、无结论/无审核者/审核失败一律不通过、审核中取消、重启后中断的审核升级、审核 run 不占用链额度与深度、审核者不会变成 Thread 的默认应答者，以及旧日志回放不补发审核。smart 门另有覆盖：闲聊不送审、阻塞性问题先澄清且不送审、计划模式与强制门同样尊重澄清、协商时发现人类决策会终止审核循环、协商轮里作者已经改过文件仍可澄清（半成品不回送审核者）、首轮已经写过就不能再改口问人、声明完成走 verify 且证据进入审核简报、提交方案走 critique 且协商轮仍是 critique、改文件不声明也送审、只读运行与 shell 读命令不触发、审核者不能自我声明、声明不能改口径，以及带声明的日志回放。

异议分级与收敛判据覆盖：旧日志里的无严重度 finding 仍按阻塞回放（不会被追认成建议）、严重度决定是否卡住任务、`minor`-only 的 `changes-requested` 结成"带评论的共识"且建议不丢、放行的结论一样欠一条自查项、只有人能拍板的 question 立刻去问人而不烧轮数、换了内容的异议算推进因此讨论继续（旧的固定轮数会在这里叫人）、同一条异议连续两轮原地踏步判为 `deadlock` 并远早于硬止损、以及重启后回放的旧轮次照样计入停滞判断。

审核者路由与统一待办覆盖：模型家族解析、跨家族优先于同家族、链内独立性优先于跨家族、`peer-reviewer` 角色只在有人声明时生效、明确配置的审核者压过启发式（并如实记下 `same-family` 降级）、无可用同侪时不硬凑、降级原因写进事件与审核简报、同一任务多轮固定同一审核者；待办索引方面覆盖跨 Thread 汇总与按 Thread 过滤、人类回话结清注意力型闸门、方案只能由拍板消费、critique 升级只记一条（不与方案卡重复计数）、过期只标 stale 不自动拒绝、无消息锚点标为事件来源、整链取消一并结清。

计划模式覆盖：可写 Agent 在计划模式下仍以只读执行、计划模式拒绝 `complete_task`、不调 `submit_plan` 也走 critique、评审通过后停在人这里不排 run、通过后以普通可写 run 执行并走 verify、打回后仍是只读的计划返工、不写理由的打回被拒、同一方案只能拍板一次、评审升级与无审核者时方案照样送到人面前、关掉审核门后仍停在人这里、计划模式不插话、以及等待中与已拍板的方案在重启后分别恢复为待办与已办。

## 安全边界

Pi 的 `full` 模式会开放 Bash/edit/write，但 Pi SDK 本身不提供完整文件系统沙箱。只应在可信的本地工作目录或额外隔离环境中使用。Codex v1 即使配置 `full` 也只映射为 `workspace-write`，不会启用 `danger-full-access`。

工作目录里的 `.pi/extensions`、`.pi/skills`、`.pi/settings.json` 等项目级资源属于可执行代码，默认**不**加载。这与 pi 非交互模式的默认行为一致。已经用 `pi` 保存过信任决定的目录按该决定处理；其余目录需要显式开启：

```dotenv
MAO_PI_PROJECT_TRUST=always
```

只在你信任该仓库时才打开。用户级的 `~/.pi/agent/extensions` 与 `~/.agents/skills` 始终加载，它们属于你自己的配置。
