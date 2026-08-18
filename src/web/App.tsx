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
  Menu,
  MessageSquare,
  Moon,
  PanelRight,
  Plus,
  RefreshCw,
  Save,
  SendHorizontal,
  Settings2,
  ShieldCheck,
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
  type ApiProviderId,
} from "../config/provider-presets";
import type {
  AccessMode,
  AgentCatalogV1,
  AgentDefinition,
  AgentSummary,
  StoredPlatformEvent,
  Thread,
  ThinkingLevel,
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
  | { id: string; type: "human"; content: string; createdAt: string }
  | {
      id: string;
      type: "collaboration";
      agentId: string;
      content: string;
      mentions: string[];
      createdAt: string;
    }
  | {
      id: string;
      type: "agent";
      agentId: string;
      content: string;
      createdAt: string;
      status: ViewRunStatus;
    };

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
  const [mentionAgent, setMentionAgent] = useState("codex");
  const [draft, setDraft] = useState("");
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
        setMentionAgent(next.catalog.defaultAgentId);
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
  }, [transcript.length, lastContent]);

  const newTask = () => {
    setSelectedThreadId(undefined);
    setDraft("");
    setActionError("");
    setDrawerOpen(false);
    setSidebarOpen(false);
  };

  const sendTask = async () => {
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
        }),
      });
      const result = (await response.json()) as { threadId?: string; error?: string };
      if (!response.ok || !result.threadId) throw new Error(result.error ?? "任务发送失败");
      setSelectedThreadId(result.threadId);
      setDraft("");
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSending(false);
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

  const saveCatalog = async (next: AgentCatalogV1) => {
    const response = await fetch("/api/agents", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(next),
    });
    const result = (await response.json()) as AgentsResponse;
    if (!response.ok || !result.catalog) throw new Error(result.error ?? "花名册保存失败");
    setData((current) => current ? { ...current, catalog: result.catalog, agents: mergeHistoricalAgents(result.agents, current.agents) } : current);
    setMentionAgent(result.catalog.defaultAgentId);
  };

  const finishSetup = (next: BootstrapData) => {
    setData(next);
    setMentionAgent(next.catalog.defaultAgentId);
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
        <div className="brand-row"><div className="brand-mark"><Sparkles size={16} /></div><span>Multi-Agent Office</span></div>
        <button className="new-task-button" type="button" onClick={newTask}><CirclePlus size={17} />新建任务<span className="shortcut">⌘ N</span></button>
        <label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" /></label>
        <div className="sidebar-section-title">任务</div>
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
          <button className={`details-button ${drawerOpen ? "details-button--active" : ""}`} type="button" onClick={() => setDrawerOpen(!drawerOpen)}><PanelRight size={16} />运行详情</button>
        </header>

        <section className="conversation">
          {loadError ? <div className="state-card state-card--error">{loadError}</div> : !data ? <div className="loading-state"><span />正在载入工作区…</div> : transcript.length > 0 ? (
            <div className="transcript">
              <div className="conversation-intro"><div className="intro-icon"><Bot size={18} /></div><span>{transcript.filter((item) => item.type === "agent").length} 次 Agent 运行</span>{activeChainId && <span className="live-indicator"><i />实时运行中</span>}</div>
              {transcript.map((item) => {
                if (item.type === "human") return <article className="human-message" key={item.id}><div>{item.content}</div></article>;
                if (item.type === "collaboration") return (
                  <article className="collaboration-message" key={item.id}>
                    <div className="collaboration-meta"><ArrowRight size={13} /><span>{agentName(data.agents, item.agentId)}</span><strong>结构化协作消息</strong>{item.mentions.map((id) => <i key={id}>@{id}</i>)}</div>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown>
                  </article>
                );
                const agent = data.agents.find((candidate) => candidate.id === item.agentId);
                return (
                  <article className="agent-message" key={item.id}>
                    <div className="agent-message-meta"><AgentAvatar agentId={item.agentId} /><span>{agentName(data.agents, item.agentId)}</span><small>{runtimeLabel(agent)}</small><span className={`status-label status-label--${item.status}`}>{statusLabel(item.status, agent?.accessMode)}</span></div>
                    <div className={`markdown-body ${item.status === "running" ? "markdown-body--streaming" : ""}`}>{item.content ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.content}</ReactMarkdown> : <div className="thinking-line"><span /><span /><span /></div>}</div>
                  </article>
                );
              })}
              <div ref={conversationEndRef} />
            </div>
          ) : <EmptyTask agents={data.agents} onSuggestion={setDraft} />}
        </section>

        {actionError && <div className="action-error" role="alert"><XCircle size={14} />{actionError}<button type="button" onClick={() => setActionError("")} aria-label="关闭错误"><X size={13} /></button></div>}
        <Composer agents={data?.agents ?? []} mentionAgent={mentionAgent} onMentionAgentChange={setMentionAgent} fallbackAgent={fallbackAgent} configured={configured} value={draft} onChange={setDraft} onSend={sendTask} onCancel={cancelTask} sending={sending} cancelling={cancelling} active={Boolean(activeChainId)} workspace={activeWorkspace} onWorkspaceClick={() => setWorkspacePickerOpen(true)} />
      </main>

      <DetailsDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} thread={selectedThread} agents={data?.agents ?? []} workspace={activeWorkspace} events={data?.events ?? []} />
      <WorkspacePicker open={workspacePickerOpen} current={activeWorkspace} recent={recentWorkspaces} onClose={() => setWorkspacePickerOpen(false)} onSelect={(workspace) => { setSelectedWorkspace(workspace); setSelectedThreadId(undefined); setDrawerOpen(false); setSidebarOpen(false); setWorkspacePickerOpen(false); }} />
      {data && <AgentCatalogEditor open={catalogOpen} catalog={data.catalog} agents={data.agents} onClose={() => setCatalogOpen(false)} onSave={saveCatalog} />}
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
  const selectedProvider = API_PROVIDER_PRESETS.find((item) => item.id === provider)!;

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
            <div className="provider-grid">
              {API_PROVIDER_PRESETS.map((item) => (
                <button
                  className={`provider-option ${provider === item.id ? "provider-option--selected" : ""}`}
                  type="button"
                  key={item.id}
                  onClick={() => setProvider(item.id)}
                  aria-pressed={provider === item.id}
                >
                  <span>{item.label}</span>
                  {provider === item.id && <Check size={14} />}
                </button>
              ))}
            </div>
            <p className="provider-description">{selectedProvider.description} · 默认模型 {selectedProvider.model}</p>
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
  const handles = enabled.slice(0, 2).map((agent) => `@${agent.id}`);
  const directedPrompt = handles.length > 1
    ? `${handles.join(" ")} 请分别评估当前架构，并给出各自的改进建议。`
    : `${handles[0] ?? ""} 请评估当前架构，并给出改进建议。`.trim();
  return <div className="empty-task"><div className="empty-task-mark"><Sparkles size={24} /></div><h1>让 Agent 帮你完成工作</h1><p>{handles.length > 1 ? `在正文中写 ${handles.join(" 或 ")} 可指定 Agent；` : handles.length === 1 ? `在正文中写 ${handles[0]} 可指定 Agent；` : ""}无 @ 时会交给最近成功回复且在线的默认 Agent。</p><div className="suggestion-grid"><button type="button" onClick={() => onSuggestion(directedPrompt)}>{handles.length > 1 ? "让两个 Agent 独立评估" : "让 Agent 评估当前架构"}</button><button type="button" onClick={() => onSuggestion("请实现这个需求，并在必要时通过 post_message 邀请队友。")}>由默认 Agent 自主完成</button></div></div>;
}

