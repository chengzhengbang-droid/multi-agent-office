import { constants, createReadStream, existsSync } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { loadEnvFile } from "node:process";
import {
  CatalogConflictError,
  FileAgentCatalogStore,
  validateCatalog,
} from "./config/agent-catalog.js";
import {
  applyFirstRunEnvironment,
  applyProviderCredential,
  isFirstRunSetupRequired,
  parseFirstRunInput,
  parseProviderCredentialInput,
  saveFirstRunConfig,
  saveProviderCredential,
} from "./config/first-run.js";
import {
  customProviderEnvKey,
  findCustomProvider,
  type CustomProviderCatalogV1,
} from "./config/custom-providers.js";
import { FileCustomProviderStore } from "./config/custom-provider-store.js";
import { findApiProvider } from "./config/provider-presets.js";
import {
  parseAttachmentInputs,
  saveAttachments,
} from "./core/attachments.js";
import { RecentContextCompiler } from "./core/context-compiler.js";
import { JsonlEventStore } from "./core/event-store.js";
import { MultiAgentPlatform, type ReviewMode } from "./core/platform.js";
import type {
  AgentCatalogV1,
  AgentDefinition,
  AgentSummary,
  StoredPlatformEvent,
  ThinkingLevel,
} from "./core/types.js";
import { PiSharedRuntime } from "./runtime/pi-shared.js";
import { createAgentRuntimes, type RuntimeFactoryOptions } from "./runtime/runtime-factory.js";
import { FileRuntimeSessionStore } from "./runtime/session-store.js";

const appRoot = resolve(process.env.MAO_APP_ROOT ?? process.cwd());
const dataRoot = resolve(process.env.MAO_DATA_DIR ?? resolve(appRoot, ".data"));
const configPath = resolve(process.env.MAO_CONFIG_FILE ?? resolve(appRoot, ".env"));
const defaultWorkspaceRoot = resolve(
  process.env.MAO_DEFAULT_WORKSPACE ?? process.cwd(),
);
const webRoot = resolve(process.env.MAO_WEB_ROOT ?? resolve(appRoot, "dist-web"));
if (existsSync(configPath)) loadEnvFile(configPath);
let setupRequired = isFirstRunSetupRequired();

const port = Number(process.env.PORT ?? 4173);
const isDev = process.argv.includes("--dev");
const catalogStore = new FileAgentCatalogStore(
  resolve(dataRoot, "agents.json"),
  {
    piProvider: process.env.MAO_PI_PROVIDER ?? "zai-coding-cn",
    piModel: process.env.MAO_PI_MODEL ?? "glm-5.2",
    piThinkingLevel: parseThinkingLevel(process.env.MAO_PI_THINKING ?? "medium"),
    codexCommand: process.env.MAO_CODEX_COMMAND ?? "codex",
    defaultAgentId: parseDefaultAgentId(process.env.MAO_DEFAULT_AGENT ?? "codex"),
  },
);
let catalog = await catalogStore.load();
const sessionStore = new FileRuntimeSessionStore(
  resolve(dataRoot, "runtime-sessions", "index.json"),
);
const customProviderStore = new FileCustomProviderStore(
  resolve(dataRoot, "custom-providers.json"),
);
const piShared = new PiSharedRuntime({ customProviders: customProviderStore });
const runtimeFactoryOptions: RuntimeFactoryOptions = {
  projectRoot: defaultWorkspaceRoot,
  piShared,
  sessionRoot: resolve(dataRoot, "runtime-sessions"),
  sessionStore,
};
let runtimes = await createAgentRuntimes(catalog.agents, runtimeFactoryOptions);
const platform = new MultiAgentPlatform({
  agents: catalog.agents,
  defaultAgentId: catalog.defaultAgentId,
  runtimes,
  eventStore: new JsonlEventStore(resolve(dataRoot, "events.jsonl")),
  contextCompiler: new RecentContextCompiler(),
  maxA2ADepth: 4,
  maxAgentRunsPerChain: 8,
  maxMentionTargets: 2,
  maxPingPongHops: 4,
  maxParallelReadRuns: Number(process.env.MAO_MAX_PARALLEL_READ_RUNS ?? 4),
  reviewMode: parseReviewMode(process.env.MAO_REVIEW_GATE),
  maxReviewRounds: Number(process.env.MAO_MAX_REVIEW_ROUNDS ?? 4),
  maxStalledRounds: Number(process.env.MAO_REVIEW_STALL_ROUNDS ?? 2),
  approvalStaleAfterMs: Number(process.env.MAO_APPROVAL_STALE_HOURS ?? 24) * 60 * 60 * 1000,
});

