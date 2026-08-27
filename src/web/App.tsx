import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  Activity,
  ArrowRight,
  AtSign,
  Bot,
  Check,
  ChevronDown,
  CirclePlus,
  Clock3,
  Download,
  Eye,
  EyeOff,
  Folder,
  KeyRound,
  ListChecks,
  Menu,
  MessageSquare,
  Moon,
  PanelRight,
  Paperclip,
  Plus,
  RefreshCw,
  Save,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  API_PROVIDER_PRESETS,
  FEATURED_API_PROVIDERS,
  findApiProvider,
  type ApiProviderId,
} from "../config/provider-presets";
import {
  CUSTOM_PROVIDER_APIS,
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  DEFAULT_CUSTOM_MAX_TOKENS,
  customProviderEnvKey,
  type CustomProvider,
  type CustomProviderApi,
  type CustomProviderCatalogV1,
} from "../config/custom-providers";
import { agentAvatarTone, agentInitials } from "./agent-identity";
import type { A2ARoutingMode, CollaborationIntent } from "../core/collaboration";
import type {
  AccessMode,
  AgentCatalogV1,
  AgentDefinition,
  AgentSummary,
  PlanDecision,
  PlanPeerOutcome,
  ReviewEscalation,
  ReviewType,
  RunPurpose,
  StoredPlatformEvent,
  Thread,
  ThinkingLevel,
  ThreadMessageKind,
} from "../core/types";
import type { DesktopUpdateSnapshot } from "../desktop/update-contract";

interface WorkspaceSummary {
  name: string;
  path: string;
}

interface BootstrapData {
  setup: { required: boolean };
  catalog: AgentCatalogV1;
  agents: AgentSummary[];
  workspace: WorkspaceSummary;
  events: StoredPlatformEvent[];
  cursor?: string;
}

interface AgentsResponse {
  catalog: AgentCatalogV1;
  agents: AgentSummary[];
  error?: string;
}

interface ThreadSummary extends Thread {
  updatedAt: string;
  hasActiveRun: boolean;
}

type ViewRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

type TranscriptItem =
  | {
      id: string;
      type: "human";
      content: string;
      createdAt: string;
      targets: string[];
      explicitlyDirected: boolean;
    }
  | {
      id: string;
      type: "collaboration";
      agentId: string;
      content: string;
      mentions: string[];
      createdAt: string;
      kind: ThreadMessageKind;
      collaborationIntent?: CollaborationIntent;
      routingMode?: A2ARoutingMode;
    }
  | {
      id: string;
      type: "agent";
      agentId: string;
      content: string;
      createdAt: string;
      status: ViewRunStatus;
      thinking: string;
      tools: ToolActivity[];
      notices: string[];
      usage?: RunUsage;
      purpose: RunPurpose;
      reviewRound?: number;
      review?: ReviewState;
      /** Set on the plan task run this plan belongs to, across every round. */
      plan?: PlanState;
      /** True while this run itself was asked for a plan rather than the work. */
      planMode?: boolean;
      /** The incoming message is retained as a compact, human-readable reply relation. */
      replyToHuman?: boolean;
      replyToAgentId?: string;
      incomingKind?: ThreadMessageKind;
      clarification?: ClarificationRequest;
      routing?: { mode: A2ARoutingMode; index: number; total: number };
    };

interface ClarificationQuestion {
  question: string;
  options?: Array<{ label: string; value?: string; recommended?: boolean }>;
}
interface ClarificationRequest { runId: string; agentId: string; questions: Array<string | ClarificationQuestion>; }

interface ReviewState {
  status: "pending" | "approved" | "changes-requested" | "escalated" | "cancelled";
  reviewerAgentId?: string;
  reviewType?: ReviewType;
  round: number;
  summary?: string;
  findings?: string[];
  /** What the reviewer verified for itself. Present on approvals. */
  checks?: string[];
  escalation?: ReviewEscalation;
  detail?: string;
  /** Reviewer text recovered when the run ended without submit_review. */
  unstructured?: boolean;
}

interface PlanState {
  taskRunId: string;
  authorAgentId: string;
  plan: string;
  peerOutcome: PlanPeerOutcome;
  rounds: number;
  reviewerAgentId?: string;
  peerSummary?: string;
  escalation?: ReviewEscalation;
  /** Absent while the plan is still waiting on the human. */
  decision?: PlanDecision;
  note?: string;
}

interface ToolActivity {
  key: string;
  toolName: string;
  args?: string;
  resultSummary?: string;
  isError?: boolean;
  done: boolean;
}

interface RunUsage {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  contextTokens?: number;
  contextWindow?: number;
}

export function App() {
  const [data, setData] = useState<BootstrapData>();
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [search, setSearch] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceSummary>();
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [desktopUpdate, setDesktopUpdate] = useState<DesktopUpdateSnapshot>();
  const [updateActionRunning, setUpdateActionRunning] = useState(false);
  const [updateActionError, setUpdateActionError] = useState("");
  const [draft, setDraft] = useState("");
  const [planMode, setPlanMode] = useState(false);
  const [routingMode, setRoutingMode] = useState<A2ARoutingMode>("serial");
  const [decidingPlan, setDecidingPlan] = useState<string>();
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "reconnecting">("connecting");
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = window.localStorage.getItem("mao-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const conversationEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("mao-theme", theme);
  }, [theme]);

  useEffect(() => {
    const bridge = window.maoDesktop;
    if (!bridge) return;
    let disposed = false;
    void bridge.getUpdateState().then((snapshot) => {
      if (!disposed) setDesktopUpdate(snapshot);
    }).catch((error: unknown) => {
      if (!disposed) setUpdateActionError(errorMessage(error));
    });
    const unsubscribe = bridge.onUpdateState((snapshot) => {
      if (!disposed) setDesktopUpdate(snapshot);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    fetch("/api/bootstrap")
      .then(async (response) => {
        if (!response.ok) throw new Error("无法连接本地 Agent 服务");
        return response.json() as Promise<BootstrapData>;
      })
      .then((next) => {
        setData(next);
        const firstThread = buildThreads(next.events)[0];
        setSelectedThreadId(firstThread?.id);
        const firstPath = firstThread?.workingDirectory ?? next.workspace.path;
        setSelectedWorkspace({ name: workspaceName(firstPath), path: firstPath });
      })
      .catch((error: unknown) => setLoadError(errorMessage(error)));
  }, []);

  useEffect(() => {
    if (!data || data.setup.required) return;
    const suffix = data.cursor ? `?after=${encodeURIComponent(data.cursor)}` : "";
    const source = new EventSource(`/api/events${suffix}`);
    source.onopen = () => setConnectionState("connected");
    source.onerror = () => setConnectionState("reconnecting");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as StoredPlatformEvent;
      setData((current) => {
        if (!current || current.events.some((item) => item.eventId === event.eventId)) return current;
        return { ...current, events: [...current.events, event], cursor: event.eventId };
      });
    };
    return () => source.close();
  }, [Boolean(data), data?.setup.required]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setSelectedThreadId(undefined);
        setDraft("");
        setDrawerOpen(false);
      }
      if (event.key === "Escape") {
        setDrawerOpen(false);
        setSidebarOpen(false);
        setWorkspacePickerOpen(false);
        setCatalogOpen(false);
        setUpdateOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const threads = useMemo(() => buildThreads(data?.events ?? []), [data?.events]);
  const filteredThreads = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return needle ? threads.filter((thread) => thread.title.toLocaleLowerCase().includes(needle)) : threads;
  }, [search, threads]);
  const selectedThread = threads.find((thread) => thread.id === selectedThreadId);
  const activeWorkspace = useMemo(() => {
    const path = selectedThread?.workingDirectory ?? selectedWorkspace?.path ?? data?.workspace.path;
    return path ? { name: workspaceName(path), path } : undefined;
  }, [data?.workspace.path, selectedThread?.workingDirectory, selectedWorkspace]);
  const recentWorkspaces = useMemo(() => buildWorkspaceOptions(threads, data?.workspace), [threads, data?.workspace]);
  const transcript = useMemo(() => buildTranscript(data?.events ?? [], selectedThreadId), [data?.events, selectedThreadId]);
  const attentionRuns = useMemo(() => transcript.filter(isAttentionRun), [transcript]);
  const attentionKey = attentionRuns.map((item) => `${item.id}:${item.review?.status ?? ""}:${item.plan?.decision ?? "pending"}`).join("|");
  const activeChainId = useMemo(() => findActiveChain(data?.events ?? [], selectedThreadId), [data?.events, selectedThreadId]);
  const fallbackAgent = useMemo(
    () => findFallbackAgent(data?.agents ?? [], data?.catalog.defaultAgentId, data?.events ?? [], selectedThreadId),
    [data?.agents, data?.catalog.defaultAgentId, data?.events, selectedThreadId],
  );
  const onlineCount = data?.agents.filter((agent) => agent.enabled && agent.availability.available).length ?? 0;
  const configured = onlineCount > 0;

  const lastContent = transcript.at(-1)?.content ?? "";
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, lastContent, attentionKey]);

  const newTask = () => {
    setSelectedThreadId(undefined);
    setDraft("");
    setActionError("");
    setDrawerOpen(false);
    setSidebarOpen(false);
  };

  const sendTask = async (steer = false) => {
    const content = draft.trim();
    if (!content || sending || !configured) return;
    setSending(true);
    setActionError("");
    try {
      const response = await fetch("/api/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          content,
          ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
          ...(!selectedThreadId && activeWorkspace ? { workspacePath: activeWorkspace.path } : {}),
          ...(attachments.length > 0
            ? { attachments: attachments.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 })) }
            : {}),
          ...(steer ? { steer: true } : {}),
          ...(planMode ? { planMode: true } : {}),
          routingMode,
        }),
      });
      const result = (await response.json()) as { threadId?: string; error?: string };
      if (!response.ok || !result.threadId) throw new Error(result.error ?? "任务发送失败");
      setSelectedThreadId(result.threadId);
      setDraft("");
      setAttachments([]);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const answerClarification = async (request: ClarificationRequest, answers: string[]) => {
    if (sending || !selectedThreadId) return false;
    setSending(true);
    setActionError("");
    try {
      const content = `@${request.agentId} ` + answers.map((answer, index) => `第 ${index + 1} 题：${answer}`).join("\n");
      const response = await fetch("/api/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content, threadId: selectedThreadId }) });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "回复失败");
      return true;
    } catch (error) { setActionError(errorMessage(error)); return false; } finally { setSending(false); }
  };

  const decidePlan = async (taskRunId: string, decision: PlanDecision, note: string) => {
    if (decidingPlan) return;
    setDecidingPlan(taskRunId);
    setActionError("");
    try {
      const response = await fetch(`/api/plans/${encodeURIComponent(taskRunId)}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "计划确认失败");
      // Approving a plan means the building starts now, so the next message
      // the composer sends is ordinary work, not another planning round.
      if (decision === "approved") setPlanMode(false);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setDecidingPlan(undefined);
    }
  };

  const cancelTask = async () => {
    if (!activeChainId || cancelling) return;
    setCancelling(true);
    setActionError("");
    try {
      const response = await fetch(`/api/chains/${encodeURIComponent(activeChainId)}/cancel`, { method: "POST" });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "取消失败");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setCancelling(false);
    }
  };

  // Availability only; the catalog object stays identical so an open roster
  // editor does not reset the draft the user is still editing.
  const refreshAgents = (next: AgentSummary[]) => {
    setData((current) => current ? { ...current, agents: mergeHistoricalAgents(next, current.agents) } : current);
  };

  const saveCatalog = async (next: AgentCatalogV1) => {
    const response = await fetch("/api/agents", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    const result = (await response.json()) as AgentsResponse;
    if (!response.ok || !result.catalog) throw new Error(result.error ?? "花名册保存失败");
    setData((current) => current ? { ...current, catalog: result.catalog, agents: mergeHistoricalAgents(result.agents, current.agents) } : current);
  };

  const finishSetup = (next: BootstrapData) => {
    setData(next);
    const firstThread = buildThreads(next.events)[0];
    setSelectedThreadId(firstThread?.id);
    const firstPath = firstThread?.workingDirectory ?? next.workspace.path;
    setSelectedWorkspace({ name: workspaceName(firstPath), path: firstPath });
  };

  const performUpdateAction = async () => {
    const bridge = window.maoDesktop;
    if (!bridge || updateActionRunning) return;
    setUpdateActionRunning(true);
    setUpdateActionError("");
    try {
      setDesktopUpdate(await bridge.performUpdateAction());
    } catch (error) {
      setUpdateActionError(errorMessage(error));
    } finally {
      setUpdateActionRunning(false);
    }
  };

  if (data?.setup.required) {
    return <>
      <FirstRunSetup
        onComplete={finishSetup}
        onUpdate={() => { setUpdateActionError(""); setUpdateOpen(true); }}
        updateTitle={updateButtonTitle(desktopUpdate)}
      />
      <UpdateDialog open={updateOpen} snapshot={desktopUpdate} actionRunning={updateActionRunning} error={updateActionError} onClose={() => setUpdateOpen(false)} onAction={() => void performUpdateAction()} />
    </>;
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar--open" : ""}`}>
        <div className="brand-row"><div className="brand-mark"><Sparkles size={16} /></div><span className="brand-copy"><strong>Multi-Agent Office</strong><small>协作工作台</small></span></div>
        <button className="new-task-button" type="button" onClick={newTask}><CirclePlus size={17} />新建任务<span className="shortcut">⌘ N</span></button>
        <label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" /></label>
        <div className="sidebar-section-title"><span>任务</span><i>{filteredThreads.length}</i></div>
        <nav className="thread-list" aria-label="任务列表">
          {filteredThreads.map((thread) => (
            <button className={`thread-item ${thread.id === selectedThreadId ? "thread-item--active" : ""}`} type="button" key={thread.id} onClick={() => {
              setSelectedThreadId(thread.id);
              const path = thread.workingDirectory ?? data?.workspace.path;
              if (path) setSelectedWorkspace({ name: workspaceName(path), path });
              setDrawerOpen(false);
              setSidebarOpen(false);
            }}>
              <span className={`thread-status ${thread.hasActiveRun ? "thread-status--active" : ""}`} />
              <span className="thread-copy"><span className="thread-title">{cleanTitle(thread.title)}</span><span className="thread-time">{workspaceName(thread.workingDirectory ?? data?.workspace.path ?? "")}<i>·</i>{formatRelativeTime(thread.updatedAt)}</span></span>
            </button>
          ))}
          {filteredThreads.length === 0 && <p className="empty-sidebar">没有匹配的任务</p>}
        </nav>
        <div className="sidebar-footer">
          <button className="runtime-pill runtime-pill--button" type="button" onClick={() => setCatalogOpen(true)} title="管理 Agent 花名册">
            <span className={`runtime-dot ${onlineCount > 0 && connectionState === "connected" ? "runtime-dot--ready" : ""}`} />
            <span><strong>{onlineCount}/{data?.catalog.agents.length ?? 0} Agent 在线</strong><small>{connectionLabel(configured, connectionState)}</small></span>
          </button>
          <button className={`icon-button update-button update-button--${desktopUpdate?.state.phase ?? "browser"}`} type="button" onClick={() => { setUpdateActionError(""); setUpdateOpen(true); }} aria-label="检查应用更新" title={updateButtonTitle(desktopUpdate)}><RefreshCw size={16} /><span className="update-button-label">更新</span><i className="update-button-indicator" /></button>
          <button className="icon-button" type="button" onClick={() => setCatalogOpen(true)} aria-label="管理 Agent"><Settings2 size={17} /></button>
          <button className="icon-button" type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label="切换主题">{theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}</button>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭侧边栏" />}

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-menu" type="button" onClick={() => setSidebarOpen(true)} aria-label="打开侧边栏"><Menu size={19} /></button>
          <div className="topbar-title"><strong>{selectedThread ? cleanTitle(selectedThread.title) : "新任务"}</strong><div className="topbar-context">
            <button className="workspace-path" type="button" title="更换工作目录并开始新对话" onClick={() => setWorkspacePickerOpen(true)}><Folder size={10} />{activeWorkspace?.path ?? "正在读取工作目录"}</button>
            {activeChainId && <span className="topbar-running"><i />Agent 正在协作</span>}
          </div></div>
          <div className="topbar-actions">
            <div className="topbar-presence" aria-label={`${onlineCount} 个 Agent 在线`}>
              <span className="presence-avatars">{(data?.agents ?? []).filter((agent) => agent.enabled && agent.availability.available).slice(0, 3).map((agent) => <AgentAvatar agentId={agent.id} key={agent.id} />)}</span>
              <span className="presence-copy"><strong>{onlineCount} Agent</strong><small>{activeChainId ? "协作进行中" : "在线待命"}</small></span>
            </div>
            <button className={`details-button ${drawerOpen ? "details-button--active" : ""}`} type="button" onClick={() => setDrawerOpen(!drawerOpen)}><PanelRight size={16} />运行面板</button>
          </div>
        </header>

        <section className="conversation">
          {loadError ? <div className="state-card state-card--error">{loadError}</div> : !data ? <div className="loading-state"><span />正在载入工作区…</div> : transcript.length > 0 ? (
            <div className="transcript">
              <div className="conversation-intro"><div className="intro-icon"><Bot size={18} /></div><div className="intro-copy"><strong>协作记录</strong><span>{transcript.filter((item) => item.type === "agent").length} 次 Agent 运行 · {transcript.filter((item) => item.type === "human").length} 条任务指令</span></div>{activeChainId ? <span className="live-indicator"><i />实时运行中</span> : <span className="conversation-state"><Check size={12} />已同步</span>}</div>
              {transcript.map((item) => {
                if (item.type === "human") return (
                  <article className="human-message" key={item.id}>
                    <div className="human-message-bubble">
                      <div className="message-route message-route--human">
                        <strong>你</strong><ArrowRight size={12} />
                        {item.targets.length > 0 ? item.targets.map((id) => <AgentRouteChip agentId={id} agents={data.agents} key={id} />) : <span className="route-fallback">自动选择 Agent</span>}
                        {item.explicitlyDirected && <small>已指定</small>}
                      </div>
                      <div className="human-message-content">{item.content}</div>
                    </div>
                  </article>
                );
                if (item.type === "collaboration") return (
                  <article className="collaboration-message" key={item.id}>
                    <div className="collaboration-meta"><AgentRouteChip agentId={item.agentId} agents={data.agents} /><ArrowRight size={13} />{item.mentions.map((id) => <AgentRouteChip agentId={id} agents={data.agents} key={id} />)}<strong>{collaborationProtocolLabel(item)}</strong></div>
                    <p className="collaboration-preview">{compactMessagePreview(item.content)}</p>
                    {item.content.length > 180 && <details className="collaboration-details"><summary>查看完整转交内容</summary><div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown></div></details>}
                  </article>
                );
                const agent = data.agents.find((candidate) => candidate.id === item.agentId);
                const name = agentName(data.agents, item.agentId);
                const runtime = runtimeDetail(agent, name);
                const reviewNeedsAttention = item.review?.status === "escalated" && !item.plan?.decision;
                const planNeedsAttention = Boolean(item.plan && !item.plan.decision);
                return (
                  <article className={`agent-message ${item.replyToAgentId ? "agent-message--peer-reply" : ""}`} key={item.id}>
                    <div className="agent-message-meta"><AgentAvatar agentId={item.agentId} variant={item.purpose === "review" ? "reviewer" : undefined} /><span>{name}</span>{runtime && <small>{runtime}</small>}<span className="agent-reply-context"><ArrowRight size={11} />{agentReplyLabel(item, data.agents)}</span>{item.routing && item.routing.total > 1 && <span className="status-label status-label--routing">{item.routing.mode === "parallel" ? "并行" : "串行"} · {item.routing.index}/{item.routing.total}</span>}{item.purpose === "review" && <span className="status-label status-label--review">审核 · 第 {item.reviewRound ?? 1} 轮</span>}{item.planMode && <span className="status-label status-label--plan"><ListChecks size={11} />计划模式</span>}<span className={`status-label status-label--${item.status}`}>{statusLabel(item.status, agent?.accessMode)}</span></div>
                    <RunActivity item={item} />
                    <div className={`markdown-body ${item.status === "running" ? "markdown-body--streaming" : ""}`}>{item.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown> : <div className="thinking-line"><span /><span /><span /></div>}</div>
                    {item.usage && <RunUsageBar usage={item.usage} />}
                    {item.clarification && <ClarificationCard request={item.clarification} busy={sending} onSubmit={(answers) => answerClarification(item.clarification!, answers)} />}
                    {item.review && !reviewNeedsAttention && <ReviewCard review={item.review} agents={data.agents} />}
                    {item.plan && !planNeedsAttention && <PlanCard plan={item.plan} agents={data.agents} busy={decidingPlan === item.plan.taskRunId} onDecide={decidePlan} />}
                  </article>
                );
              })}
              {attentionRuns.length > 0 && (
                <section className="thread-attention" aria-labelledby="thread-attention-title">
                  <div className="thread-attention-title">
                    <ShieldCheck size={15} />
                    <div><strong id="thread-attention-title">需要你处理</strong><span>计划确认和人工介入事项始终显示在最新消息之后</span></div>
                  </div>
                  {attentionRuns.map((item) => (
                    <div className="thread-attention-item" key={`attention-${item.id}`}>
                      {item.review?.status === "escalated" && <ReviewCard review={item.review} agents={data.agents} />}
                      {item.plan && !item.plan.decision && <PlanCard plan={item.plan} agents={data.agents} busy={decidingPlan === item.plan.taskRunId} onDecide={decidePlan} />}
                    </div>
                  ))}
                </section>
              )}
              <div ref={conversationEndRef} />
            </div>
          ) : <EmptyTask agents={data.agents} onSuggestion={setDraft} />}
        </section>

        {actionError && <div className="action-error" role="alert"><XCircle size={14} />{actionError}<button type="button" onClick={() => setActionError("")} aria-label="关闭错误"><X size={13} /></button></div>}
        <Composer planMode={planMode} onPlanModeChange={setPlanMode} routingMode={routingMode} onRoutingModeChange={setRoutingMode} agents={data?.agents ?? []} fallbackAgent={fallbackAgent} configured={configured} value={draft} onChange={setDraft} onSend={sendTask} onCancel={cancelTask} attachments={attachments} onAttachmentsChange={setAttachments} sending={sending} cancelling={cancelling} active={Boolean(activeChainId)} workspace={activeWorkspace} onWorkspaceClick={() => setWorkspacePickerOpen(true)} />
      </main>

      <DetailsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} thread={selectedThread} agents={data?.agents ?? []} workspace={activeWorkspace} events={data?.events ?? []} />
      <WorkspacePicker open={workspacePickerOpen} current={activeWorkspace} recent={recentWorkspaces} onClose={() => setWorkspacePickerOpen(false)} onSelect={(workspace) => { setSelectedWorkspace(workspace); setSelectedThreadId(undefined); setDrawerOpen(false); setSidebarOpen(false); setWorkspacePickerOpen(false); }} />
      {data && <AgentCatalogEditor open={catalogOpen} catalog={data.catalog} agents={data.agents} onClose={() => setCatalogOpen(false)} onSave={saveCatalog} onAgentsRefreshed={refreshAgents} />}
      <UpdateDialog open={updateOpen} snapshot={desktopUpdate} actionRunning={updateActionRunning} error={updateActionError} onClose={() => setUpdateOpen(false)} onAction={() => void performUpdateAction()} />
    </div>
  );
}