interface ComposerProps {
  agents: AgentSummary[];
  mentionAgent: string;
  onMentionAgentChange(value: string): void;
  fallbackAgent?: AgentSummary;
  configured: boolean;
  value: string;
  onChange(value: string): void;
  onSend(): void;
  onCancel(): void;
  sending: boolean;
  cancelling: boolean;
  active: boolean;
  workspace?: WorkspaceSummary;
  onWorkspaceClick(): void;
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
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); props.onSend(); } };
  const disabled = !props.configured || !props.value.trim() || props.sending;
  return <div className="composer-wrap">{!props.configured && <div className="credential-warning">当前没有可用 Agent；请打开花名册检查 Pi 密钥或 Codex 登录状态。</div>}<div className="composer">
    {suggestions.length > 0 && <div className="mention-menu">{suggestions.map((agent) => <button type="button" key={agent.id} onMouseDown={(event) => { event.preventDefault(); insertMention(agent.id, true); }}><AgentAvatar agentId={agent.id} /><span><strong>@{agent.id}</strong><small>{agent.displayName} · {agent.availability.available ? "在线" : "离线"}</small></span></button>)}</div>}
    <textarea ref={textareaRef} value={props.value} onChange={(event) => { props.onChange(event.target.value); setCursor(event.target.selectionStart); }} onClick={(event) => setCursor(event.currentTarget.selectionStart)} onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)} onKeyDown={onKeyDown} placeholder="描述任务；输入 @ 可指定最多两个 Agent…" rows={2} disabled={!props.configured} aria-label="任务内容" />
    <div className="composer-toolbar"><button className="composer-workspace" type="button" onClick={props.onWorkspaceClick} title={props.workspace?.path} aria-label="选择工作目录"><Folder size={14} /><span>{props.workspace?.name ?? "选择目录"}</span></button><label className="agent-select" title="选择后插入 @mention"><AgentAvatar agentId={props.mentionAgent} /><select value={props.mentionAgent} onChange={(event) => { props.onMentionAgentChange(event.target.value); insertMention(event.target.value); }} disabled={!props.configured} aria-label="插入 Agent mention">{props.agents.filter((agent) => agent.enabled).map((agent) => <option value={agent.id} key={agent.id} disabled={!agent.availability.available}>@{agent.id}{agent.availability.available ? "" : "（离线）"}</option>)}</select><ChevronDown size={14} /></label><span className="fallback-hint">无 @ → @{props.fallbackAgent?.id ?? "—"}</span><span className="composer-hint">Enter 发送 · Shift Enter 换行</span>{props.active ? <button className="stop-button" type="button" onClick={props.onCancel} disabled={props.cancelling} aria-label="停止整个协作链"><Square size={11} fill="currentColor" /></button> : <button className="send-button" type="button" onClick={props.onSend} disabled={disabled} aria-label="发送任务">{props.sending ? <span className="button-spinner" /> : <SendHorizontal size={17} />}</button>}</div>
  </div></div>;
}

