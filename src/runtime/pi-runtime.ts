import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  defineTool,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiRuntimeSpec, RuntimeAvailability } from "../core/types.js";
import { PiSharedRuntime, RequestResourceLoader } from "./pi-shared.js";
import type {
  AgentRuntime,
  PostAgentMessageInput,
  RuntimeRequest,
  RuntimeResult,
} from "./runtime.js";
import type { RuntimeSessionStore } from "./session-store.js";

export interface PiRuntimeAdapterOptions {
  id: string;
  cwd: string;
  spec: PiRuntimeSpec;
  fingerprint: string;
  sessionRoot: string;
  sessionStore: RuntimeSessionStore;
  shared: PiSharedRuntime;
  availability?: RuntimeAvailability;
}

export class PiRuntimeAdapter implements AgentRuntime {
  public readonly id: string;
  public readonly availability: RuntimeAvailability;
  private readonly activeSessions = new Map<string, AgentSession>();

  public constructor(private readonly options: PiRuntimeAdapterOptions) {
    this.id = options.id;
    this.availability = options.availability ?? resolvePiAvailability(options.spec);
  }

  public async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const cwd = request.workingDirectory ?? this.options.cwd;
    const postMessageTool = defineTool({
      name: "post_message",
      label: "Post a visible collaboration message",
      description:
        "Post a visible message to the shared thread. Put a teammate's @handle at the start of a line to wake them. Ordinary assistant output never routes.",
      parameters: Type.Object({
        content: Type.String({ description: "Visible shared-thread message" }),
        intent: Type.Optional(Type.String({ description: "Short collaboration intent" })),
        idempotencyKey: Type.String({
          description: "A unique stable key for this logical post within the current run",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const message: PostAgentMessageInput = {
          content: params.content,
          idempotencyKey: params.idempotencyKey,
          ...(params.intent ? { intent: params.intent } : {}),
        };
        const result = await request.postMessage(message);
        return {
          content: [
            {
              type: "text",
              text: result.accepted
                ? result.targets.length > 0
                  ? `Visible message posted and routed to ${result.targets.map((id) => `@${id}`).join(", ")}.`
                  : "Visible message posted without waking another Agent."
                : `Message routing rejected: ${result.reason ?? "unknown reason"}`,
            },
          ],
          details: result,
        };
      },
    });

    const { loader: sharedLoader, settingsManager } =
      await this.options.shared.resourcesFor(cwd);
    const loader = new RequestResourceLoader(sharedLoader, buildSystemPrompt(request));

    const binding = await this.options.sessionStore.get(request.threadId, request.agent.id);
    const canResume = Boolean(
      binding &&
        binding.runtimeKind === "pi" &&
        binding.fingerprint === this.options.fingerprint &&
        existsSync(binding.locator),
    );
    const sessionDirectory = resolve(
      this.options.sessionRoot,
      "pi",
      safeSegment(request.agent.id),
      safeSegment(request.threadId),
      this.options.fingerprint,
    );
    let manager: SessionManager;
    if (canResume && binding) {
      try {
        manager = SessionManager.open(binding.locator);
      } catch {
        manager = SessionManager.create(cwd, sessionDirectory);
      }
    } else {
      manager = SessionManager.create(cwd, sessionDirectory);
    }

    const modelRuntime = await this.options.shared.modelRuntime();
    const selectedModel = this.resolveModel(modelRuntime);
    const { session } = await createAgentSession({
      cwd,
      resourceLoader: loader,
      sessionManager: manager,
      settingsManager,
      modelRuntime,
      customTools: [postMessageTool],
      excludeTools: piExcludedTools(request.agent.accessMode),
      ...(selectedModel.model ? { model: selectedModel.model } : {}),
      ...(selectedModel.thinkingLevel
        ? { thinkingLevel: selectedModel.thinkingLevel }
        : {}),
    });

    // Upstream's print, rpc, and interactive modes all bind before prompting.
    // Without this, session_start never fires and extension-contributed skills
    // and prompts are never merged in.
    await session.bindExtensions({
      mode: "print",
      onError: (error) => {
        void request.emit({
          type: "diagnostic",
          source: "extension",
          message: `${error.extensionPath}: ${error.error}`,
        });
      },
    });
    // Activate every tool the registry ended up with, so extension-registered
    // tools are usable. Access mode is enforced by excludeTools above, which
    // keeps the excluded built-ins out of the registry entirely.
    session.setActiveToolsByName(session.getAllTools().map((tool) => tool.name));

    const sessionFile = session.sessionFile;
    if (sessionFile) {
      await this.options.sessionStore.set({
        threadId: request.threadId,
        agentId: request.agent.id,
        runtimeKind: "pi",
        fingerprint: this.options.fingerprint,
        locator: sessionFile,
        updatedAt: new Date().toISOString(),
      });
    }
    await request.emit({ type: "session", runtimeKind: "pi", resumed: canResume });

    this.activeSessions.set(request.runId, session);
    // Text is collected from completed assistant messages rather than from the
    // delta stream: auto-retry drops a failed message and re-streams it, so
    // accumulating deltas would emit the failed partial and the retried text.
    const completedText: string[] = [];
    let emissionQueue = Promise.resolve();
    const forward = (event: Parameters<RuntimeRequest["emit"]>[0]): void => {
      emissionQueue = emissionQueue.then(() => request.emit(event));
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const delta = event.assistantMessageEvent;
        if (delta.type === "text_delta") {
          forward({ type: "text_delta", text: delta.delta });
        } else if (delta.type === "thinking_delta") {
          forward({ type: "thinking_delta", text: delta.delta });
        }
      } else if (event.type === "message_end") {
        if (event.message.role !== "assistant") return;
        const { stopReason } = event.message;
        if (stopReason === "error" || stopReason === "aborted") return;
        const text = event.message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (text.trim()) completedText.push(text);
      } else if (event.type === "tool_execution_start") {
        const args = summarizeToolPayload(event.args);
        forward({
          type: "tool_start",
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(args ? { args } : {}),
        });
      } else if (event.type === "tool_execution_end") {
        const resultSummary = summarizeToolPayload(event.result);
        forward({
          type: "tool_end",
          toolName: event.toolName,
          isError: event.isError,
          toolCallId: event.toolCallId,
          ...(resultSummary ? { resultSummary } : {}),
        });
      } else if (event.type === "auto_retry_start") {
        // The failed attempt's text has already been streamed to the client.
        forward({ type: "output_reset", reason: "retry" });
        forward({
          type: "lifecycle",
          phase: "retry_start",
          detail: `第 ${event.attempt}/${event.maxAttempts} 次重试：${event.errorMessage}`,
        });
      } else if (event.type === "auto_retry_end") {
        forward({
          type: "lifecycle",
          phase: "retry_end",
          detail: event.success ? "重试成功" : (event.finalError ?? "重试失败"),
        });
      } else if (event.type === "compaction_start") {
        forward({ type: "lifecycle", phase: "compaction_start", detail: event.reason });
      } else if (event.type === "compaction_end") {
        forward({
          type: "lifecycle",
          phase: "compaction_end",
          detail: event.aborted ? "已取消" : (event.errorMessage ?? event.reason),
        });
      }
    });

    const onAbort = () => void session.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });

    try {
      if (request.signal.aborted) {
        await session.abort();
        throw abortError(request.signal.reason);
      }
      const prompt = session.prompt(buildUserPrompt(request), {
        ...(request.images && request.images.length > 0
          ? {
              images: request.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mediaType,
              })),
            }
          : {}),
      });
      await request.emit({ type: "prompt_accepted" });
      await prompt;
      await emissionQueue;
      if (session.agent.state.errorMessage) {
        throw new Error(`Pi model error: ${session.agent.state.errorMessage}`);
      }
      await this.emitUsage(request, session);
      return { output: completedText.join("\n\n").trim() || "(Pi returned no text output)" };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      unsubscribe();
      this.activeSessions.delete(request.runId);
      session.dispose();
    }
  }

  public async cancel(runId: string): Promise<void> {
    await this.activeSessions.get(runId)?.abort();
  }

  public async steer(runId: string, text: string): Promise<boolean> {
    const session = this.activeSessions.get(runId);
    if (!session || !session.isStreaming) return false;
    await session.steer(text);
    return true;
  }

  private async emitUsage(request: RuntimeRequest, session: AgentSession): Promise<void> {
    try {
      const stats = session.getSessionStats();
      const contextUsage = session.getContextUsage();
      await request.emit({
        type: "usage",
        inputTokens: stats.tokens.input,
        outputTokens: stats.tokens.output,
        cacheReadTokens: stats.tokens.cacheRead,
        cacheWriteTokens: stats.tokens.cacheWrite,
        totalTokens: stats.tokens.total,
        costUsd: stats.cost,
        ...(contextUsage?.tokens !== null && contextUsage !== undefined
          ? {
              contextTokens: contextUsage.tokens,
              contextWindow: contextUsage.contextWindow,
            }
          : {}),
      });
    } catch {
      // Usage reporting is advisory; never fail a completed run over it.
    }
  }

  private resolveModel(modelRuntime: ModelRuntime): {
    model: ReturnType<ModelRuntime["getModel"]>;
    thinkingLevel: PiRuntimeSpec["thinkingLevel"];
  } {
    const resolved = resolveCliModel({
      cliProvider: this.options.spec.provider,
      cliModel: this.options.spec.model,
      cliThinking: this.options.spec.thinkingLevel,
      modelRuntime,
    });
    if (resolved.error || !resolved.model) {
      throw new Error(
        resolved.error ?? `Unable to resolve Pi model: ${this.options.spec.model}`,
      );
    }
    return {
      model: resolved.model,
      thinkingLevel: resolved.thinkingLevel ?? this.options.spec.thinkingLevel,
    };
  }
}