function FirstRunSetup({ onComplete, onUpdate, updateTitle }: { onComplete(data: BootstrapData): void; onUpdate(): void; updateTitle: string }) {
  const [provider, setProvider] = useState<ApiProviderId>("zai-coding-cn");
  const [apiKey, setApiKey] = useState("");
  const [useCodex, setUseCodex] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [showAllProviders, setShowAllProviders] = useState(false);
  const selectedProvider = API_PROVIDER_PRESETS.find((item) => item.id === provider)!;
  // The common providers fit on the page; the rest are one click away rather
  // than absent, so a Kimi or MiniMax user is not stuck editing a config file.
  const offered = showAllProviders ? API_PROVIDER_PRESETS : FEATURED_API_PROVIDERS;

  const submit = async () => {
    if (saving || apiKey.trim().length < 8) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim(), useCodex }),
      });
      const result = (await response.json()) as BootstrapData & { error?: string };
      if (!response.ok || result.setup?.required) {
        throw new Error(result.error ?? "配置保存失败");
      }
      setApiKey("");
      onComplete(result);
    } catch (setupError) {
      setError(errorMessage(setupError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="setup-screen">
      <section className="setup-card" aria-labelledby="setup-title">
        <header className="setup-header">
          <div className="setup-logo"><Sparkles size={24} /></div>
          <span>Multi-Agent Office</span>
          <p>首次启动设置</p>
          <button className="setup-update-button" type="button" onClick={onUpdate} title={updateTitle}><RefreshCw size={14} />检查更新</button>
        </header>

        <div className="setup-copy">
          <span className="setup-step">1 / 1</span>
          <h1 id="setup-title">连接你的 AI 模型</h1>
          <p>输入一个 API Key 即可开始使用，无需再修改配置文件。</p>
        </div>

        <form className="setup-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <fieldset>
            <legend>API 提供商</legend>
            <div className={`provider-grid ${showAllProviders ? "provider-grid--all" : ""}`}>
              {offered.map((item) => (
                <button
                  className={`provider-option ${provider === item.id ? "provider-option--selected" : ""}`}
                  type="button"
                  key={item.id}
                  onClick={() => setProvider(item.id as ApiProviderId)}
                  aria-pressed={provider === item.id}
                >
                  <span>{item.label}</span>
                  {provider === item.id && <Check size={14} />}
                </button>
              ))}
            </div>
            <button className="provider-more" type="button" onClick={() => setShowAllProviders((current) => !current)} aria-expanded={showAllProviders}>
              {showAllProviders ? "只看常用提供商" : `更多提供商（共 ${API_PROVIDER_PRESETS.length} 个）`}<ChevronDown size={13} className={showAllProviders ? "custom-provider-caret--open" : undefined} />
            </button>
            <p className="provider-description">{selectedProvider.description} · 默认模型 {selectedProvider.model}</p>
            <p className="provider-description">第三方或自建部署的模型可以在进入工作台后，于 Agent 花名册里添加。</p>
          </fieldset>

          <label className="setup-key-label" htmlFor="setup-api-key">API Key</label>
          <div className="setup-key-input">
            <KeyRound size={17} />
            <input
              id="setup-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={selectedProvider.keyPlaceholder}
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
            <button type="button" onClick={() => setShowKey((current) => !current)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}>
              {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="setup-security"><ShieldCheck size={13} />密钥只保存在这台电脑的用户数据目录中，不会显示在花名册或 API 响应里。</p>

          <fieldset>
            <legend>运行方式</legend>
            <div className="runtime-choice-grid">
              <button className={`runtime-choice ${!useCodex ? "runtime-choice--selected" : ""}`} type="button" onClick={() => setUseCodex(false)} aria-pressed={!useCodex}>
                <span className="runtime-choice-icon"><KeyRound size={18} /></span>
                <span><strong>仅使用 API</strong><small>无需安装 Codex，推荐</small></span>
                {!useCodex && <Check size={15} />}
              </button>
              <button className={`runtime-choice ${useCodex ? "runtime-choice--selected" : ""}`} type="button" onClick={() => setUseCodex(true)} aria-pressed={useCodex}>
                <span className="runtime-choice-icon"><Terminal size={18} /></span>
                <span><strong>API + Codex</strong><small>同时启用本机 Codex CLI</small></span>
                {useCodex && <Check size={15} />}
              </button>
            </div>
            {useCodex && <p className="codex-note">Codex 需要已在本机安装并登录；未就绪时仍可先使用 API Agent。</p>}
          </fieldset>

          {error && <div className="setup-error" role="alert"><XCircle size={14} />{error}</div>}
          <button className="setup-submit" type="submit" disabled={saving || apiKey.trim().length < 8}>
            {saving ? <><span className="button-spinner" />正在安全保存…</> : <>保存并进入工作台<ArrowRight size={16} /></>}
          </button>
        </form>
      </section>
    </main>
  );
}

function SearchIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>;
}

interface UpdateDialogProps {
  open: boolean;
  snapshot?: DesktopUpdateSnapshot;
  actionRunning: boolean;
  error: string;
  onClose(): void;
  onAction(): void;
}

function UpdateDialog({ open, snapshot, actionRunning, error, onClose, onAction }: UpdateDialogProps) {
  if (!open) return null;
  const phase = snapshot?.state.phase ?? "browser";
  const supported = snapshot?.supported ?? false;
  const actionAvailable = supported || Boolean(snapshot?.manualDownloadUrl);
  const busy = actionRunning || phase === "checking" || phase === "downloading";
  const status = updateStatusCopy(snapshot);
  return <div className="update-dialog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
    <header><div><strong id="update-dialog-title">应用更新</strong><span>{snapshot ? `${desktopPlatformLabel(snapshot.platform)} · ${snapshot.packaged ? "桌面安装版" : "桌面开发模式"}` : "浏览器模式"}</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭更新窗口"><X size={18} /></button></header>
    <div className="update-dialog-body">
      <div className={`update-hero update-hero--${phase}`}><span className="update-hero-icon">{phase === "available" || phase === "downloading" ? <Download size={23} /> : phase === "downloaded" ? <Check size={23} /> : <RefreshCw className={busy ? "update-spin" : ""} size={23} />}</span><div><strong>{status.title}</strong><p>{status.detail}</p></div></div>
      {snapshot && <div className="update-version-grid"><div><span>当前版本</span><strong>v{snapshot.state.currentVersion}</strong></div><div><span>最新版本</span><strong>{snapshot.state.latestVersion ? `v${snapshot.state.latestVersion}` : "检查后显示"}</strong></div></div>}
      {phase === "downloading" && <div className="update-progress" aria-label={`下载进度 ${Math.round(snapshot?.state.percent ?? 0)}%`}><span style={{ width: `${Math.round(snapshot?.state.percent ?? 0)}%` }} /></div>}
      {(error || snapshot?.state.error) && <div className="update-inline-error"><XCircle size={14} />{error || snapshot?.state.error}</div>}
      <p className="update-note">{updateNote(snapshot)}</p>
    </div>
    <footer><button className="update-secondary" type="button" onClick={onClose}>{phase === "downloaded" ? "稍后安装" : "关闭"}</button><button className="update-primary" type="button" onClick={onAction} disabled={!actionAvailable || busy}>{updateActionLabel(snapshot, actionRunning)}</button></footer>
  </section></div>;
}

function updateStatusCopy(snapshot?: DesktopUpdateSnapshot): { title: string; detail: string } {
  if (!snapshot) return { title: "浏览器界面无需单独更新", detail: "此页面与桌面安装版使用同一套界面；桌面程序的版本更新请在安装版中执行。" };
  if (!snapshot.supported) {
    if (snapshot.supportReason === "unsigned-macos") {
      return { title: "此 macOS 版本需要手动更新", detail: "当前安装包没有有效的 Developer ID 签名。请手动安装下一版已签名安装包，之后即可使用应用内自动更新。" };
    }
    if (snapshot.supportReason === "unsupported-platform") {
      return { title: "当前系统需要手动更新", detail: "请从 GitHub Releases 下载适合当前系统的最新安装包。" };
    }
    return snapshot.packaged
      ? { title: "当前安装包未启用更新通道", detail: "请使用 GitHub Release 中的 Windows 或 macOS 正式安装包。" }
      : { title: "桌面开发模式", detail: "界面与正式安装版一致，但源码模式不会连接发布更新服务。" };
  }
  switch (snapshot.state.phase) {
    case "checking": return { title: "正在检查更新", detail: "正在连接 GitHub Release 更新通道…" };
    case "available": return { title: `发现新版本 v${snapshot.state.latestVersion ?? ""}`, detail: "可以直接在应用内下载，无需前往浏览器下载安装包。" };
    case "downloading": return { title: `正在下载 ${Math.round(snapshot.state.percent ?? 0)}%`, detail: `v${snapshot.state.latestVersion ?? ""} 下载完成后即可重启安装。` };
    case "downloaded": return { title: `v${snapshot.state.latestVersion ?? ""} 已准备好`, detail: "点击重启安装；选择稍后时，会在退出应用时自动安装。" };
    case "error": return { title: "更新检查失败", detail: "可以稍后重试，详细错误也已写入桌面运行日志。" };
    case "idle": return { title: "检查 Multi-Agent Office 更新", detail: "点击下方按钮检查 GitHub Release 中是否有新版本。" };
  }
}

function updateActionLabel(snapshot: DesktopUpdateSnapshot | undefined, running: boolean): string {
  if (running) return "正在处理…";
  if (!snapshot?.supported) return snapshot?.manualDownloadUrl ? "打开下载页" : "当前无需操作";
  switch (snapshot.state.phase) {
    case "checking": return "正在检查…";
    case "available": return "下载更新";
    case "downloading": return `正在下载 ${Math.round(snapshot.state.percent ?? 0)}%`;
    case "downloaded": return "重启并安装";
    case "error": return "重新检查";
    case "idle": return "检查更新";
  }
}

function updateButtonTitle(snapshot?: DesktopUpdateSnapshot): string {
  if (snapshot?.supportReason === "unsigned-macos") return "此版本需要手动更新";
  if (snapshot?.state.phase === "available") return `发现新版本 v${snapshot.state.latestVersion ?? ""}`;
  if (snapshot?.state.phase === "downloading") return `正在下载更新 ${Math.round(snapshot.state.percent ?? 0)}%`;
  if (snapshot?.state.phase === "downloaded") return `v${snapshot.state.latestVersion ?? ""} 等待安装`;
  return "检查应用更新";
}

function updateNote(snapshot?: DesktopUpdateSnapshot): string {
  if (snapshot?.supportReason === "unsigned-macos") {
    return "从未签名版本迁移到正式签名更新通道需要手动安装一次。此操作不会覆盖本地配置、Agent 或任务记录。";
  }
  if (snapshot?.supported) {
    return "桌面安装版会在启动 30 秒后自动检查，此后每 6 小时检查一次。更新不会覆盖本地配置、Agent 或任务记录。";
  }
  return "下载并安装新版本不会覆盖用户目录中的配置、Agent 或任务记录。";
}

function desktopPlatformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function EmptyTask({ agents, onSuggestion }: { agents: AgentSummary[]; onSuggestion(value: string): void }) {
  const enabled = agents.filter((agent) => agent.enabled);
  const ready = enabled.filter((agent) => agent.availability.available);
  const handles = enabled.slice(0, 2).map((agent) => `@${agent.id}`);
  const directedPrompt = handles.length > 1
    ? `${handles.join(" ")} 请分别评估当前架构，并给出各自的改进建议。`
    : `${handles[0] ?? ""} 请评估当前架构，并给出改进建议。`.trim();
  return <div className="empty-task"><div className="empty-task-mark"><Sparkles size={24} /></div><span className="empty-task-eyebrow">开启新的协作</span><h1>把想法交给你的 Agent 团队</h1><p>{handles.length > 1 ? `在正文中写 ${handles.join(" 或 ")} 可指定 Agent；` : handles.length === 1 ? `在正文中写 ${handles[0]} 可指定 Agent；` : ""}也可以直接描述目标，由默认 Agent 接手并按需邀请队友。</p>{ready.length > 0 && <div className="empty-agent-row"><span className="presence-avatars">{ready.slice(0, 4).map((agent) => <AgentAvatar agentId={agent.id} key={agent.id} />)}</span><span><strong>{ready.length} 位 Agent 已就绪</strong><small>可并行分析、实现与审核</small></span></div>}<div className="suggestion-grid"><button type="button" onClick={() => onSuggestion(directedPrompt)}><span><strong>{handles.length > 1 ? "让多个 Agent 独立评估" : "让 Agent 评估当前架构"}</strong><small>比较不同视角后汇总结论</small></span><ArrowRight size={15} /></button><button type="button" onClick={() => onSuggestion("请实现这个需求，并在必要时通过 post_message 邀请队友。")}><span><strong>由默认 Agent 自主完成</strong><small>分析、执行，并在需要时邀请队友</small></span><ArrowRight size={15} /></button></div></div>;
}

const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_COMPOSER_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    // readAsDataURL yields "data:<type>;base64,<payload>"; the server strips
    // the prefix, so the whole value can be sent as-is.
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

interface ComposerAttachment {
  id: string;
  name: string;
  mediaType: string;
  dataBase64: string;
}

interface ComposerProps {
  agents: AgentSummary[];
  fallbackAgent?: AgentSummary;
  configured: boolean;
  value: string;
  onChange(value: string): void;
  onSend(steer?: boolean): void;
  onCancel(): void;
  attachments: ComposerAttachment[];
  onAttachmentsChange(value: ComposerAttachment[]): void;
  sending: boolean;
  cancelling: boolean;
  active: boolean;
  workspace?: WorkspaceSummary;
  onWorkspaceClick(): void;
  planMode: boolean;
  onPlanModeChange(value: boolean): void;
  routingMode: A2ARoutingMode;
  onRoutingModeChange(value: A2ARoutingMode): void;
}

function Composer(props: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [props.value]);
  const mentionMatch = props.value.slice(0, cursor).match(/(?:^|\s)@([a-z0-9-]*)$/i);
  const suggestions = mentionMatch ? props.agents.filter((agent) => agent.enabled && agent.id.startsWith((mentionMatch[1] ?? "").toLocaleLowerCase())).slice(0, 6) : [];
  const insertMention = (id: string, replaceAutocomplete = false) => {
    const element = textareaRef.current;
    const position = element?.selectionStart ?? props.value.length;
    let start = position;
    if (replaceAutocomplete && mentionMatch) start = position - mentionMatch[0].trimStart().length;
    const prefix = props.value.slice(0, start);
    const spacer = prefix && !/\s$/.test(prefix) ? " " : "";
    const next = `${prefix}${spacer}@${id} ${props.value.slice(position)}`;
    props.onChange(next);
    const nextCursor = prefix.length + spacer.length + id.length + 2;
    setCursor(nextCursor);
    window.setTimeout(() => { element?.focus(); element?.setSelectionRange(nextCursor, nextCursor); }, 0);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); props.onSend(props.active && !props.planMode); } };
  const disabled = !props.configured || !props.value.trim() || props.sending;
  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const accepted: ComposerAttachment[] = [];
    for (const file of Array.from(files).slice(0, MAX_COMPOSER_ATTACHMENTS - props.attachments.length)) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) continue;
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      accepted.push({ id: `${file.name}-${file.size}-${file.lastModified}`, name: file.name, mediaType: file.type, dataBase64: await readAsBase64(file) });
    }
    if (accepted.length > 0) props.onAttachmentsChange([...props.attachments, ...accepted]);
  };
  return <div className="composer-wrap">{!props.configured && <div className="credential-warning">当前没有可用 Agent；请打开花名册检查 Pi 密钥或 Codex 登录状态。</div>}<div className="composer">
    {suggestions.length > 0 && <div className="mention-menu">{suggestions.map((agent) => <button type="button" key={agent.id} onMouseDown={(event) => { event.preventDefault(); insertMention(agent.id, true); }}><AgentAvatar agentId={agent.id} /><span><strong>@{agent.id}</strong><small>{agent.displayName} · {agent.availability.available ? "在线" : "离线"}</small></span></button>)}</div>}
    {props.attachments.length > 0 && <div className="composer-attachments">{props.attachments.map((attachment) => <span key={attachment.id}><Paperclip size={11} />{attachment.name}<button type="button" onClick={() => props.onAttachmentsChange(props.attachments.filter((item) => item.id !== attachment.id))} aria-label={`移除 ${attachment.name}`}><X size={11} /></button></span>)}</div>}
    <textarea ref={textareaRef} value={props.value} onChange={(event) => { props.onChange(event.target.value); setCursor(event.target.selectionStart); }} onClick={(event) => setCursor(event.currentTarget.selectionStart)} onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)} onKeyDown={onKeyDown} placeholder={props.planMode ? "描述你想让 Agent 先规划的事；它只读代码、先出方案，交由同伴评审、你来拍板…" : "描述任务；输入 @ 或点“添加接收人”，最多指定三个 Agent…"} rows={2} disabled={!props.configured} aria-label="任务内容" />
    <div className="composer-toolbar"><div className="composer-controls"><button className={`plan-toggle ${props.planMode ? "plan-toggle--on" : ""}`} type="button" onClick={() => props.onPlanModeChange(!props.planMode)} disabled={!props.configured} aria-pressed={props.planMode} title="计划模式：Agent 只读不改，先出方案，交同伴评审后由你拍板"><ListChecks size={14} />计划模式</button><label className="routing-mode-select" title="串行会按顺序交棒；并行会让多个 Agent 独立同时思考"><Activity size={14} /><select value={props.routingMode} onChange={(event) => props.onRoutingModeChange(event.target.value as A2ARoutingMode)} disabled={!props.configured || props.active} aria-label="多 Agent 路由模式"><option value="serial">串行交棒</option><option value="parallel">并行独立</option></select><ChevronDown size={13} /></label><button className="composer-workspace" type="button" onClick={props.onWorkspaceClick} title={props.workspace?.path} aria-label="选择工作目录"><Folder size={14} /><span>{props.workspace?.name ?? "选择目录"}</span></button><label className="agent-select" title="在光标处添加接收人"><AtSign size={14} /><select value="" onChange={(event) => { if (event.target.value) insertMention(event.target.value); }} disabled={!props.configured} aria-label="添加接收人"><option value="">添加接收人</option>{props.agents.filter((agent) => agent.enabled).map((agent) => <option value={agent.id} key={agent.id} disabled={!agent.availability.available}>{agent.displayName}（@{agent.id}）{agent.availability.available ? "" : "· 离线"}</option>)}</select><ChevronDown size={14} /></label><span className="fallback-hint">默认交给 {props.fallbackAgent?.displayName ?? "可用 Agent"}</span></div><div className="composer-actions"><span className="composer-hint">{props.active ? "Enter 插话" : "Enter 发送"}</span><label className="composer-attach" title="添加图片（仅 Pi 运行时可直接读取）"><Paperclip size={14} /><input type="file" accept={ALLOWED_IMAGE_TYPES.join(",")} multiple disabled={!props.configured || props.attachments.length >= MAX_COMPOSER_ATTACHMENTS} onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} aria-label="添加图片" /></label>{props.active && !props.planMode && <button className="steer-button" type="button" onClick={() => props.onSend(true)} disabled={disabled} aria-label="插话到正在运行的 Agent">{props.sending ? <span className="button-spinner" /> : <SendHorizontal size={16} />}插话</button>}{props.active ? <button className="stop-button" type="button" onClick={props.onCancel} disabled={props.cancelling} aria-label="停止整个协作链"><Square size={11} fill="currentColor" /></button> : <button className="send-button" type="button" onClick={() => props.onSend()} disabled={disabled} aria-label="发送任务">{props.sending ? <span className="button-spinner" /> : <SendHorizontal size={17} />}</button>}</div></div>
  </div></div>;
}