interface CatalogEditorProps { open: boolean; catalog: AgentCatalogV1; agents: AgentSummary[]; onClose(): void; onSave(catalog: AgentCatalogV1): Promise<void> }

function AgentCatalogEditor({ open, catalog, agents, onClose, onSave }: CatalogEditorProps) {
  const [draft, setDraft] = useState<AgentCatalogV1>(() => structuredClone(catalog));
  const [selectedId, setSelectedId] = useState(catalog.defaultAgentId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const originalIds = useMemo(() => new Set(catalog.agents.map((agent) => agent.id)), [catalog]);
  useEffect(() => { if (open) { setDraft(structuredClone(catalog)); setSelectedId(catalog.defaultAgentId); setError(""); } }, [open, catalog]);
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
    <div className="form-grid"><label>Runtime<select value={selected.runtime.kind} onChange={(event) => update({ runtime: event.target.value === "pi" ? { kind: "pi", provider: "zai-coding-cn", model: "glm-5.2", thinkingLevel: "medium" } : { kind: "codex", command: "codex" } })}><option value="codex">Codex CLI</option><option value="pi">Pi SDK</option></select></label><label>访问级别<select value={selected.accessMode} onChange={(event) => update({ accessMode: event.target.value as AccessMode })}><option value="read-only">read-only</option><option value="workspace-write">workspace-write</option><option value="full">full</option></select></label></div>
    {selected.runtime.kind === "pi" ? <div className="form-grid form-grid--three"><label>Provider<input value={selected.runtime.provider} onChange={(event) => update({ runtime: { ...selected.runtime, provider: event.target.value } as AgentDefinition["runtime"] })} /></label><label>Model<input value={selected.runtime.model} onChange={(event) => update({ runtime: { ...selected.runtime, model: event.target.value } as AgentDefinition["runtime"] })} /></label><label>Thinking<select value={selected.runtime.thinkingLevel} onChange={(event) => update({ runtime: { ...selected.runtime, thinkingLevel: event.target.value as ThinkingLevel } as AgentDefinition["runtime"] })}>{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => <option key={level}>{level}</option>)}</select></label></div> : <><div className="form-grid"><label>CLI 路径<input value={selected.runtime.command} onChange={(event) => update({ runtime: { ...selected.runtime, command: event.target.value } as AgentDefinition["runtime"] })} /></label><label>Model<input value={selected.runtime.model ?? ""} placeholder="使用 profile 默认值" onChange={(event) => update({ runtime: { ...selected.runtime, model: event.target.value || undefined } as AgentDefinition["runtime"] })} /></label></div><div className="form-grid"><label>Profile<input value={selected.runtime.profile ?? ""} onChange={(event) => update({ runtime: { ...selected.runtime, profile: event.target.value || undefined } as AgentDefinition["runtime"] })} /></label><label>Reasoning<select value={selected.runtime.reasoningEffort ?? ""} onChange={(event) => update({ runtime: { ...selected.runtime, reasoningEffort: (event.target.value || undefined) as "low" | "medium" | "high" | "xhigh" | undefined } as AgentDefinition["runtime"] })}><option value="">profile 默认值</option>{["low", "medium", "high", "xhigh"].map((level) => <option key={level}>{level}</option>)}</select></label></div></>}
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
  const threadEvents = useMemo(() => selectThreadEvents(events, thread?.id), [events, thread?.id]); const runCount = threadEvents.filter((event) => event.type === "run.queued").length; const toolCount = threadEvents.filter((event) => event.type === "run.tool" && event.phase === "start").length; const messageCount = threadEvents.filter((event) => event.type === "message.created").length; const timeline = threadEvents.filter((event) => event.type !== "run.delta" && event.type !== "thread.created");
  return <>{open && <button className="drawer-scrim" type="button" onClick={onClose} aria-label="关闭运行详情" />}<aside className={`details-drawer ${open ? "details-drawer--open" : ""}`} aria-hidden={!open}><header className="drawer-header"><div><strong>运行详情</strong><span>{thread ? cleanTitle(thread.title) : "尚未创建任务"}</span></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭运行详情"><X size={18} /></button></header><div className="drawer-content"><section className="drawer-section workspace-card"><Folder size={16} /><div><span>工作目录与写锁作用域</span><code title={workspace?.path}>{workspace?.path ?? "正在读取"}</code></div></section><section className="drawer-section"><h2>概览</h2><div className="stat-grid"><div><strong>{runCount}</strong><span>运行</span></div><div><strong>{messageCount}</strong><span>消息</span></div><div><strong>{toolCount}</strong><span>工具</span></div></div></section><section className="drawer-section"><h2>团队运行时健康</h2><div className="agent-roster">{agents.map((agent) => <div className="roster-item" key={agent.id}><AgentAvatar agentId={agent.id} /><span><strong>{agent.displayName} · {runtimeLabel(agent)}</strong><small>@{agent.id} · {agent.accessMode} · {agent.availability.label}</small></span><i>{!agent.enabled ? "已停用" : threadEvents.some((event) => event.type === "run.started" && event.agentId === agent.id) ? "已参与" : agent.availability.available ? "待命" : "离线"}</i></div>)}</div></section><section className="drawer-section"><h2>A2A 与运行时间线</h2>{timeline.length > 0 ? <div className="event-timeline">{timeline.map((event) => <TimelineEvent event={event} agents={agents} key={event.eventId} />)}</div> : <p className="drawer-empty">发送任务后，这里会显示 session、排队、工具调用、结构化转交和运行状态。</p>}</section></div></aside></>;
}