const vite = isDev
  ? await import("vite").then(({ createServer: createViteServer }) =>
      createViteServer({ server: { middlewareMode: true }, appType: "spa" }),
    )
  : undefined;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/setup" && request.method === "POST") {
      if (!isTrustedLocalOrigin(request)) {
        sendJson(response, 403, { error: "拒绝来自其他网页的配置请求" });
        return;
      }
      if (!setupRequired) {
        sendJson(response, 409, { error: "首次启动配置已经完成" });
        return;
      }
      try {
        const input = parseFirstRunInput(await readJson(request));
        const provider = findApiProvider(input.provider);
        if (!provider) throw new Error("不支持的 API 提供商");

        // Keep MAO_SETUP_COMPLETED=0 until both the secret and roster are durable.
        await saveFirstRunConfig(configPath, input, false);
        applyFirstRunEnvironment(input);
        process.env.MAO_SETUP_COMPLETED = "0";

        const requested = configureCatalogForSetup(catalog, {
          provider: provider.id,
          model: provider.model,
          useCodex: input.useCodex,
        });
        platform.beginRosterUpdate(requested.agents);
        try {
          const nextRuntimes = await createAgentRuntimes(requested.agents, runtimeFactoryOptions);
          const saved = await catalogStore.replace(requested, requested.revision);
          await platform.replaceRoster(saved.agents, nextRuntimes, saved.defaultAgentId);
          catalog = saved;
          runtimes = nextRuntimes;
        } catch (error) {
          platform.abortRosterUpdate();
          throw error;
        }

        await saveFirstRunConfig(configPath, input, true);
        process.env.MAO_SETUP_COMPLETED = "1";
        setupRequired = false;
        sendJson(response, 200, await buildBootstrapData());
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/bootstrap" && request.method === "GET") {
      sendJson(response, 200, await buildBootstrapData());
      return;
    }

    if (url.pathname === "/api/agents" && request.method === "GET") {
      sendJson(response, 200, {
        catalog,
        agents: buildAgentViews(catalog, runtimes),
      });
      return;
    }

    if (url.pathname === "/api/agents" && request.method === "PUT") {
      try {
        const body = await readJson(request);
        assertCatalogContainsNoSecrets(body);
        const requested = validateCatalog(body);
        assertHandlesWereNotRemoved(catalog, requested);
        platform.beginRosterUpdate(requested.agents);
        try {
          const nextRuntimes = await createAgentRuntimes(requested.agents, runtimeFactoryOptions);
          const saved = await catalogStore.replace(requested, requested.revision);
          await platform.replaceRoster(saved.agents, nextRuntimes, saved.defaultAgentId);
          catalog = saved;
          runtimes = nextRuntimes;
        } catch (error) {
          platform.abortRosterUpdate();
          throw error;
        }
        sendJson(response, 200, {
          catalog,
          agents: buildAgentViews(catalog, runtimes),
        });
      } catch (error) {
        const status =
          error instanceof CatalogConflictError || /active or queued run/i.test(errorMessage(error))
            ? 409
            : 400;
        sendJson(response, status, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/events" && request.method === "GET") {
      const lastEventId = request.headers["last-event-id"];
      await streamEvents(
        request,
        response,
        (typeof lastEventId === "string" ? lastEventId : undefined) ??
          url.searchParams.get("after") ??
          undefined,
      );
      return;
    }

    if (url.pathname === "/api/workspaces/validate" && request.method === "POST") {
      const body = await readJson(request);
      const requestedPath = typeof body.path === "string" ? body.path.trim() : "";
      if (!requestedPath) {
        sendJson(response, 400, { error: "请输入工作目录" });
        return;
      }
      try {
        sendJson(response, 200, await validateWorkspace(requestedPath));
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/messages" && request.method === "POST") {
      // Images arrive base64-encoded, so this endpoint needs more headroom
      // than the default JSON budget.
      const body = await readJson(request, 24_000_000);
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
      const workspacePath =
        typeof body.workspacePath === "string" ? body.workspacePath.trim() : "";
      if (!content || content.length > 20_000) {
        sendJson(response, 400, { error: "任务内容不能为空且不能超过 20,000 字符" });
        return;
      }
      if (body.routingMode !== undefined && body.routingMode !== "serial" && body.routingMode !== "parallel") {
        sendJson(response, 400, { error: "routingMode 必须是 serial 或 parallel" });
        return;
      }
      if (threadId && !(await threadExists(threadId))) {
        sendJson(response, 404, { error: "任务不存在或已无法恢复" });
        return;
      }

      let workspace: Awaited<ReturnType<typeof validateWorkspace>> | undefined;
      if (!threadId) {
        try {
          workspace = await validateWorkspace(workspacePath || defaultWorkspaceRoot);
        } catch (error) {
          sendJson(response, 400, { error: errorMessage(error) });
          return;
        }
      }
      try {
        const attachments = await saveAttachments(
          dataRoot,
          parseAttachmentInputs(body.attachments),
        );
        const started = await platform.startUserMessage({
          content,
          ...(threadId ? { threadId } : {}),
          ...(workspace ? { workingDirectory: workspace.path } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(body.steer === true ? { steer: true } : {}),
          ...(body.planMode === true ? { planMode: true } : {}),
          ...(body.routingMode === "serial" || body.routingMode === "parallel"
            ? { routingMode: body.routingMode }
            : {}),
        });
        void started.completion.catch((error: unknown) => {
          console.error("Background Agent chain failed", error);
        });
        sendJson(response, 202, {
          threadId: started.threadId,
          chainId: started.chainId,
          steered: started.steered,
          ...(workspace ? { workspace } : {}),
        });
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
      }
      return;
    }

    if (url.pathname === "/api/models" && request.method === "GET") {
      sendJson(response, 200, await buildModelCatalog());
      return;
    }

    // Adding a Pi Agent on a second provider needs that provider's key, and the
    // first-run page is gone once setup completed. This adds a credential
    // without repointing any Agent that already works.
    if (url.pathname === "/api/providers/credential" && request.method === "POST") {
      if (!isTrustedLocalOrigin(request)) {
        sendJson(response, 403, { error: "拒绝来自其他网页的配置请求" });
        return;
      }
      if (setupRequired) {
        sendJson(response, 409, { error: "请先完成首次启动配置" });
        return;
      }
      try {
        const input = parseProviderCredentialInput(
          await readJson(request),
          await providerCredentialResolver(),
        );
        // Reloading credentials rebuilds every runtime adapter, which disposes
        // the outgoing ones, so a live run would be aborted mid-turn.
        const busy = catalog.agents.find((agent) => platform.hasLiveAgentRun(agent.id));
        if (busy) {
          sendJson(response, 409, {
            error: `@${busy.id} 正在运行或排队，请等待本轮结束后再保存凭据`,
          });
          return;
        }
        await saveProviderCredential(configPath, input);
        applyProviderCredential(input);
        await reloadProviderCredentials();
        sendJson(response, 200, {
          agents: buildAgentViews(catalog, runtimes),
          models: await buildModelCatalog(),
        });
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
      }
      return;
    }

    // Third-party and self-hosted deployments pi does not ship with. Saving the
    // list rebuilds the model runtime so the new provider is selectable, and its
    // Agents become routable, without restarting the app.
    if (url.pathname === "/api/providers/custom" && request.method === "POST") {
      if (!isTrustedLocalOrigin(request)) {
        sendJson(response, 403, { error: "拒绝来自其他网页的配置请求" });
        return;
      }
      if (setupRequired) {
        sendJson(response, 409, { error: "请先完成首次启动配置" });
        return;
      }
      try {
        const busy = catalog.agents.find((agent) => platform.hasLiveAgentRun(agent.id));
        if (busy) {
          sendJson(response, 409, {
            error: `@${busy.id} 正在运行或排队，请等待本轮结束后再保存提供商`,
          });
          return;
        }
        const requested = await readJson(request);
        const orphaned = await orphanedProviderAgent(requested);
        if (orphaned) {
          sendJson(response, 409, {
            error: `@${orphaned.agentId} 正在使用提供商 ${orphaned.provider}，请先改用其他提供商再删除`,
          });
          return;
        }
        await customProviderStore.replace(requested);
        await reloadProviderCredentials();
        sendJson(response, 200, {
          agents: buildAgentViews(catalog, runtimes),
          models: await buildModelCatalog(),
        });
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
      }
      return;
    }

    const sessionMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/session$/);
    if (sessionMatch) {
      const agentId = decodeURIComponent(sessionMatch[1] ?? "");
      const runtime = runtimes.get(agentId);
      const requestedThreadId = url.searchParams.get("threadId") ?? "";
      if (!runtime) {
        sendJson(response, 404, { error: `未知 Agent：@${agentId}` });
        return;
      }
      if (!requestedThreadId) {
        sendJson(response, 400, { error: "缺少 threadId" });
        return;
      }
      try {
        if (request.method === "GET") {
          if (!runtime.sessionStats) {
            sendJson(response, 501, { error: "该运行时不提供 session 统计" });
            return;
          }
          const stats = await runtime.sessionStats(requestedThreadId);
          sendJson(response, 200, { stats: stats ?? null });
          return;
        }
        if (request.method === "POST") {
          const action = url.searchParams.get("action") ?? "compact";
          if (action === "compact") {
            if (!runtime.compactSession) {
              sendJson(response, 501, { error: "该运行时不支持手动压缩" });
              return;
            }
            sendJson(response, 200, await runtime.compactSession(requestedThreadId));
            return;
          }
          if (action === "export") {
            const format = url.searchParams.get("format") === "jsonl" ? "jsonl" : "html";
            if (!runtime.exportSession) {
              sendJson(response, 501, { error: "该运行时不支持导出" });
              return;
            }
            sendJson(response, 200, {
              path: await runtime.exportSession(requestedThreadId, format),
            });
            return;
          }
          sendJson(response, 400, { error: `未知操作：${action}` });
          return;
        }
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
        return;
      }
    }

    // Every gate waiting on a human, across every thread. Clowder's Approval
    // Hub exists because an approval raised in one thread is invisible from
    // another; this is the same index, read straight off the event log.
    if (url.pathname === "/api/approvals" && request.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      sendJson(response, 200, {
        approvals: await platform.getPendingApprovals(threadId ?? undefined),
      });
      return;
    }

    if (url.pathname === "/api/plans" && request.method === "GET") {
      const threadId = url.searchParams.get("threadId");
      sendJson(response, 200, {
        plans: await platform.getPendingPlanApprovals(threadId ?? undefined),
      });
      return;
    }

    const planMatch = url.pathname.match(/^\/api\/plans\/([^/]+)\/decision$/);
    if (planMatch && request.method === "POST") {
      const taskRunId = decodeURIComponent(planMatch[1] ?? "");
      const body = await readJson(request);
      const decision = body.decision;
      if (decision !== "approved" && decision !== "rejected") {
        sendJson(response, 400, { error: "decision 必须是 approved 或 rejected" });
        return;
      }
      const note = typeof body.note === "string" ? body.note.trim() : "";
      try {
        sendJson(
          response,
          202,
          await platform.decidePlan({
            taskRunId,
            decision,
            ...(note ? { note } : {}),
          }),
        );
      } catch (error) {
        sendJson(response, 400, { error: errorMessage(error) });
      }
      return;
    }

    const cancelMatch = url.pathname.match(/^\/api\/chains\/([^/]+)\/cancel$/);
    if (cancelMatch && request.method === "POST") {
      const chainId = decodeURIComponent(cancelMatch[1] ?? "");
      if (!chainId.startsWith("chain_") && !chainId.startsWith("run_")) {
        sendJson(response, 400, { error: "无效的协作链标识" });
        return;
      }
      await platform.cancelGroup(chainId, "Cancelled from the web interface");
      sendJson(response, 202, { chainId, cancelled: true });
      return;
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      sendJson(response, 200, {
        ok: true,
        agents: buildAgentViews(catalog, runtimes),
      });
      return;
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/")) {
      sendJson(response, 404, { error: "API endpoint not found" });
      return;
    }
    if (vite) {
      vite.middlewares(request, response, (error: unknown) => {
        if (error) sendJson(response, 500, { error: "Preview server error" });
      });
      return;
    }
    await serveProductionAsset(url.pathname, response);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendJson(response, 500, { error: "Internal server error" });
    else response.end();
  }
});