interface ModelCatalogProvider {
  id: string;
  name: string;
  configured: boolean;
  subscription: boolean;
  custom: boolean;
  /** Present when this app can store the provider's key itself. */
  envKey?: string;
  models: Array<{ id: string; name: string }>;
}

interface ModelCatalog {
  providers: ModelCatalogProvider[];
  custom?: CustomProviderCatalogV1;
  warnings?: string[];
  error?: string;
}

interface CredentialResponse { agents: AgentSummary[]; models: ModelCatalog; error?: string }

/**
 * Per-provider credential entry inside the roster editor.
 *
 * First-run setup writes exactly one provider key and then locks itself, so a
 * roster with a Pi Agent per provider previously meant hand-editing the config
 * file and restarting. Keys stay out of the catalog payload — they go to their
 * own endpoint, which reloads Pi's credential cache in place.
 */
function ProviderCredentialField({ provider, models, onSaved }: { provider: string; models: ModelCatalog; onSaved(agents: AgentSummary[], models: ModelCatalog): void }) {
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { setApiKey(""); setNotice(""); setError(""); setShowKey(false); }, [provider]);
  const preset = findApiProvider(provider);
  const status = models.providers.find((item) => item.id === provider);
  const configured = Boolean(status?.configured);
  const save = async () => {
    if (saving || apiKey.trim().length < 8) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/providers/credential", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider, apiKey: apiKey.trim() }) });
      const result = (await response.json()) as CredentialResponse;
      if (!response.ok || !result.agents) throw new Error(result.error ?? "凭据保存失败");
      setApiKey("");
      setNotice("凭据已保存并生效，无需重启。");
      onSaved(result.agents, result.models);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };
  // Any provider this app can write an environment variable for takes a key
  // here: the built-in presets and the workspace's own third-party deployments.
  // Everything else is a subscription or ambient-credential provider, where the
  // key box would be a dead end.
  const envKey = status?.envKey;
  return <div className="provider-credential">
    <div className="provider-credential-head"><KeyRound size={13} /><span>{status?.name ?? preset?.label ?? provider} 凭据</span><i className={configured ? "provider-credential-ready" : undefined}>{status?.subscription ? "订阅已登录" : configured ? "已配置" : "未配置"}</i></div>
    {envKey ? <>
      <div className="provider-credential-row">
        <input type={showKey ? "text" : "password"} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={configured ? "输入新的 Key 可覆盖现有凭据" : preset?.keyPlaceholder ?? `请输入 ${status?.name ?? provider} 的 API Key`} autoComplete="off" spellCheck={false} />
        <button type="button" onClick={() => setShowKey((current) => !current)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}>{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        <button type="button" onClick={() => void save()} disabled={saving || apiKey.trim().length < 8}>{saving ? <span className="button-spinner" /> : <Save size={13} />}{saving ? "保存中" : "保存密钥"}</button>
      </div>
      <p className={`provider-credential-note${error ? " provider-credential-note--error" : notice ? " provider-credential-note--ok" : ""}`}>{error || notice || `密钥以 ${envKey} 写入本机配置文件，不会进入花名册或任何 API 响应。每个提供商各存一份，互不覆盖。`}</p>
    </> : <p className="provider-credential-note">{configured ? `${provider} 的凭据来自 pi 的 auth.json，在这里无需重复填写。` : status ? `${provider} 使用订阅或系统凭据登录，请先用 pi 的 /login 写入 auth.json。` : `pi 的模型目录里没有 ${provider}：如果它写在 pi 的 models.json 里，请用 pi 登录写入 auth.json；也可以在下方把它登记为自定义提供商。`}</p>}
  </div>;
}