function TimelineEvent({ event, agents }: { event: StoredPlatformEvent; agents: AgentSummary[] }) { const description = describeEvent(event, agents); const Icon = description.icon; return <div className={`timeline-event timeline-event--${description.tone}`}><span className="timeline-icon"><Icon size={13} /></span><div><strong>{description.title}</strong><span>{description.detail}</span></div><time>{formatClock(event.recordedAt)}</time></div>; }

function describeEvent(event: StoredPlatformEvent, agents: AgentSummary[]) {
  if (event.type === "message.created") { const sender = event.message.sender.type === "human" ? "用户" : agentName(agents, event.message.sender.id); const targets = event.message.mentions.length ? ` → ${event.message.mentions.map((id) => `@${id}`).join(" ")}` : ""; return { title: event.message.kind === "collaboration" ? "协作消息已发布" : "消息已记录", detail: `${sender}${targets}`, icon: MessageSquare, tone: "neutral" }; }
  if (event.type === "run.queued") return { title: `${agentName(agents, event.run.agentId)} 已排队`, detail: `${event.run.accessMode === "read-only" ? "可并行" : "等待工作区写锁"} · 深度 ${event.run.causal.depth}`, icon: Clock3, tone: "neutral" };
  if (event.type === "run.started") return { title: `${agentName(agents, event.agentId)} 开始运行`, detail: shortId(event.runId), icon: Activity, tone: "active" };
  if (event.type === "run.session") return { title: `${agentName(agents, event.agentId)} ${event.resumed ? "恢复" : "创建"} session`, detail: event.runtimeKind, icon: Bot, tone: "neutral" };
  if (event.type === "context.delivered") return { title: `上下文已交付给 ${agentName(agents, event.agentId)}`, detail: event.truncated ? "已按 24,000 字符截断" : shortId(event.messageId), icon: MessageSquare, tone: event.truncated ? "danger" : "neutral" };
  if (event.type === "run.tool") return { title: event.phase === "start" ? `调用 ${event.toolName}` : `${event.toolName} ${event.isError ? "失败" : "完成"}`, detail: shortId(event.runId), icon: Wrench, tone: event.isError ? "danger" : "neutral" };
  if (event.type === "routing.accepted") return { title: `结构化转交给 ${agentName(agents, event.targetAgentId)}`, detail: "post_message 已接受", icon: ArrowRight, tone: "active" };
  if (event.type === "routing.rejected") return { title: "Agent 路由被拒绝", detail: event.reason, icon: XCircle, tone: "danger" };
  if (event.type === "run.completed") return { title: `${agentName(agents, event.agentId)} 已完成`, detail: shortId(event.runId), icon: Check, tone: "success" };
  if (event.type === "run.failed") return { title: `${agentName(agents, event.agentId)} 运行失败`, detail: event.error, icon: XCircle, tone: "danger" };
  if (event.type === "run.cancelled") return { title: `${agentName(agents, event.agentId)} 已取消`, detail: event.reason, icon: Square, tone: "danger" };
  if (event.type === "run.interrupted") return { title: `${agentName(agents, event.agentId)} 上次运行中断`, detail: event.reason, icon: XCircle, tone: "danger" };
  return { title: "平台事件", detail: event.type, icon: Activity, tone: "neutral" };
}