/** Environment variables pi reads for providers the workbench offers presets for. */
const PROVIDER_ENVIRONMENT_KEYS: Record<string, string[]> = {
  "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
  zai: ["ZAI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

export interface PiAvailabilityProbe {
  /** Mirrors `ModelRuntime.hasConfiguredAuth`. */
  hasConfiguredAuth(providerId: string): boolean;
}

/**
 * Pi resolves credentials from `~/.pi/agent/auth.json` first and environment
 * variables second, and `auth.json` also carries OAuth subscription logins.
 * The probe is therefore authoritative when available; the environment table is
 * only a fallback for the presets the first-run page writes.
 */
export function resolvePiAvailability(
  spec: PiRuntimeSpec,
  environment: NodeJS.ProcessEnv = process.env,
  probe?: PiAvailabilityProbe,
): RuntimeAvailability {
  const label = `${spec.provider}/${spec.model}`;
  const expected = PROVIDER_ENVIRONMENT_KEYS[spec.provider];
  const fromEnvironment = Boolean(expected?.some((key) => Boolean(environment[key])));
  if (probe) {
    const configured = fromEnvironment || probe.hasConfiguredAuth(spec.provider);
    return {
      available: configured,
      label,
      ...(configured
        ? {}
        : {
            detail: `未找到 ${spec.provider} 的凭据：请设置 ${expected?.join(" 或 ") ?? "对应环境变量"}，或用 pi 登录写入 auth.json`,
          }),
    };
  }
  // No probe: only the known presets can be judged. Unknown providers are left
  // routable so a valid auth.json setup is never blocked by a stale table.
  const configured = !expected || fromEnvironment;
  return {
    available: configured,
    label,
    ...(!configured
      ? { detail: `Missing credential: ${expected?.join(" or ") ?? "provider credential"}` }
      : {}),
  };
}

/**
 * Access modes are enforced as a denylist rather than an allowlist so that
 * extension-registered tools stay reachable — an allowlist filters those out of
 * the registry with no way for the user to opt back in.
 */
export function piExcludedTools(accessMode: RuntimeRequest["agent"]["accessMode"]): string[] {
  if (accessMode === "read-only") return ["bash", "edit", "write"];
  if (accessMode === "workspace-write") return ["bash"];
  return [];
}

const TOOL_PAYLOAD_LIMIT = 2_000;

/** Keeps tool arguments and results renderable without bloating the event log. */
export function summarizeToolPayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  return text.length > TOOL_PAYLOAD_LIMIT
    ? `${text.slice(0, TOOL_PAYLOAD_LIMIT)}…（已截断）`
    : text;
}

export function buildSystemPrompt(request: RuntimeRequest): string {
  const roster = request.roster
    .map(
      (agent) =>
        `- @${agent.id} (${agent.displayName}): ${agent.description} Capabilities: ${agent.capabilities.join(", ") || "general"}.`,
    )
    .join("\n");
  return [
    request.agent.systemPrompt,
    "",
    "Peer collaboration protocol:",
    "- You are a peer. There is no boss Agent and no mandatory handoff pipeline.",
    "- Accept work you can own; challenge weak assumptions with evidence.",
    "- If a teammate should act, call post_message and put their @handle at the start of a line.",
    "- A post_message without a recognized teammate mention is visible to the human but wakes nobody.",
    "- Ordinary assistant output, including @handles, never routes to another Agent.",
    "- Do not retry a rejected post_message with a new idempotency key.",
    "- Ask the human directly when a value judgment or irreversible decision is required.",
    "",
    "Available peers:",
    roster || "(none)",
  ].join("\n");
}

export function buildUserPrompt(request: RuntimeRequest): string {
  const history = request.context.recentMessages
    .map((message) => {
      const sender =
        message.sender.type === "human"
          ? `human:${message.sender.id}`
          : `agent:${message.sender.id}`;
      const mentions = message.mentions.length > 0
        ? ` mentions=${message.mentions.map((id) => `@${id}`).join(",")}`
        : "";
      return `[${sender}; kind=${message.kind}${mentions}] ${message.content}`;
    })
    .join("\n\n");
  return [
    "<new-shared-thread-context>",
    history || "(none)",
    request.context.truncated ? "[Earlier unseen messages were truncated by the context budget.]" : "",
    "</new-shared-thread-context>",
    "",
    "<incoming-message>",
    `sender_type: ${request.incoming.sender.type}`,
    `sender_id: ${request.incoming.sender.id}`,
    `intent: ${request.incoming.intent ?? "unspecified"}`,
    request.incoming.content,
    "</incoming-message>",
    "",
    "Respond to the incoming message now.",
  ].filter(Boolean).join("\n");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function abortError(reason: unknown): Error {
  const error = new Error(String(reason ?? "Aborted"));
  error.name = "AbortError";
  return error;
}