/**
 * Where a new Pi Agent starts.
 *
 * A hardcoded provider sends every new Agent to one vendor even when its key is
 * the one credential the workspace does not have, so the first provider that is
 * actually configured wins, with its preset default model when that model is
 * still in the catalog.
 */
function defaultPiRuntime(models: ModelCatalog): Extract<AgentDefinition["runtime"], { kind: "pi" }> {
  const configured = models.providers.filter((provider) => provider.configured);
  const provider = configured.find((item) => findApiProvider(item.id)) ?? configured[0];
  const preset = provider ? findApiProvider(provider.id) : undefined;
  const model = preset && provider?.models.some((item) => item.id === preset.model)
    ? preset.model
    : provider?.models[0]?.id;
  return {
    kind: "pi",
    provider: provider?.id ?? "zai-coding-cn",
    model: model ?? "glm-5.2",
    thinkingLevel: "medium",
  };
}

const MANUAL_OPTION = "__manual__";

/**
 * Provider and model choosers for a Pi Agent.
 *
 * Pi ships around forty providers and the workspace can declare more, so the
 * catalog is offered as a real list instead of an autocomplete hint that only
 * appears once the user guesses the first character. Manual entry stays
 * reachable for a provider declared straight in pi's own `models.json`, which
 * this app never sees.
 */
function ProviderPicker({ value, providers, onChange }: { value: string; providers: ModelCatalogProvider[]; onChange(provider: string): void }) {
  const [manual, setManual] = useState(false);
  // Before the catalog arrives there is nothing to choose from, so the field
  // stays a plain input rather than a select that cannot show its own value.
  if (providers.length === 0) {
    return <label>Provider<input value={value} onChange={(event) => onChange(event.target.value.trim())} spellCheck={false} autoComplete="off" /></label>;
  }
  const known = providers.some((provider) => provider.id === value);
  const showManual = manual || !known;
  const custom = providers.filter((provider) => provider.custom);
  const configured = providers.filter((provider) => !provider.custom && provider.configured);
  const rest = providers.filter((provider) => !provider.custom && !provider.configured);
  const option = (provider: ModelCatalogProvider) => <option value={provider.id} key={provider.id}>{provider.name}（{provider.id}）</option>;
  return <label>Provider
    <select
      value={showManual ? MANUAL_OPTION : value}
      onChange={(event) => {
        setManual(event.target.value === MANUAL_OPTION);
        if (event.target.value !== MANUAL_OPTION) onChange(event.target.value);
      }}
    >
      {custom.length > 0 && <optgroup label="自定义 / 第三方部署">{custom.map(option)}</optgroup>}
      {configured.length > 0 && <optgroup label="已配置凭据">{configured.map(option)}</optgroup>}
      {rest.length > 0 && <optgroup label="未配置凭据">{rest.map(option)}</optgroup>}
      <option value={MANUAL_OPTION}>其他（手动输入 provider id）</option>
    </select>
    {showManual && <input className="picker-manual" value={value} placeholder="provider id，例如 models.json 中自定义的名称" onChange={(event) => onChange(event.target.value.trim())} spellCheck={false} autoComplete="off" />}
  </label>;
}

function ModelPicker({ value, models, onChange }: { value: string; models: Array<{ id: string; name: string }>; onChange(model: string): void }) {
  const [manual, setManual] = useState(false);
  // A provider whose catalog this app cannot see — one declared in pi's own
  // models.json — has no list to offer, so the model stays free text.
  if (models.length === 0) {
    return <label>Model<input value={value} onChange={(event) => onChange(event.target.value.trim())} spellCheck={false} autoComplete="off" /></label>;
  }
  const known = models.some((model) => model.id === value);
  const showManual = manual || !known;
  return <label>Model
    <select
      value={showManual ? MANUAL_OPTION : value}
      onChange={(event) => {
        setManual(event.target.value === MANUAL_OPTION);
        if (event.target.value !== MANUAL_OPTION) onChange(event.target.value);
      }}
    >
      {models.map((model) => <option value={model.id} key={model.id}>{model.id === model.name ? model.id : `${model.name}（${model.id}）`}</option>)}
      <option value={MANUAL_OPTION}>其他（手动输入模型名）</option>
    </select>
    {showManual && <input className="picker-manual" value={value} placeholder="模型名，例如 glm-5.2" onChange={(event) => onChange(event.target.value.trim())} spellCheck={false} autoComplete="off" />}
  </label>;
}

interface CustomProviderPanelProps {
  catalog: CustomProviderCatalogV1;
  models: ModelCatalog;
  onSaved(agents: AgentSummary[], models: ModelCatalog): void;
  onSelect(providerId: string, modelId: string): void;
}

const EMPTY_CUSTOM_FORM = { id: "", label: "", baseUrl: "", api: "openai-completions" as CustomProviderApi, models: "", reasoning: false, developerRole: true, apiKey: "" };

/**
 * Third-party and self-hosted deployments.
 *
 * A company gateway, a vLLM/Ollama box or any other OpenAI-compatible endpoint
 * used to require hand-editing pi's `models.json` outside the app. Declaring one
 * here registers it on pi's model runtime, so it shows up in the provider picker
 * and takes a key like any built-in provider.
 */
function CustomProviderPanel({ catalog, models, onSaved, onSelect }: CustomProviderPanelProps) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_CUSTOM_FORM);
  const [editingId, setEditingId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const update = (changes: Partial<typeof EMPTY_CUSTOM_FORM>) => setForm((current) => ({ ...current, ...changes }));
  const reset = () => { setForm(EMPTY_CUSTOM_FORM); setEditingId(""); setError(""); };

  const write = async (providers: CustomProvider[]): Promise<ModelCatalog> => {
    const response = await fetch("/api/providers/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, providers }) });
    const result = (await response.json()) as CredentialResponse;
    if (!response.ok || !result.agents) throw new Error(result.error ?? "提供商保存失败");
    onSaved(result.agents, result.models);
    return result.models;
  };

  const submit = async () => {
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const id = (editingId || form.id).trim();
      const modelIds = form.models.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean);
      if (modelIds.length === 0) throw new Error("请至少填写一个模型名");
      const provider: CustomProvider = {
        id,
        label: form.label.trim() || id,
        baseUrl: form.baseUrl.trim(),
        api: form.api,
        models: modelIds.map((modelId) => ({ id: modelId, reasoning: form.reasoning, contextWindow: DEFAULT_CUSTOM_CONTEXT_WINDOW, maxTokens: DEFAULT_CUSTOM_MAX_TOKENS })),
        ...(form.developerRole ? {} : { compat: { supportsDeveloperRole: false, supportsReasoningEffort: false } }),
      };
      const providers = editingId
        ? catalog.providers.map((item) => (item.id === editingId ? provider : item))
        : [...catalog.providers, provider];
      let latest = await write(providers);
      // The key is stored separately, exactly like a built-in provider's, so the
      // definition itself never carries a secret.
      if (form.apiKey.trim().length >= 8) {
        const response = await fetch("/api/providers/credential", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: id, apiKey: form.apiKey.trim() }) });
        const result = (await response.json()) as CredentialResponse;
        if (!response.ok || !result.agents) throw new Error(result.error ?? "凭据保存失败");
        onSaved(result.agents, result.models);
        latest = result.models;
      }
      const firstModel = latest.providers.find((item) => item.id === id)?.models[0]?.id ?? modelIds[0];
      onSelect(id, firstModel ?? "");
      setNotice(`${provider.label} 已可用，无需重启。`);
      reset();
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (provider: CustomProvider) => {
    if (saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      await write(catalog.providers.filter((item) => item.id !== provider.id));
      if (editingId === provider.id) reset();
      setNotice(`${provider.label} 已删除。`);
    } catch (deleteError) {
      setError(errorMessage(deleteError));
    } finally {
      setSaving(false);
    }
  };

  const edit = (provider: CustomProvider) => {
    setEditingId(provider.id);
    setOpen(true);
    setError(""); setNotice("");
    setForm({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      api: provider.api,
      models: provider.models.map((model) => model.id).join("\n"),
      reasoning: provider.models.some((model) => model.reasoning),
      developerRole: provider.compat?.supportsDeveloperRole !== false,
      apiKey: "",
    });
  };

  const idValid = /^[a-z][a-z0-9-]{0,31}$/.test((editingId || form.id).trim());
  const ready = idValid && form.baseUrl.trim() !== "" && form.models.trim() !== "";
  return <div className="custom-provider-panel">
    <button className="custom-provider-toggle" type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>
      <Wrench size={13} />自定义 / 第三方部署的模型{catalog.providers.length > 0 ? `（已配置 ${catalog.providers.length} 个）` : ""}<ChevronDown size={13} className={open ? "custom-provider-caret--open" : undefined} />
    </button>
    {open && <div className="custom-provider-body">
      {catalog.providers.length > 0 && <ul className="custom-provider-list">
        {catalog.providers.map((provider) => <li key={provider.id}>
          <span><strong>{provider.label}</strong><small>{provider.id} · {provider.baseUrl} · {provider.models.length} 个模型{models.providers.find((item) => item.id === provider.id)?.configured ? " · 凭据已配置" : " · 未配置凭据"}</small></span>
          <button type="button" onClick={() => edit(provider)} disabled={saving}>编辑</button>
          <button type="button" onClick={() => void remove(provider)} disabled={saving}>删除</button>
        </li>)}
      </ul>}
      <div className="form-grid">
        <label>名称<input value={form.label} placeholder="例如 公司网关" onChange={(event) => update({ label: event.target.value })} /></label>
        <label>Provider id<input value={editingId || form.id} disabled={Boolean(editingId)} placeholder="小写字母、数字和连字符" onChange={(event) => update({ id: event.target.value.toLocaleLowerCase().replace(/[^a-z0-9-]/g, "") })} /></label>
      </div>
      <label>Base URL<input value={form.baseUrl} placeholder="https://gateway.example.com/v1" onChange={(event) => update({ baseUrl: event.target.value })} spellCheck={false} /></label>
      <div className="form-grid">
        <label>API 类型<select value={form.api} onChange={(event) => update({ api: event.target.value as CustomProviderApi })}>{CUSTOM_PROVIDER_APIS.map((api) => <option value={api} key={api}>{api}</option>)}</select><small className="field-hint">多数第三方与自建部署使用 openai-completions。</small></label>
        <label>API Key（可选）<input type="password" value={form.apiKey} placeholder={editingId ? "留空表示不修改" : "本地服务可填任意占位值"} onChange={(event) => update({ apiKey: event.target.value })} autoComplete="off" /></label>
      </div>
      <label>模型（每行一个）<textarea value={form.models} rows={3} placeholder={"qwen3-coder\ndeepseek-v4-pro"} onChange={(event) => update({ models: event.target.value })} spellCheck={false} /></label>
      <div className="catalog-switches">
        <label><input type="checkbox" checked={form.reasoning} onChange={(event) => update({ reasoning: event.target.checked })} />模型支持思考（reasoning）</label>
        <label><input type="checkbox" checked={!form.developerRole} onChange={(event) => update({ developerRole: !event.target.checked })} />服务端不支持 developer 角色（vLLM、Ollama 等）</label>
      </div>
      <p className={`provider-credential-note${error ? " provider-credential-note--error" : notice ? " provider-credential-note--ok" : ""}`}>{error || notice || `密钥以 ${customProviderEnvKey((editingId || form.id).trim() || "provider")} 写入本机配置文件；定义本身不含密钥。`}</p>
      <div className="custom-provider-actions">
        {editingId && <button type="button" onClick={reset} disabled={saving}>取消编辑</button>}
        <button type="button" className="catalog-save" onClick={() => void submit()} disabled={saving || !ready}><Save size={13} />{saving ? "保存中…" : editingId ? "保存修改" : "添加提供商"}</button>
      </div>
    </div>}
  </div>;
}