function AgentAvatar({ agentId }: { agentId: string }) { return <span className={`agent-avatar agent-avatar--${agentId}`}>{agentId.slice(0, 1).toUpperCase()}</span>; }

function buildThreads(events: StoredPlatformEvent[]): ThreadSummary[] {
  const threads = new Map<string, ThreadSummary>(); const activeRuns = new Map<string, { threadId: string; active: boolean }>();
  for (const event of events) { if (event.type === "thread.created") { threads.set(event.thread.id, { ...event.thread, updatedAt: event.recordedAt, hasActiveRun: false }); continue; } if (event.type === "run.queued") activeRuns.set(event.run.id, { threadId: event.run.threadId, active: true }); else if (isTerminalEvent(event)) { const run = activeRuns.get(event.runId); if (run) run.active = false; } const threadId = eventThreadId(event); const thread = threadId ? threads.get(threadId) : undefined; if (thread) thread.updatedAt = event.recordedAt; }
  for (const run of activeRuns.values()) if (run.active) { const thread = threads.get(run.threadId); if (thread) thread.hasActiveRun = true; }
  return [...threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function buildTranscript(events: StoredPlatformEvent[], threadId?: string): TranscriptItem[] {
  if (!threadId) return []; const items: TranscriptItem[] = []; const runs = new Map<string, Extract<TranscriptItem, { type: "agent" }>>();
  for (const event of events) { if (event.type === "message.created" && event.message.threadId === threadId) { if (event.message.sender.type === "human") items.push({ id: event.message.id, type: "human", content: event.message.content, createdAt: event.message.createdAt }); else if (event.message.kind === "collaboration") items.push({ id: event.message.id, type: "collaboration", agentId: event.message.sender.id, content: event.message.content, mentions: event.message.mentions, createdAt: event.message.createdAt }); } else if (event.type === "run.queued" && event.run.threadId === threadId) { const item: Extract<TranscriptItem, { type: "agent" }> = { id: event.run.id, type: "agent", agentId: event.run.agentId, content: "", createdAt: event.recordedAt, status: "queued" }; items.push(item); runs.set(event.run.id, item); } else if (event.type === "run.started" && event.threadId === threadId) { const run = runs.get(event.runId); if (run) run.status = "running"; } else if (event.type === "run.delta" && event.threadId === threadId) { const run = runs.get(event.runId); if (run) { run.content += event.text; run.status = "running"; } } else if (event.type === "run.completed" && event.threadId === threadId) { const run = runs.get(event.runId); if (run) { run.content = event.output; run.status = "completed"; } } else if (event.type === "run.failed" && event.threadId === threadId) { const run = runs.get(event.runId); if (run) { run.content = event.error; run.status = "failed"; } } else if (event.type === "run.cancelled" && event.threadId === threadId) { const run = runs.get(event.runId); if (run) { run.content = event.reason; run.status = "cancelled"; } } else if (event.type === "run.interrupted" && event.threadId === threadId) { const run = runs.get(event.runId); if (run) { run.content = event.reason; run.status = "interrupted"; } } }
  return items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function findActiveChain(events: StoredPlatformEvent[], threadId?: string): string | undefined { if (!threadId) return undefined; const runs = new Map<string, { chainId: string; active: boolean; order: number }>(); let order = 0; for (const event of events) { if (event.type === "run.queued" && event.run.threadId === threadId) runs.set(event.run.id, { chainId: event.run.causal.chainId, active: true, order: order++ }); else if (isTerminalEvent(event)) { const run = runs.get(event.runId); if (run) run.active = false; } } return [...runs.values()].filter((run) => run.active).sort((a, b) => b.order - a.order)[0]?.chainId; }
function findFallbackAgent(agents: AgentSummary[], defaultAgentId: string | undefined, events: StoredPlatformEvent[], threadId?: string): AgentSummary | undefined { const online = (id: string) => agents.find((agent) => agent.id === id && agent.enabled && agent.availability.available); if (threadId) for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]; if (event?.type === "run.completed" && event.threadId === threadId) { const agent = online(event.agentId); if (agent) return agent; } } return (defaultAgentId ? online(defaultAgentId) : undefined) ?? agents.find((agent) => agent.enabled && agent.availability.available); }
function selectThreadEvents(events: StoredPlatformEvent[], threadId?: string): StoredPlatformEvent[] { if (!threadId) return []; const runIds = new Set(events.filter((event) => event.type === "run.queued" && event.run.threadId === threadId).map((event) => event.type === "run.queued" ? event.run.id : "")); return events.filter((event) => eventThreadId(event) === threadId || ("runId" in event && typeof event.runId === "string" && runIds.has(event.runId))); }
function eventThreadId(event: StoredPlatformEvent): string | undefined { if (event.type === "thread.created") return event.thread.id; if (event.type === "message.created") return event.message.threadId; if (event.type === "run.queued") return event.run.threadId; if ("threadId" in event && typeof event.threadId === "string") return event.threadId; return undefined; }
function isTerminalEvent(event: StoredPlatformEvent): event is Extract<StoredPlatformEvent, { type: "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted" }> { return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted"; }
function buildWorkspaceOptions(threads: ThreadSummary[], defaultWorkspace?: WorkspaceSummary): WorkspaceSummary[] { const workspaces = new Map<string, WorkspaceSummary>(); if (defaultWorkspace) workspaces.set(defaultWorkspace.path, defaultWorkspace); for (const thread of threads) { const path = thread.workingDirectory ?? defaultWorkspace?.path; if (path && !workspaces.has(path)) workspaces.set(path, { name: workspaceName(path), path }); } return [...workspaces.values()].slice(0, 6); }
function mergeHistoricalAgents(current: AgentSummary[], previous: AgentSummary[]): AgentSummary[] { const ids = new Set(current.map((agent) => agent.id)); return [...current, ...previous.filter((agent) => !ids.has(agent.id) && !agent.enabled)]; }
function workspaceName(path: string): string { const parts = path.split(/[\\/]/).filter(Boolean); return (parts.at(-1) ?? path) || "工作目录"; }
function cleanTitle(title: string): string { return title.replace(/^(?:@[a-z][a-z0-9-]*\s*){1,2}/i, "") || title; }
function agentName(agents: AgentSummary[], id: string): string { return agents.find((agent) => agent.id === id)?.displayName ?? id; }
function runtimeLabel(agent?: AgentSummary): string { if (!agent || agent.availability.label === "Historical Agent") return "历史 Agent"; return agent.runtime.kind === "pi" ? `Pi · ${agent.runtime.model}` : `Codex${agent.runtime.model ? ` · ${agent.runtime.model}` : ""}`; }
function statusLabel(status: ViewRunStatus, access?: AccessMode): string { if (status === "queued") return access === "read-only" ? "并行队列" : "等待会话/写锁"; return { running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "已中断" }[status]; }
function connectionLabel(configured: boolean, connection: string): string { if (!configured) return "等待运行时配置"; if (connection === "connected") return "团队服务已连接"; return connection === "reconnecting" ? "正在重新连接" : "正在连接"; }
function shortId(id: string): string { return id.split("_")[1]?.slice(0, 8) ?? id.slice(0, 8); }
function formatClock(value: string): string { return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function formatRelativeTime(value: string): string { const difference = Date.now() - new Date(value).getTime(); const minutes = Math.max(0, Math.floor(difference / 60_000)); if (minutes < 1) return "刚刚"; if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`; const days = Math.floor(hours / 24); return days < 7 ? `${days} 天前` : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