await new Promise<void>((resolveListen) => {
  server.listen(port, "127.0.0.1", resolveListen);
});
await platform.initialize();
console.log(`Multi-Agent Office: http://127.0.0.1:${port}`);

const shutdown = (): void => {
  server.close(() => process.exit(0));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

/**
 * Pi caches the credential store inside the shared `ModelRuntime`, and each
 * adapter resolves availability once at construction, so a key added while the
 * app runs stays invisible until both are rebuilt. The roster itself is
 * unchanged, which `assertRosterChangeAllowed` accepts.
 */
async function reloadProviderCredentials(): Promise<void> {
  piShared.dispose();
  platform.beginRosterUpdate(catalog.agents);
  try {
    const nextRuntimes = await createAgentRuntimes(catalog.agents, runtimeFactoryOptions);
    await platform.replaceRoster(catalog.agents, nextRuntimes, catalog.defaultAgentId);
    runtimes = nextRuntimes;
  } catch (error) {
    platform.abortRosterUpdate();
    throw error;
  }
}

function buildAgentViews(
  source: AgentCatalogV1,
  runtimeMap: typeof runtimes,
  events: StoredPlatformEvent[] = [],
): AgentSummary[] {
  const views: AgentSummary[] = source.agents.map((agent) => ({
    ...structuredClone(agent),
    isDefault: agent.id === source.defaultAgentId,
    availability: runtimeMap.get(agent.id)?.availability ?? {
      available: false,
      label: "Runtime unavailable",
      detail: "No runtime adapter was created",
    },
  }));
  const known = new Set(views.map((agent) => agent.id));
  for (const event of events) {
    const id = historicalAgentId(event);
    if (!id || known.has(id)) continue;
    known.add(id);
    views.push({
      id,
      displayName: id,
      description: "历史事件中的已停用 Agent",
      systemPrompt: "Historical Agent",
      capabilities: [],
      enabled: false,
      accessMode: "read-only",
      runtime: {
        kind: "pi",
        provider: "legacy",
        model: "historical",
        thinkingLevel: "off",
      },
      isDefault: false,
      availability: { available: false, label: "Historical Agent" },
    });
  }
  return views;
}

async function buildBootstrapData() {
  const events = await platform.getEvents();
  return {
    setup: { required: setupRequired },
    catalog,
    agents: buildAgentViews(catalog, runtimes, events),
    workspace: { name: basename(defaultWorkspaceRoot), path: defaultWorkspaceRoot },
    events,
    cursor: events.at(-1)?.eventId,
  };
}

/**
 * The Pi model catalog, so the roster editor can offer real provider and model
 * choices instead of free text. Credentials are never included — only whether
 * a provider has one configured.
 */
async function buildModelCatalog(): Promise<{
  providers: Array<{
    id: string;
    name: string;
    configured: boolean;
    subscription: boolean;
    custom: boolean;
    /** Set when this app can store the provider's key itself. */
    envKey?: string;
    models: Array<{ id: string; name: string }>;
  }>;
  custom: CustomProviderCatalogV1;
  warnings?: string[];
  error?: string;
}> {
  const custom = await customProviderStore
    .load()
    .catch(() => ({ version: 1, providers: [] }) as CustomProviderCatalogV1);
  try {
    const modelRuntime = await piShared.modelRuntime();
    const providers = modelRuntime.getProviders().map((provider) => {
      const preset = findApiProvider(provider.id);
      const declared = findCustomProvider(custom, provider.id);
      const status = modelRuntime.getProviderAuthStatus(provider.id);
      return {
        id: provider.id,
        name: declared?.label ?? provider.name ?? provider.id,
        configured: status.configured || modelRuntime.hasConfiguredAuth(provider.id),
        subscription: modelRuntime.isUsingSubscription(provider.id),
        custom: Boolean(declared),
        ...(preset
          ? { envKey: preset.envKey }
          : declared
            ? { envKey: customProviderEnvKey(declared.id) }
            : {}),
        models: modelRuntime
          .getModels(provider.id)
          .map((model) => ({ id: model.id, name: model.name ?? model.id })),
      };
    });
    const warnings = piShared.warnings();
    return { providers, custom, ...(warnings.length > 0 ? { warnings } : {}) };
  } catch (error) {
    return { providers: [], custom, error: errorMessage(error) };
  }
}

/**
 * Which providers this app can store a key for: the built-in presets plus every
 * third-party deployment the workspace has declared.
 */
async function providerCredentialResolver(): Promise<
  (providerId: string) => { id: string; envKey: string } | undefined
> {
  const custom = await customProviderStore.load();
  return (providerId: string) => {
    const preset = findApiProvider(providerId);
    if (preset) return { id: preset.id, envKey: preset.envKey };
    const declared = findCustomProvider(custom, providerId);
    if (declared) return { id: declared.id, envKey: customProviderEnvKey(declared.id) };
    return undefined;
  };
}

/**
 * An Agent left pointing at a deleted provider would go offline with a model
 * resolution error instead of an explanation, so the removal is refused while
 * the Agent still uses it.
 */
async function orphanedProviderAgent(
  requested: unknown,
): Promise<{ agentId: string; provider: string } | undefined> {
  const current = await customProviderStore.load();
  const declared = new Set(current.providers.map((provider) => provider.id));
  const kept = new Set(
    Array.isArray((requested as CustomProviderCatalogV1 | undefined)?.providers)
      ? (requested as CustomProviderCatalogV1).providers.map((provider) => provider?.id)
      : [],
  );
  for (const agent of catalog.agents) {
    if (agent.runtime.kind !== "pi") continue;
    const provider = agent.runtime.provider;
    if (!declared.has(provider) || kept.has(provider)) continue;
    return { agentId: agent.id, provider };
  }
  return undefined;
}

function configureCatalogForSetup(
  source: AgentCatalogV1,
  input: { provider: string; model: string; useCodex: boolean },
): AgentCatalogV1 {
  let foundPi = false;
  let foundCodex = false;
  const agents = source.agents.map((agent): AgentDefinition => {
    if (agent.id === "pi") {
      foundPi = true;
      return {
        ...agent,
        enabled: true,
        runtime: {
          kind: "pi",
          provider: input.provider,
          model: input.model,
          thinkingLevel: "medium",
        },
      };
    }
    if (agent.id === "codex") {
      foundCodex = true;
      return { ...agent, enabled: input.useCodex };
    }
    return agent;
  });
  if (!foundPi || !foundCodex) {
    throw new Error("默认 Agent 花名册不完整，无法完成首次配置");
  }
  return validateCatalog({ ...source, defaultAgentId: "pi", agents });
}

function historicalAgentId(event: StoredPlatformEvent): string | undefined {
  if (event.type === "run.queued") return event.run.agentId;
  if (event.type === "run.started" || event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.interrupted") return event.agentId;
  if (event.type === "message.created" && event.message.sender.type === "agent") return event.message.sender.id;
  return undefined;
}

function assertHandlesWereNotRemoved(current: AgentCatalogV1, next: AgentCatalogV1): void {
  const nextIds = new Set(next.agents.map((agent) => agent.id));
  const missing = current.agents.find((agent) => !nextIds.has(agent.id));
  if (missing) throw new Error(`Agent handle @${missing.id} is immutable; disable it instead of removing it`);
}

function assertCatalogContainsNoSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) assertCatalogContainsNoSecrets(item);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:api[_-]?key|token|secret|password|credential)$/i.test(key)) {
      throw new Error(`Agent catalog must not contain secrets (${key})`);
    }
    assertCatalogContainsNoSecrets(item);
  }
}