interface CatalogEditorProps { open: boolean; catalog: AgentCatalogV1; agents: AgentSummary[]; onClose(): void; onSave(catalog: AgentCatalogV1): Promise<void>; onAgentsRefreshed(agents: AgentSummary[]): void }

function AgentCatalogEditor({ open, catalog, agents, onClose, onSave, onAgentsRefreshed }: CatalogEditorProps) {
  const [draft, setDraft] = useState<AgentCatalogV1>(() => structuredClone(catalog));
  const [selectedId, setSelectedId] = useState(catalog.defaultAgentId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const originalIds = useMemo(() => new Set(catalog.agents.map((agent) => agent.id)), [catalog]);
  const [catalogModels, setCatalogModels] = useState<ModelCatalog>({ providers: [] });
  useEffect(() => { if (open) { setDraft(structuredClone(catalog)); setSelectedId(catalog.defaultAgentId); setError(""); } }, [open, catalog]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Advisory only: the inputs stay free text so custom providers declared in
    // models.json remain usable when the catalog cannot be read.
    void fetch("/api/models").then((response) => response.json()).then((value: ModelCatalog) => { if (!cancelled) setCatalogModels(value); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);
  if (!open) return null;
  const selected = draft.agents.find((agent) => agent.id === selectedId) ?? draft.agents[0];
  const update = (changes: Partial<AgentDefinition>) => { if (selected) setDraft((current) => ({ ...current, agents: current.agents.map((agent) => agent.id === selected.id ? { ...agent, ...changes } : agent) })); };
  const renameNewAgent = (id: string) => {
    if (!selected || originalIds.has(selected.id)) return;
    const normalized = id.toLocaleLowerCase().replace(/[^a-z0-9-]/g, "");
    setDraft((current) => ({ ...current, defaultAgentId: current.defaultAgentId === selected.id ? normalized : current.defaultAgentId, agents: current.agents.map((agent) => agent.id === selected.id ? { ...agent, id: normalized } : agent) }));
    setSelectedId(normalized);
  };
  const addAgent = () => {
    let index = draft.agents.length + 1; while (draft.agents.some((agent) => agent.id === `agent-${index}`)) index += 1;
    const id = `agent-${index}`;
    const agent: AgentDefinition = { id, displayName: `Agent ${index}`, description: "对等团队协作者", systemPrompt: "You are an autonomous peer in a multi-agent team. Use post_message when another peer should act.", capabilities: ["分析"], enabled: true, accessMode: "read-only", runtime: { kind: "codex", command: "codex" } };
    setDraft((current) => ({ ...current, agents: [...current.agents, agent] })); setSelectedId(id);
  };
  const submit = async () => { if (saving) return; setSaving(true); setError(""); try { await onSave(draft); onClose(); } catch (saveError) { setError(errorMessage(saveError)); } finally { setSaving(false); } };
  const health = agents.find((agent) => agent.id === selected?.id)?.availability;
  return <div className="catalog-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="catalog-editor" role="dialog" aria-modal="true" aria-labelledby="catalog-title"><header><div><strong id="catalog-title">Agent 花名册</strong><span>revision {catalog.revision} · handle 保存后不可修改</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭花名册"><X size={18} /></button></header><div className="catalog-body"><aside className="catalog-list">{draft.agents.map((agent) => { const view = agents.find((item) => item.id === agent.id); return <button type="button" key={agent.id} className={agent.id === selected?.id ? "catalog-agent--active" : ""} onClick={() => setSelectedId(agent.id)}><AgentAvatar agentId={agent.id} /><span><strong>{agent.displayName}</strong><small>@{agent.id} · {view?.availability.available ? "在线" : "离线"}</small></span>{draft.defaultAgentId === agent.id && <i>默认</i>}</button>; })}<button className="catalog-add" type="button" onClick={addAgent}><Plus size={14} />新增 Agent</button></aside>{selected && <div className="catalog-form">
    <div className={`health-banner ${health?.available ? "health-banner--ready" : ""}`}><Activity size={14} /><span><strong>{health?.label ?? "保存后检查运行时"}</strong><small>{health?.detail ?? "新的运行时配置会创建独立 session"}</small></span></div>
    <div className="form-grid"><label>Handle<input value={selected.id} onChange={(event) => renameNewAgent(event.target.value)} disabled={originalIds.has(selected.id)} /></label><label>显示名<input value={selected.displayName} onChange={(event) => update({ displayName: event.target.value })} /></label></div>
    <label>简介<input value={selected.description} onChange={(event) => update({ description: event.target.value })} /></label><label>能力（逗号分隔）<input value={selected.capabilities.join(", ")} onChange={(event) => update({ capabilities: event.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean) })} /></label><label>System prompt<textarea value={selected.systemPrompt} onChange={(event) => update({ systemPrompt: event.target.value })} rows={5} /></label>
    <div className="form-grid"><label>Runtime<select value={selected.runtime.kind} onChange={(event) => update({ runtime: event.target.value === "pi" ? defaultPiRuntime(catalogModels) : { kind: "codex", command: "codex" } })}><option value="codex">Codex CLI</option><option value="pi">Pi SDK</option></select></label><label>访问级别<select value={selected.accessMode} onChange={(event) => update({ accessMode: event.target.value as AccessMode })}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="full">full</option></select></label></div>
    <div className="form-grid"><label>默认审核者<select value={selected.reviewerAgentId ?? ""} onChange={(event) => update({ reviewerAgentId: event.target.value || undefined })}><option value="">自动选择在线队友</option>{draft.agents.filter((candidate) => candidate.id !== selected.id).map((candidate) => <option value={candidate.id} key={candidate.id}>@{candidate.id}</option>)}</select><small className="field-hint">该 Agent 完成用户任务后，交由谁审核。离线或未配置时自动回退到其他在线 Agent。</small></label></div>
    {selected.runtime.kind === "pi" ? <div className="form-grid form-grid--three">
      <ProviderPicker
        key={selected.id}
        value={selected.runtime.provider}
        providers={catalogModels.providers}
        onChange={(provider) => {
          const runtime = selected.runtime as Extract<AgentDefinition["runtime"], { kind: "pi" }>;
          // A model from the previous provider almost never exists on the new
          // one, so the first model there is a better starting point than an
          // Agent that cannot resolve its model.
          const models = catalogModels.providers.find((item) => item.id === provider)?.models ?? [];
          const model = models.some((item) => item.id === runtime.model) ? runtime.model : models[0]?.id ?? runtime.model;
          update({ runtime: { ...runtime, provider, model } });
        }}
      />
      <ModelPicker
        key={`${selected.id}:${selected.runtime.provider}`}
        value={selected.runtime.model}
        models={catalogModels.providers.find((item) => item.id === (selected.runtime as { provider: string }).provider)?.models ?? []}
        onChange={(model) => update({ runtime: { ...selected.runtime, model } as AgentDefinition["runtime"] })}
      />
      <label>Thinking<select value={selected.runtime.thinkingLevel} onChange={(event) => update({ runtime: { ...selected.runtime, thinkingLevel: event.target.value as ThinkingLevel } as AgentDefinition["runtime"] })}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level}>{level}</option>)}</select></label>
    </div> : <><div className="form-grid"><label>CLI 路径<input value={selected.runtime.command} onChange={(event) => update({ runtime: { ...selected.runtime, command: event.target.value } as AgentDefinition["runtime"] })} /></label><label>Model<input value={selected.runtime.model ?? ""} placeholder="使用 profile 默认值" onChange={(event) => update({ runtime: { ...selected.runtime, model: event.target.value || undefined } as AgentDefinition["runtime"] })} /></label></div><div className="form-grid"><label>Profile<input value={selected.runtime.profile ?? ""} onChange={(event) => update({ runtime: { ...selected.runtime, profile: event.target.value || undefined } as AgentDefinition["runtime"] })} /></label><label>Reasoning<select value={selected.runtime.reasoningEffort ?? ""} onChange={(event) => update({ runtime: { ...selected.runtime, reasoningEffort: (event.target.value || undefined) as "low" | "medium" | "high" | "xhigh" | undefined } as AgentDefinition["runtime"] })}><option value="">profile 默认值</option>{["low", "medium", "high", "xhigh"].map((level) => <option key={level}>{level}</option>)}</select></label></div></>}
    {selected.runtime.kind === "pi" && <ProviderCredentialField provider={selected.runtime.provider} models={catalogModels} onSaved={(nextAgents, nextModels) => { onAgentsRefreshed(nextAgents); setCatalogModels(nextModels); }} />}
    {selected.runtime.kind === "pi" && <CustomProviderPanel
      catalog={catalogModels.custom ?? { version: 1, providers: [] }}
      models={catalogModels}
      onSaved={(nextAgents, nextModels) => { onAgentsRefreshed(nextAgents); setCatalogModels(nextModels); }}
      onSelect={(provider, model) => update({ runtime: { ...(selected.runtime as Extract<AgentDefinition["runtime"], { kind: "pi" }>), provider, ...(model ? { model } : {}) } })}
    />}
    {(catalogModels.warnings ?? []).map((warning) => <p className="risk-warning" key={warning}>{warning}</p>)}
    <div className="catalog-switches"><label><input type="checkbox" checked={selected.enabled} disabled={selected.id === draft.defaultAgentId} onChange={(event) => update({ enabled: event.target.checked })} />启用</label><label><input type="radio" name="default-agent" checked={selected.id === draft.defaultAgentId} onChange={() => setDraft((current) => ({ ...current, defaultAgentId: selected.id, agents: current.agents.map((agent) => agent.id === selected.id ? { ...agent, enabled: true } : agent) }))} />设为默认 Agent</label></div>
    {selected.runtime.kind === "pi" && selected.accessMode === "full" && <p className="risk-warning">Pi full 会开放 Bash/edit/write，缺少完整文件系统沙箱。只在信任的本地工作目录使用。</p>}{selected.runtime.kind === "codex" && selected.accessMode === "full" && <p className="risk-warning">Codex v1 会把 full 映射为 workspace-write，不启用 danger-full-access。</p>}
  </div>}</div><footer>{error && <span className="catalog-error"><XCircle size={13} />{error}</span>}<button type="button" className="catalog-cancel" onClick={onClose}>取消</button><button type="button" className="catalog-save" onClick={() => void submit()} disabled={saving}><Save size={14} />{saving ? "保存中…" : "原子保存花名册"}</button></footer></section></div>;
}

interface WorkspacePickerProps { open: boolean; current?: WorkspaceSummary; recent: WorkspaceSummary[]; onClose(): void; onSelect(workspace: WorkspaceSummary): void }