/**
 * "smart" is the default: an Agent's own judgment about whether it produced a
 * deliverable opens the gate, so conversation is not reviewed. "on"/"required"
 * keeps the older behaviour of gating every user task.
 */
function parseReviewMode(value: string | undefined): ReviewMode {
  if (value === "off") return "off";
  if (value === "on" || value === "required") return "required";
  return "smart";
}

function isTrustedLocalOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  after?: string,
): Promise<void> {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");
  let replaying = true;
  const buffered: Awaited<ReturnType<typeof platform.getEvents>> = [];
  const sent = new Set<string>();
  const send = (event: Awaited<ReturnType<typeof platform.getEvents>>[number]) => {
    if (sent.has(event.eventId) || response.writableEnded) return;
    sent.add(event.eventId);
    response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const unsubscribe = platform.subscribe((event) => {
    if (replaying) buffered.push(event);
    else send(event);
  });
  const events = await platform.getEvents();
  const afterIndex = after ? events.findIndex((event) => event.eventId === after) : -1;
  for (const event of events.slice(afterIndex + 1)) send(event);
  replaying = false;
  for (const event of buffered) send(event);
  const keepAlive = setInterval(() => {
    if (!response.writableEnded) response.write(": keep-alive\n\n");
  }, 20_000);
  request.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
}

async function readJson(
  request: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function threadExists(threadId: string): Promise<boolean> {
  const events = await platform.getEvents();
  return events.some(
    (event) => event.type === "thread.created" && event.thread.id === threadId,
  );
}

async function validateWorkspace(input: string): Promise<{ name: string; path: string }> {
  const expanded =
    input === "~"
      ? homedir()
      : input.startsWith(`~${sep}`)
        ? resolve(homedir(), input.slice(2))
        : input;
  const candidate = isAbsolute(expanded)
    ? expanded
    : resolve(defaultWorkspaceRoot, expanded);
  try {
    const canonical = await realpath(candidate);
    const details = await stat(canonical);
    if (!details.isDirectory()) throw new Error("所选路径不是目录");
    await access(canonical, constants.R_OK);
    return { name: basename(canonical), path: canonical };
  } catch (error) {
    if (error instanceof Error && error.message === "所选路径不是目录") throw error;
    throw new Error("目录不存在或当前用户无法读取");
  }
}

async function serveProductionAsset(pathname: string, response: ServerResponse): Promise<void> {
  const requested = resolve(webRoot, `.${pathname}`);
  const safePath = requested === webRoot || requested.startsWith(`${webRoot}${sep}`);
  const candidate = safePath && (await isFile(requested))
    ? requested
    : resolve(webRoot, "index.html");
  if (!(await isFile(candidate))) {
    sendJson(response, 404, { error: "Web build not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(candidate),
    "cache-control": candidate.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(candidate).pipe(response);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  const types: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  return types[extname(path)] ?? "application/octet-stream";
}

function parseThinkingLevel(value: string): ThinkingLevel {
  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!levels.includes(value as ThinkingLevel)) throw new Error(`Invalid MAO_PI_THINKING value: ${value}`);
  return value as ThinkingLevel;
}

function parseDefaultAgentId(value: string): "codex" | "pi" {
  if (value !== "codex" && value !== "pi") {
    throw new Error("MAO_DEFAULT_AGENT must be codex or pi");
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