function WorkspacePicker({ open, current, recent, onClose, onSelect }: WorkspacePickerProps) {
  const [path, setPath] = useState(""); const [error, setError] = useState(""); const [checking, setChecking] = useState(false); const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setPath(current?.path ?? ""); setError(""); window.setTimeout(() => inputRef.current?.focus(), 0); } }, [open, current?.path]);
  const choose = async (requestedPath: string) => { if (!requestedPath.trim() || checking) return; setChecking(true); setError(""); try { const response = await fetch("/api/workspaces/validate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: requestedPath }) }); const result = (await response.json()) as WorkspaceSummary & { error?: string }; if (!response.ok || !result.path) throw new Error(result.error ?? "无法使用该目录"); onSelect({ name: result.name, path: result.path }); } catch (validationError) { setError(errorMessage(validationError)); } finally { setChecking(false); } };
  if (!open) return null;
  return <div className="workspace-picker-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="workspace-picker" role="dialog" aria-modal="true" aria-labelledby="workspace-picker-title"><header><div><strong id="workspace-picker-title">选择工作目录</strong><span>更换目录后会开始一个新对话</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭目录选择器"><X size={18} /></button></header><form onSubmit={(event) => { event.preventDefault(); void choose(path); }}><label htmlFor="workspace-path-input">目录路径</label><div className="workspace-path-input"><Folder size={16} /><input ref={inputRef} id="workspace-path-input" value={path} onChange={(event) => setPath(event.target.value)} placeholder="/Users/you/Documents/project" spellCheck={false} autoComplete="off" /></div>{error && <p className="workspace-error"><XCircle size={13} />{error}</p>}<p className="workspace-help">目录必须已经存在，并且当前用户拥有读取权限。对话创建后，其工作目录将保持不变。</p><button className="workspace-submit" type="submit" disabled={!path.trim() || checking}>{checking ? <span className="button-spinner" /> : <Folder size={14} />}使用此目录并新建对话</button></form>{recent.length > 0 && <div className="recent-workspaces"><h2>最近使用</h2>{recent.map((workspace) => <button type="button" key={workspace.path} onClick={() => void choose(workspace.path)} disabled={checking}><span className="recent-workspace-icon"><Folder size={14} /></span><span><strong>{workspace.name}</strong><small>{workspace.path}</small></span>{workspace.path === current?.path && <Check size={14} />}</button>)}</div>}</section></div>;
}

interface DetailsDrawerProps { open: boolean; onClose(): void; thread?: ThreadSummary; agents: AgentSummary[]; workspace?: WorkspaceSummary; events: StoredPlatformEvent[] }

function DetailsDrawer({ open, onClose, thread, agents, workspace, events }: DetailsDrawerProps) {
  const threadEvents = useMemo(() => selectThreadEvents(events, thread?.id), [events, thread?.id]); const runCount = threadEvents.filter((event) => event.type === "run.queued").length; const toolCount = threadEvents.filter((event) => event.type === "run.tool" && event.phase === "start").length; const messageCount = threadEvents.filter((event) => event.type === "message.created").length; const timeline = threadEvents.filter((event) => event.type !== "run.delta" && event.type !== "run.thinking" && event.type !== "run.reset" && event.type !== "thread.created");
  return <>{open && <button className="drawer-scrim" type="button" onClick={onClose} aria-label="关闭运行详情" />}<aside className={`details-drawer ${open ? "details-drawer--open" : ""}`} aria-hidden={!open}><header className="drawer-header"><div><strong>运行详情</strong><span>{thread ? cleanTitle(thread.title) : "尚未创建任务"}</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭运行详情"><X size={18} /></button></header><div className="drawer-content"><section className="drawer-section workspace-card"><Folder size={16} /><div><span>工作目录与写锁作用域</span><code title={workspace?.path}>{workspace?.path ?? "正在读取"}</code></div></section><section className="drawer-section"><h2>概览</h2><div className="stat-grid"><div><strong>{runCount}</strong><span>运行</span></div><div><strong>{messageCount}</strong><span>消息</span></div><div><strong>{toolCount}</strong><span>工具</span></div></div></section><section className="drawer-section"><h2>团队运行时健康</h2><div className="agent-roster">{agents.map((agent) => <div className="roster-item" key={agent.id}><AgentAvatar agentId={agent.id} /><span><strong>{agent.displayName}</strong><small>@{agent.id} · {runtimeLabel(agent)} · {agent.accessMode}</small></span><i>{!agent.enabled ? "已停用" : threadEvents.some((event) => event.type === "run.started" && event.agentId === agent.id) ? "已参与" : agent.availability.available ? "待命" : "离线"}</i></div>)}</div></section><section className="drawer-section"><h2>Agent Session</h2><SessionPanel thread={thread} agents={agents} /></section><section className="drawer-section"><h2>A2A 与运行时间线</h2>{timeline.length > 0 ? <div className="event-timeline">{timeline.map((event) => <TimelineEvent event={event} agents={agents} key={event.eventId} />)}</div> : <p className="drawer-empty">发送任务后，这里会显示 session、排队、工具调用、结构化转交和运行状态。</p>}</section></div></aside></>;
}

function SessionPanel({ thread, agents }: { thread?: ThreadSummary; agents: AgentSummary[] }) {
  const piAgents = agents.filter((agent) => agent.runtime.kind === "pi");
  const [agentId, setAgentId] = useState("");
  const [stats, setStats] = useState<RuntimeSessionStatsView | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const selectedId = agentId || piAgents[0]?.id || "";
  const threadId = thread?.id;
  useEffect(() => {
    if (!threadId || !selectedId) { setStats(null); return; }
    let cancelled = false;
    void fetch(`/api/agents/${encodeURIComponent(selectedId)}/session?threadId=${encodeURIComponent(threadId)}`)
      .then((response) => response.json())
      .then((value: { stats?: RuntimeSessionStatsView | null }) => { if (!cancelled) setStats(value.stats ?? null); })
      .catch(() => { if (!cancelled) setStats(null); });
    return () => { cancelled = true; };
  }, [threadId, selectedId, notice]);
  if (piAgents.length === 0) return <p className="drawer-empty">Session 统计、压缩与导出目前只对 Pi 运行时可用。</p>;
  if (!threadId) return <p className="drawer-empty">创建任务后可以查看每个 Agent 的私有 session。</p>;
  const act = async (action: "compact" | "export", format?: "html" | "jsonl") => {
    setBusy(action); setNotice("");
    try {
      const query = new URLSearchParams({ threadId, action, ...(format ? { format } : {}) });
      const response = await fetch(`/api/agents/${encodeURIComponent(selectedId)}/session?${query.toString()}`, { method: "POST" });
      const value = (await response.json()) as { detail?: string; path?: string; error?: string };
      if (!response.ok) throw new Error(value.error ?? "操作失败");
      setNotice(value.path ?? value.detail ?? "已完成");
    } catch (error) { setNotice(errorMessage(error)); } finally { setBusy(""); }
  };
  return <div className="session-panel">
    <label className="session-agent">Agent<select value={selectedId} onChange={(event) => { setAgentId(event.target.value); setNotice(""); }}>{piAgents.map((agent) => <option value={agent.id} key={agent.id}>@{agent.id}</option>)}</select></label>
    {stats ? <>
      <div className="stat-grid"><div><strong>{stats.assistantMessages}</strong><span>回复</span></div><div><strong>{stats.toolCalls}</strong><span>工具调用</span></div><div><strong>{formatTokens(stats.totalTokens)}</strong><span>累计 token</span></div></div>
      <p className="session-meta">累计成本 ${stats.costUsd.toFixed(4)}{stats.contextTokens !== undefined && stats.contextWindow ? ` · 上下文 ${Math.round((stats.contextTokens / stats.contextWindow) * 100)}%` : ""}</p>
    </> : <p className="drawer-empty">该 Agent 在这个任务里还没有 session。</p>}
    <div className="session-actions">
      <button type="button" onClick={() => void act("compact")} disabled={!stats || busy !== ""}>{busy === "compact" ? "压缩中…" : "压缩上下文"}</button>
      <button type="button" onClick={() => void act("export", "html")} disabled={!stats || busy !== ""}>导出 HTML</button>
      <button type="button" onClick={() => void act("export", "jsonl")} disabled={!stats || busy !== ""}>导出 JSONL</button>
    </div>
    {notice && <p className="session-notice">{notice}</p>}
  </div>;
}

interface RuntimeSessionStatsView {
  sessionId: string;
  sessionFile?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalTokens: number;
  costUsd: number;
  contextTokens?: number;
  contextWindow?: number;
}

function TimelineEvent({ event, agents }: { event: StoredPlatformEvent; agents: AgentSummary[] }) { const description = describeEvent(event, agents); const Icon = description.icon; return <div className={`timeline-event timeline-event--${description.tone}`}><span className="timeline-icon"><Icon size={13} /></span><div><strong>{description.title}</strong><span>{description.detail}</span></div><time>{formatClock(event.recordedAt)}</time></div>; }

function describeEvent(event: StoredPlatformEvent, agents: AgentSummary[]) {
  if (event.type === "message.created") { const sender = event.message.sender.type === "human" ? "用户" : agentName(agents, event.message.sender.id); const targets = event.message.mentions.length ? ` → ${event.message.mentions.map((id) => `@${id}`).join(" ")}` : ""; return { title: event.message.kind === "collaboration" ? "协作消息已发布" : "消息已记录", detail: `${sender}${targets}`, icon: MessageSquare, tone: "neutral" }; }
  if (event.type === "run.queued") return { title: `${agentName(agents, event.run.agentId)} 已排队`, detail: `${event.run.accessMode === "read-only" ? "可并行" : "等待工作区写锁"} · 深度 ${event.run.causal.depth}`, icon: Clock3, tone: "neutral" };
  if (event.type === "run.started") return { title: `${agentName(agents, event.agentId)} 开始运行`, detail: shortId(event.runId), icon: Activity, tone: "active" };
  if (event.type === "run.session") return { title: `${agentName(agents, event.agentId)} ${event.resumed ? "恢复" : "创建"} session`, detail: event.runtimeKind, icon: Bot, tone: "neutral" };
  if (event.type === "context.delivered") return { title: `上下文已交付给 ${agentName(agents, event.agentId)}`, detail: event.truncated ? "已按 24,000 字符截断" : shortId(event.messageId), icon: MessageSquare, tone: event.truncated ? "danger" : "neutral" };
  if (event.type === "run.tool") return { title: event.phase === "start" ? `调用 ${event.toolName}` : `${event.toolName} ${event.isError ? "失败" : "完成"}`, detail: (event.phase === "start" ? event.args : event.resultSummary)?.slice(0, 120) ?? shortId(event.runId), icon: Wrench, tone: event.isError ? "danger" : "neutral" };
  if (event.type === "run.lifecycle") return { title: `${agentName(agents, event.agentId)} ${lifecycleLabel(event.phase)}`, detail: event.detail ?? shortId(event.runId), icon: RefreshCw, tone: event.phase === "retry_start" ? "danger" : "neutral" };
  if (event.type === "run.diagnostic") return { title: event.source === "extension" ? "Pi 扩展报错" : "运行时诊断", detail: event.message, icon: XCircle, tone: "danger" };
  if (event.type === "run.usage") return { title: `${agentName(agents, event.agentId)} 用量`, detail: `${formatTokens(event.totalTokens)} tokens · $${event.costUsd.toFixed(4)}`, icon: Activity, tone: "neutral" };
  if (event.type === "run.steered") return { title: `已向 ${agentName(agents, event.agentId)} 插话`, detail: shortId(event.messageId), icon: SendHorizontal, tone: "active" };
  if (event.type === "routing.accepted") return { title: `结构化转交给 ${agentName(agents, event.targetAgentId)}`, detail: "post_message 已接受", icon: ArrowRight, tone: "active" };
  if (event.type === "routing.rejected") return { title: "Agent 路由被拒绝", detail: event.reason, icon: XCircle, tone: "danger" };
  if (event.type === "ball.handed") return { title: `球权交给 ${agentName(agents, event.holderAgentId)}`, detail: `${event.routing.mode === "parallel" ? "并行" : "串行"} ${event.routing.index}/${event.routing.total}`, icon: ArrowRight, tone: "active" };
  if (event.type === "ball.held") return { title: `${agentName(agents, event.hold.agentId)} 持球等待`, detail: `${event.hold.waitSourceRef.kind} · ${event.hold.waitSourceRef.expectedSignal}`, icon: Clock3, tone: "active" };
  if (event.type === "ball.wake_sent") return { title: `已唤醒 ${agentName(agents, event.agentId)}`, detail: shortId(event.holdId), icon: RefreshCw, tone: "active" };
  if (event.type === "ball.handed_user") return { title: "球权交回给你", detail: event.reason, icon: MessageSquare, tone: "active" };
  if (event.type === "ball.void_pass") return { title: "检测到虚空传球", detail: "handoff 未命中任何 Agent", icon: XCircle, tone: "danger" };
  if (event.type === "task.done") return { title: "协作球已闭环", detail: agentName(agents, event.agentId), icon: Check, tone: "success" };
  if (event.type === "clarification.requested") return { title: `${agentName(agents, event.agentId)} 先向你确认`, detail: event.questions.map((question) => typeof question === "string" ? question : question.question).join("；").slice(0, 120), icon: MessageSquare, tone: "active" };
  if (event.type === "deliverable.declared") return { title: event.kind === "plan" ? `${agentName(agents, event.agentId)} 提交了方案` : `${agentName(agents, event.agentId)} 声明任务完成`, detail: event.summary.slice(0, 120), icon: SendHorizontal, tone: "active" };
  if (event.type === "review.requested") return { title: `已送${reviewTypeLabel(event.reviewType)} ${agentName(agents, event.reviewerAgentId)}`, detail: `${agentName(agents, event.authorAgentId)} 的交付 · 第 ${event.round} 轮`, icon: ArrowRight, tone: "active" };
  if (event.type === "review.submitted") return { title: event.verdict === "approved" ? "作者与审核者达成共识" : `${agentName(agents, event.reviewerAgentId)} 提出异议`, detail: event.summary, icon: event.verdict === "approved" ? Check : RefreshCw, tone: event.verdict === "approved" ? "success" : "danger" };
  if (event.type === "review.rework") return { title: `${agentName(agents, event.authorAgentId)} 继续协商`, detail: `回应第 ${event.round} 轮审核意见`, icon: RefreshCw, tone: "active" };
  if (event.type === "review.resolved") return { title: reviewOutcomeTitle(event.outcome), detail: event.detail ?? `共 ${event.rounds} 轮审核`, icon: event.outcome === "approved" ? Check : XCircle, tone: event.outcome === "approved" ? "success" : event.outcome === "cancelled" ? "neutral" : "danger" };
  if (event.type === "plan.awaiting-approval") return { title: `${agentName(agents, event.authorAgentId)} 的计划等待你确认`, detail: PLAN_PEER_LABELS[event.peerOutcome], icon: ListChecks, tone: "active" };
  if (event.type === "plan.decided") return { title: event.decision === "approved" ? "你通过了计划，开始执行" : "你打回了计划，重新规划", detail: event.note ?? shortId(event.taskRunId), icon: event.decision === "approved" ? ThumbsUp : ThumbsDown, tone: event.decision === "approved" ? "success" : "active" };
  if (event.type === "run.completed") return { title: `${agentName(agents, event.agentId)} 已完成`, detail: shortId(event.runId), icon: Check, tone: "success" };
  if (event.type === "run.failed") return { title: `${agentName(agents, event.agentId)} 运行失败`, detail: event.error, icon: XCircle, tone: "danger" };
  if (event.type === "run.cancelled") return { title: `${agentName(agents, event.agentId)} 已取消`, detail: event.reason, icon: Square, tone: "danger" };
  if (event.type === "run.interrupted") return { title: `${agentName(agents, event.agentId)} 上次运行中断`, detail: event.reason, icon: XCircle, tone: "danger" };
  return { title: "平台事件", detail: event.type, icon: Activity, tone: "neutral" };
}

function collaborationLabel(kind: ThreadMessageKind): string {
  if (kind === "review-request") return "送审";
  if (kind === "review-feedback") return "审核意见";
  if (kind === "wake") return "持球唤醒";
  return "结构化协作消息";
}

function collaborationProtocolLabel(
  item: Extract<TranscriptItem, { type: "collaboration" }>,
): string {
  const intent = item.collaborationIntent === "handoff"
    ? "交棒"
    : item.collaborationIntent === "fyi"
      ? "知会"
      : item.collaborationIntent === "done_notify"
        ? "完成通知"
        : collaborationLabel(item.kind);
  return item.routingMode ? `${intent} · ${item.routingMode === "parallel" ? "并行" : "串行"}` : intent;
}

function reviewOutcomeTitle(outcome: "approved" | "escalated" | "cancelled"): string {
  if (outcome === "approved") return "双方达成共识，任务完成";
  if (outcome === "cancelled") return "审核已随协作链取消";
  return "审核未通过，需要人工介入";
}

/** Verifying a completion claim reads differently from critiquing a plan. */
function reviewTypeLabel(reviewType: ReviewType | undefined): string {
  return reviewType === "critique" ? "评审" : "核对";
}

const REVIEW_ESCALATION_LABELS: Record<ReviewEscalation, string> = {
  "no-reviewer": "没有可用于审核的其他 Agent",
  inconclusive: "审核 Agent 未登记正式结论",
  "review-failed": "审核未能完成",
  "max-rounds": "协商轮数已用完，双方仍有分歧，请你裁决",
  "clarification-needed": "Agent 需要你先补充关键信息",
};

function ReviewCard({ review, agents }: { review: ReviewState; agents: AgentSummary[] }) {
  const reviewer = review.reviewerAgentId ? agentName(agents, review.reviewerAgentId) : "另一个 Agent";
  const kind = reviewTypeLabel(review.reviewType);
  const title =
    review.status === "pending" ? `等待 ${reviewer} ${kind}（第 ${review.round} 轮）`
    : review.status === "approved" ? (review.reviewType === "critique" ? `双方就方案达成共识` : `双方就交付结果达成共识`)
    : review.status === "changes-requested" ? `${reviewer} 提出异议，正在协商（第 ${review.round} 轮）`
    : review.status === "cancelled" ? `${kind}已随协作链取消`
    : review.unstructured ? `${reviewer} 已给出文字意见，等待你处理`
    : review.escalation === "max-rounds" ? "双方仍有分歧，需要你裁决"
    : "需要人工介入";
  return (
    <div className={`review-card review-card--${review.status}`}>
      <div className="review-card-title">
        {review.status === "approved" ? <Check size={13} /> : review.status === "pending" ? <Clock3 size={13} /> : review.status === "changes-requested" ? <RefreshCw size={13} /> : <XCircle size={13} />}
        <strong>{title}</strong>
      </div>
      {review.status === "escalated" && review.escalation && <p>{REVIEW_ESCALATION_LABELS[review.escalation]}</p>}
      {review.detail && <p>{review.detail}</p>}
      {review.unstructured && <p className="review-card-unstructured-note">以下是审核者的原始回复；由于没有调用 submit_review，它不是已登记的正式结论。</p>}
      {review.summary && (review.unstructured
        ? <div className="review-card-unstructured markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{review.summary}</ReactMarkdown></div>
        : <p>{review.summary}</p>)}
      {review.findings && review.findings.length > 0 && (
        <ul>{review.findings.map((finding, index) => <li key={`${index}-${finding}`}>{finding}</li>)}</ul>
      )}
      {review.checks && review.checks.length > 0 && (
        <>
          <p className="review-card-checks-title">审核者自己验证过的：</p>
          <ul>{review.checks.map((check, index) => <li key={`${index}-${check}`}>{check}</li>)}</ul>
        </>
      )}
    </div>
  );
}

function ClarificationCard({ request, busy, onSubmit }: { request: ClarificationRequest; busy: boolean; onSubmit(answers: string[]): Promise<boolean> }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const current = request.questions[step];
  if (!current) return null;
  const question = typeof current === "string" ? { question: current } : current;
  const choose = (answer: string) => {
    const next = [...answers, answer];
    if (step + 1 < request.questions.length) { setAnswers(next); setStep(step + 1); setCustom(""); }
    else { setSubmitted(true); void onSubmit(next).then((success) => { if (!success) setSubmitted(false); }); }
  };
  return <div className="clarification-card">
    <div className="clarification-title"><MessageSquare size={14} /><strong>需要你确认</strong><span>{step + 1} / {request.questions.length}</span></div>
    <p className="clarification-question">{question.question}</p>
    {submitted ? <p className="clarification-submitted"><Check size={13} />已提交，等待 Agent 继续</p> : <><div className="clarification-options">{question.options?.map((option) => <button type="button" key={`${option.label}-${option.value ?? ""}`} disabled={busy} onClick={() => choose(option.value ?? option.label)}>{option.label}{option.recommended && <em>推荐</em>}</button>)}</div><div className="clarification-custom"><input value={custom} disabled={busy} onChange={(event) => setCustom(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && custom.trim()) choose(custom.trim()); }} placeholder={question.options?.length ? "或输入其他答案…" : "输入你的答案…"} /><button type="button" disabled={busy || !custom.trim()} onClick={() => choose(custom.trim())}>{step + 1 === request.questions.length ? "提交" : "下一题"}<ArrowRight size={13} /></button></div></>}
  </div>;
}

const PLAN_PEER_LABELS: Record<PlanPeerOutcome, string> = {
  approved: "作者与同伴已达成共识",
  escalated: "同伴评审没有通过",
  skipped: "没有同伴评审（评审开关已关闭）",
};

/**
 * The last gate before anything gets built. Peers advise; this card is where a
 * person decides, so it keeps the plan itself in view rather than a summary of
 * it — approving what you cannot read is not approving.
 */
function PlanCard({
  plan,
  agents,
  busy,
  onDecide,
}: {
  plan: PlanState;
  agents: AgentSummary[];
  busy: boolean;
  onDecide(taskRunId: string, decision: PlanDecision, note: string): void;
}) {
  const [note, setNote] = useState("");
  const author = agentName(agents, plan.authorAgentId);
  const reviewer = plan.reviewerAgentId ? agentName(agents, plan.reviewerAgentId) : undefined;
  if (plan.decision) {
    return (
      <div className={`plan-card plan-card--${plan.decision}`}>
        <div className="plan-card-title">
          {plan.decision === "approved" ? <ThumbsUp size={13} /> : <ThumbsDown size={13} />}
          <strong>{plan.decision === "approved" ? `你已通过该计划，${author} 开始执行` : `你已打回该计划，${author} 正在修订`}</strong>
        </div>
        {plan.note && <p className="plan-card-note">{plan.note}</p>}
      </div>
    );
  }
  return (
    <div className="plan-card plan-card--pending">
      <div className="plan-card-title">
        <ListChecks size={13} />
        <strong>{author} 的计划等待你确认</strong>
      </div>
      <p className="plan-card-peer">
        {PLAN_PEER_LABELS[plan.peerOutcome]}
        {reviewer ? ` · ${reviewer}` : ""}
        {plan.rounds > 0 ? ` · ${plan.rounds} 轮` : ""}
        {plan.escalation ? ` · ${REVIEW_ESCALATION_LABELS[plan.escalation]}` : ""}
      </p>
      {plan.peerSummary && <p className="plan-card-summary">{plan.peerSummary}</p>}
      <div className="plan-card-body markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan.plan}</ReactMarkdown>
      </div>
      <textarea
        className="plan-card-input"
        value={note}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        placeholder="批注：通过时可留空；打回时必须说明要改什么"
        aria-label="计划批注"
        disabled={busy}
      />
      <div className="plan-card-actions">
        <button
          type="button"
          className="plan-approve"
          disabled={busy}
          onClick={() => onDecide(plan.taskRunId, "approved", note.trim())}
        >
          <ThumbsUp size={13} />通过并执行
        </button>
        <button
          type="button"
          className="plan-reject"
          disabled={busy || !note.trim()}
          title={note.trim() ? undefined : "打回前请先写明要改什么"}
          onClick={() => onDecide(plan.taskRunId, "rejected", note.trim())}
        >
          <ThumbsDown size={13} />打回重做
        </button>
      </div>
    </div>
  );
}

function RunActivity({ item }: { item: Extract<TranscriptItem, { type: "agent" }> }) {
  const [showThinking, setShowThinking] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  if (!item.thinking && item.tools.length === 0 && item.notices.length === 0) return null;
  return (
    <div className="run-activity">
      {item.notices.map((notice, index) => <p className="run-notice" key={`${index}-${notice}`}><RefreshCw size={12} />{notice}</p>)}
      {item.thinking && (
        <div className="run-thinking">
          <button type="button" onClick={() => setShowThinking((current) => !current)} aria-expanded={showThinking}>
            <Sparkles size={12} />思考过程<ChevronDown size={12} className={showThinking ? "rotated" : ""} />
          </button>
          {showThinking && <pre>{item.thinking}</pre>}
        </div>
      )}
      {item.tools.length > 0 && (
        <ul className="run-tools">
          {item.tools.map((tool) => {
            const detail = expanded === tool.key;
            const hasDetail = Boolean(tool.args ?? tool.resultSummary);
            return (
              <li key={tool.key} className={tool.isError ? "run-tool--error" : tool.done ? "run-tool--done" : "run-tool--active"}>
                <button type="button" disabled={!hasDetail} onClick={() => setExpanded(detail ? undefined : tool.key)} aria-expanded={detail}>
                  <Wrench size={12} /><span>{tool.toolName}</span>
                  <i>{tool.done ? (tool.isError ? "失败" : "完成") : "运行中"}</i>
                  {hasDetail && <ChevronDown size={12} className={detail ? "rotated" : ""} />}
                </button>
                {detail && <div className="run-tool-detail">{tool.args && <pre><code>{tool.args}</code></pre>}{tool.resultSummary && <pre className="run-tool-result"><code>{tool.resultSummary}</code></pre>}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RunUsageBar({ usage }: { usage: RunUsage }) {
  const percent = usage.contextTokens !== undefined && usage.contextWindow ? Math.min(100, Math.round((usage.contextTokens / usage.contextWindow) * 100)) : undefined;
  return (
    <div className="run-usage">
      <span title="输入 / 输出 / 缓存命中">{formatTokens(usage.inputTokens)} 入 · {formatTokens(usage.outputTokens)} 出{usage.cacheReadTokens > 0 ? ` · ${formatTokens(usage.cacheReadTokens)} 缓存` : ""}</span>
      {usage.costUsd > 0 && <span>${usage.costUsd.toFixed(4)}</span>}
      {percent !== undefined && <span className={percent >= 80 ? "run-usage--tight" : ""}>上下文 {percent}%</span>}
    </div>
  );
}

function formatTokens(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value); }

function AgentAvatar({ agentId, variant }: { agentId: string; variant?: "reviewer" }) {
  // A reviewer tile reads as "review", not as its handle, so it keeps the one
  // colour that means that and skips the per-handle tone.
  const tone = variant ? "agent-avatar--reviewer" : `agent-avatar--tone-${agentAvatarTone(agentId)}`;
  return <span className={`agent-avatar ${tone}`} title={`@${agentId}`}>{agentInitials(agentId)}</span>;
}

function AgentRouteChip({ agentId, agents }: { agentId: string; agents: AgentSummary[] }) {
  return <span className="agent-route-chip" title={`@${agentId}`}><AgentAvatar agentId={agentId} /><span>{agentName(agents, agentId)}</span></span>;
}

function agentReplyLabel(item: Extract<TranscriptItem, { type: "agent" }>, agents: AgentSummary[]): string {
  if (item.purpose === "review") return item.replyToAgentId ? `审核 ${agentName(agents, item.replyToAgentId)} 的交付` : "同行审核";
  if (item.replyToAgentId && item.incomingKind === "review-feedback") return `与 ${agentName(agents, item.replyToAgentId)} 继续协商`;
  if (item.replyToAgentId && item.incomingKind === "collaboration") return `回应 ${agentName(agents, item.replyToAgentId)} 的转交`;
  if (item.replyToAgentId) return `回复 ${agentName(agents, item.replyToAgentId)}`;
  return item.replyToHuman ? "回复你" : "独立运行";
}

function stripLeadingMentions(content: string, mentions: string[]): string {
  if (mentions.length === 0) return content;
  const targetIds = new Set(mentions.map((id) => id.toLocaleLowerCase()));
  let rest = content.trimStart();
  let removed = false;
  while (true) {
    const match = rest.match(/^@([a-z][a-z0-9-]*)(?:\s+|$)/i);
    if (!match || !targetIds.has(match[1]!.toLocaleLowerCase())) break;
    rest = rest.slice(match[0].length);
    removed = true;
  }
  return removed && rest.trim() ? rest.trimStart() : content;
}

function compactMessagePreview(content: string): string {
  const clean = content
    .replace(/^(?:@[a-z][a-z0-9-]*\s*)+/i, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > 180 ? `${clean.slice(0, 180).trimEnd()}…` : clean;
}

function addUnique(values: string[] | undefined, value: string): void {
  if (values && !values.includes(value)) values.push(value);
}

function buildThreads(events: StoredPlatformEvent[]): ThreadSummary[] {
  const threads = new Map<string, ThreadSummary>();
  const activeRuns = new Map<string, { threadId: string; active: boolean }>();
  const activeHolds = new Map<string, { threadId: string; active: boolean }>();
  for (const event of events) {
    if (event.type === "thread.created") {
      threads.set(event.thread.id, { ...event.thread, updatedAt: event.recordedAt, hasActiveRun: false });
      continue;
    }
    if (event.type === "run.queued") {
      activeRuns.set(event.run.id, { threadId: event.run.threadId, active: true });
    } else if (isTerminalEvent(event)) {
      const run = activeRuns.get(event.runId);
      if (run) run.active = false;
    } else if (event.type === "ball.held") {
      activeHolds.set(event.hold.id, { threadId: event.hold.threadId, active: true });
    } else if (event.type === "ball.wake_sent" || event.type === "ball.hold_cancelled") {
      const hold = activeHolds.get(event.holdId);
      if (hold) hold.active = false;
    }
    const threadId = eventThreadId(event);
    const thread = threadId ? threads.get(threadId) : undefined;
    if (thread) thread.updatedAt = event.recordedAt;
  }
  for (const run of activeRuns.values()) if (run.active) { const thread = threads.get(run.threadId); if (thread) thread.hasActiveRun = true; }
  for (const hold of activeHolds.values()) if (hold.active) { const thread = threads.get(hold.threadId); if (thread) thread.hasActiveRun = true; }
  return [...threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function buildTranscript(events: StoredPlatformEvent[], threadId?: string): TranscriptItem[] {
  if (!threadId) return [];
  const items: TranscriptItem[] = [];
  const runs = new Map<string, Extract<TranscriptItem, { type: "agent" }>>();
  const reviewRuns = new Map<string, Extract<TranscriptItem, { type: "agent" }>>();
  const messages = new Map<string, Extract<StoredPlatformEvent, { type: "message.created" }>["message"]>();
  const humanMessages = new Map<string, Extract<TranscriptItem, { type: "human" }>>();
  for (const event of events) {
    if (event.type === "message.created" && event.message.threadId === threadId) {
      messages.set(event.message.id, event.message);
      if (event.message.sender.type === "human") {
        const item: Extract<TranscriptItem, { type: "human" }> = {
          id: event.message.id,
          type: "human",
          content: stripLeadingMentions(event.message.content, event.message.mentions),
          createdAt: event.message.createdAt,
          targets: [...event.message.mentions],
          explicitlyDirected: event.message.mentions.length > 0,
        };
        items.push(item);
        humanMessages.set(event.message.id, item);
      } else if (event.message.kind === "collaboration") {
        items.push({ id: event.message.id, type: "collaboration", agentId: event.message.sender.id, content: event.message.content, mentions: event.message.mentions, createdAt: event.message.createdAt, kind: event.message.kind, ...(event.message.collaborationIntent ? { collaborationIntent: event.message.collaborationIntent } : {}), ...(event.message.routingMode ? { routingMode: event.message.routingMode } : {}) });
      }
      // review-request/review-feedback are internal transport prompts. Their
      // state and outcome are already represented by the review run/card.
      continue;
    }
    if (event.type === "run.queued" && event.run.threadId === threadId) {
      const incoming = messages.get(event.run.incomingMessageId);
      const item: Extract<TranscriptItem, { type: "agent" }> = { id: event.run.id, type: "agent", agentId: event.run.agentId, content: "", createdAt: event.recordedAt, status: "queued", thinking: "", tools: [], notices: [], purpose: event.run.purpose ?? "task", ...(event.run.reviewRound ? { reviewRound: event.run.reviewRound } : {}), ...(event.run.mode === "plan" ? { planMode: true } : {}), ...(event.run.routing ? { routing: { mode: event.run.routing.mode, index: event.run.routing.index, total: event.run.routing.total } } : {}), ...(incoming?.sender.type === "human" ? { replyToHuman: true } : {}), ...(incoming?.sender.type === "agent" ? { replyToAgentId: incoming.sender.id } : {}), ...(incoming ? { incomingKind: incoming.kind } : {}) };
      items.push(item);
      runs.set(event.run.id, item);
      if ((event.run.purpose ?? "task") === "review" && event.run.taskRunId) {
        reviewRuns.set(event.run.taskRunId, item);
      }
      if (incoming?.sender.type === "human") addUnique(humanMessages.get(incoming.id)?.targets, event.run.agentId);
      continue;
    }
    if (event.type === "review.requested" || event.type === "review.submitted" || event.type === "review.rework" || event.type === "review.resolved") {
      if (event.threadId !== threadId) continue;
      applyReviewEvent(runs.get(event.taskRunId), event, reviewRuns.get(event.taskRunId)?.content);
      continue;
    }
    if (event.type === "plan.awaiting-approval" || event.type === "plan.decided") {
      if (event.threadId !== threadId) continue;
      applyPlanEvent(runs.get(event.taskRunId), event);
      continue;
    }
    if (event.type === "clarification.requested") {
      if (event.threadId !== threadId) continue;
      const run = runs.get(event.runId);
      if (run) run.clarification = { runId: event.runId, agentId: event.agentId, questions: event.questions };
      continue;
    }
    if (!("runId" in event) || event.threadId !== threadId) continue;
    const run = runs.get(event.runId);
    if (!run) continue;
    if (event.type === "run.started") run.status = "running";
    else if (event.type === "run.delta") { run.content += event.text; run.status = "running"; }
    else if (event.type === "run.thinking") { run.thinking += event.text; run.status = "running"; }
    // Auto-retry re-streams the turn, so everything shown so far is stale.
    else if (event.type === "run.reset") { run.content = ""; run.thinking = ""; }
    else if (event.type === "run.tool") applyToolEvent(run, event);
    else if (event.type === "run.usage") { const { type: _type, runId: _runId, threadId: _threadId, agentId: _agentId, eventId: _eventId, recordedAt: _recordedAt, ...usage } = event; run.usage = usage; }
    else if (event.type === "run.lifecycle") run.notices.push(lifecycleLabel(event.phase, event.detail));
    else if (event.type === "run.diagnostic") run.notices.push(`${event.source === "extension" ? "扩展" : "运行时"}：${event.message}`);
    else if (event.type === "run.steered") { run.notices.push("已插入新的用户消息"); addUnique(humanMessages.get(event.messageId)?.targets, event.agentId); }
    else if (event.type === "run.completed") { run.content = event.output; run.status = "completed"; }
    else if (event.type === "run.failed") { run.content = event.error; run.status = "failed"; }
    else if (event.type === "run.cancelled") { run.content = event.reason; run.status = "cancelled"; }
    else if (event.type === "run.interrupted") { run.content = event.reason; run.status = "interrupted"; }
  }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Plan state lives on the plan task run, across critique and human rounds. */
function applyPlanEvent(
  run: Extract<TranscriptItem, { type: "agent" }> | undefined,
  event: Extract<StoredPlatformEvent, { type: "plan.awaiting-approval" | "plan.decided" }>,
): void {
  if (!run) return;
  if (event.type === "plan.awaiting-approval") {
    run.plan = {
      taskRunId: event.taskRunId,
      authorAgentId: event.authorAgentId,
      plan: event.plan,
      peerOutcome: event.peerOutcome,
      rounds: event.rounds,
      ...(event.reviewerAgentId ? { reviewerAgentId: event.reviewerAgentId } : {}),
      ...(event.peerSummary ? { peerSummary: event.peerSummary } : {}),
      ...(event.escalation ? { escalation: event.escalation } : {}),
    };
    return;
  }
  if (!run.plan) return;
  run.plan = { ...run.plan, decision: event.decision, ...(event.note ? { note: event.note } : {}) };
}

type ReviewEvent = Extract<
  StoredPlatformEvent,
  { type: "review.requested" | "review.submitted" | "review.rework" | "review.resolved" }
>;

/** Review state lives on the originating task run, across every discussion round. */
function applyReviewEvent(
  run: Extract<TranscriptItem, { type: "agent" }> | undefined,
  event: ReviewEvent,
  unstructuredReviewerOutput?: string,
): void {
  if (!run) return;
  const current = run.review;
  if (event.type === "review.requested") {
    run.review = {
      status: "pending",
      reviewerAgentId: event.reviewerAgentId,
      round: event.round,
      reviewType: event.reviewType ?? "verify",
    };
    return;
  }
  if (event.type === "review.submitted") {
    run.review = {
      ...(current ?? { status: "pending", round: 1 }),
      status: event.verdict === "approved" ? "approved" : "changes-requested",
      summary: event.summary,
      ...(event.findings ? { findings: event.findings } : {}),
      ...(event.checks ? { checks: event.checks } : {}),
    };
    return;
  }
  if (event.type === "review.rework") {
    run.review = { ...(current ?? { status: "changes-requested", round: event.round }), status: "changes-requested", round: event.round };
    return;
  }
  const recoveredSummary =
    event.outcome === "escalated" &&
    !current?.summary &&
    unstructuredReviewerOutput?.trim()
      ? unstructuredReviewerOutput.trim()
      : undefined;
  run.review = {
    ...(current ?? { status: "pending", round: event.rounds }),
    status: event.outcome === "approved" ? "approved" : event.outcome === "cancelled" ? "cancelled" : "escalated",
    round: event.rounds,
    ...(event.escalation ? { escalation: event.escalation } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
    ...(recoveredSummary ? { summary: recoveredSummary, unstructured: true } : {}),
  };
}

function isAttentionRun(item: TranscriptItem): item is Extract<TranscriptItem, { type: "agent" }> {
  return item.type === "agent" && (
    (item.review?.status === "escalated" && !item.plan?.decision) ||
    Boolean(item.plan && !item.plan.decision)
  );
}

function applyToolEvent(run: Extract<TranscriptItem, { type: "agent" }>, event: Extract<StoredPlatformEvent, { type: "run.tool" }>): void {
  if (event.phase === "start") {
    run.tools.push({ key: event.toolCallId ?? event.eventId, toolName: event.toolName, done: false, ...(event.args ? { args: event.args } : {}) });
    return;
  }
  // Older runtimes report no call id, so fall back to the newest open call of
  // the same tool.
  const index = event.toolCallId
    ? run.tools.findIndex((tool) => tool.key === event.toolCallId)
    : run.tools.findLastIndex((tool) => tool.toolName === event.toolName && !tool.done);
  const tool = index >= 0 ? run.tools[index] : undefined;
  if (!tool) {
    run.tools.push({ key: event.toolCallId ?? event.eventId, toolName: event.toolName, done: true, isError: event.isError ?? false, ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}) });
    return;
  }
  tool.done = true;
  tool.isError = event.isError ?? false;
  if (event.resultSummary) tool.resultSummary = event.resultSummary;
}

function lifecycleLabel(phase: Extract<StoredPlatformEvent, { type: "run.lifecycle" }>["phase"], detail?: string): string {
  const label = { retry_start: "自动重试", retry_end: "重试结束", compaction_start: "正在压缩上下文", compaction_end: "上下文压缩结束" }[phase];
  return detail ? `${label}：${detail}` : label;
}

function findActiveChain(events: StoredPlatformEvent[], threadId?: string): string | undefined {
  if (!threadId) return undefined;
  const runs = new Map<string, { chainId: string; active: boolean; order: number }>();
  const holds = new Map<string, { chainId: string; active: boolean; order: number }>();
  let order = 0;
  for (const event of events) {
    if (event.type === "run.queued" && event.run.threadId === threadId) {
      runs.set(event.run.id, { chainId: event.run.causal.chainId, active: true, order: order++ });
    } else if (isTerminalEvent(event)) {
      const run = runs.get(event.runId);
      if (run) run.active = false;
    } else if (event.type === "ball.held" && event.hold.threadId === threadId) {
      holds.set(event.hold.id, { chainId: event.hold.chainId, active: true, order: order++ });
    } else if (event.type === "ball.wake_sent" || event.type === "ball.hold_cancelled") {
      const hold = holds.get(event.holdId);
      if (hold) hold.active = false;
    }
  }
  return [...runs.values(), ...holds.values()]
    .filter((candidate) => candidate.active)
    .sort((a, b) => b.order - a.order)[0]?.chainId;
}
function findFallbackAgent(agents: AgentSummary[], defaultAgentId: string | undefined, events: StoredPlatformEvent[], threadId?: string): AgentSummary | undefined { const online = (id: string) => agents.find((agent) => agent.id === id && agent.enabled && agent.availability.available); if (threadId) for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]; if (event?.type === "run.completed" && event.threadId === threadId) { const agent = online(event.agentId); if (agent) return agent; } } return (defaultAgentId ? online(defaultAgentId) : undefined) ?? agents.find((agent) => agent.enabled && agent.availability.available); }
function selectThreadEvents(events: StoredPlatformEvent[], threadId?: string): StoredPlatformEvent[] { if (!threadId) return []; const runIds = new Set(events.filter((event) => event.type === "run.queued" && event.run.threadId === threadId).map((event) => event.type === "run.queued" ? event.run.id : "")); return events.filter((event) => eventThreadId(event) === threadId || ("runId" in event && typeof event.runId === "string" && runIds.has(event.runId))); }
function eventThreadId(event: StoredPlatformEvent): string | undefined { if (event.type === "thread.created") return event.thread.id; if (event.type === "message.created") return event.message.threadId; if (event.type === "run.queued") return event.run.threadId; if ("threadId" in event && typeof event.threadId === "string") return event.threadId; return undefined; }
function isTerminalEvent(event: StoredPlatformEvent): event is Extract<StoredPlatformEvent, { type: "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted" }> { return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted"; }
function buildWorkspaceOptions(threads: ThreadSummary[], defaultWorkspace?: WorkspaceSummary): WorkspaceSummary[] { const workspaces = new Map<string, WorkspaceSummary>(); if (defaultWorkspace) workspaces.set(defaultWorkspace.path, defaultWorkspace); for (const thread of threads) { const path = thread.workingDirectory ?? defaultWorkspace?.path; if (path && !workspaces.has(path)) workspaces.set(path, { name: workspaceName(path), path }); } return [...workspaces.values()].slice(0, 6); }
function mergeHistoricalAgents(current: AgentSummary[], previous: AgentSummary[]): AgentSummary[] { const ids = new Set(current.map((agent) => agent.id)); return [...current, ...previous.filter((agent) => !ids.has(agent.id) && !agent.enabled)]; }
function workspaceName(path: string): string { const parts = path.split(/[\\/]/).filter(Boolean); return (parts.at(-1) ?? path) || "工作目录"; }
function cleanTitle(title: string): string { return title.replace(/^(?:@[a-z][a-z0-9-]*\s*){1,2}/i, "") || title; }
function agentName(agents: AgentSummary[], id: string): string { return agents.find((agent) => agent.id === id)?.displayName ?? id; }
function runtimeLabel(agent?: AgentSummary): string { if (!agent || agent.availability.label === "Historical Agent") return "历史 Agent"; return agent.runtime.kind === "pi" ? `Pi · ${agent.runtime.provider} · ${agent.runtime.model}` : `Codex${agent.runtime.model ? ` · ${agent.runtime.model}` : ""}`; }
function runtimeDetail(agent: AgentSummary | undefined, displayName: string): string | undefined { const label = runtimeLabel(agent); const family = agent?.runtime.kind === "pi" ? "Pi" : "Codex"; if (label.toLocaleLowerCase() === displayName.toLocaleLowerCase()) return undefined; if (displayName.toLocaleLowerCase() === family.toLocaleLowerCase() && label.startsWith(`${family} · `)) return label.slice(family.length + 3); return label; }
function statusLabel(status: ViewRunStatus, access?: AccessMode): string { if (status === "queued") return access === "read-only" ? "并行队列" : "等待会话/写锁"; return { running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" }[status]; }
function connectionLabel(configured: boolean, connection: string): string { if (!configured) return "等待运行时配置"; if (connection === "connected") return "团队服务已连接"; return connection === "reconnecting" ? "正在重新连接" : "正在连接"; }
function shortId(id: string): string { return id.split("_")[1]?.slice(0, 8) ?? id.slice(0, 8); }
function formatClock(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function formatRelativeTime(value: string): string { const difference = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(difference / 60_000)); if (minutes < 1) return "刚刚"; if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`; const days = Math.floor(hours / 24); return days < 7 ? `${days} 天前` : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
