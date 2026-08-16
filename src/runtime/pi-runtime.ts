import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiRuntimeSpec, RuntimeAvailability } from "../core/types.js";
import type {
  AgentRuntime,
  PostAgentMessageInput,
  RuntimeRequest,
  RuntimeResult,
} from "./runtime.js";
import type { RuntimeSessionStore } from "./session-store.js";

interface AbortablePiSession {
  abort(): Promise<void>;
}

export interface PiRuntimeAdapterOptions {
  id: string;
  cwd: string;
  spec: PiRuntimeSpec;
  fingerprint: string;
  sessionRoot: string;
  sessionStore: RuntimeSessionStore;
  availability?: RuntimeAvailability;
}

export class PiRuntimeAdapter implements AgentRuntime {
  public readonly id: string;
  public readonly availability: RuntimeAvailability;
  private readonly activeSessions = new Map<string, AbortablePiSession>();

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

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      systemPromptOverride: () => buildSystemPrompt(request),
    });
    await loader.reload();

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

    const modelRuntime = await ModelRuntime.create();
    const selectedModel = this.resolveModel(modelRuntime);
    const { session } = await createAgentSession({
      cwd,
      resourceLoader: loader,
      sessionManager: manager,
      modelRuntime,
      customTools: [postMessageTool],
      tools: piToolsForAccess(request.agent.accessMode),
      ...(selectedModel.model ? { model: selectedModel.model } : {}),
      ...(selectedModel.thinkingLevel
        ? { thinkingLevel: selectedModel.thinkingLevel }
        : {}),
    });

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
    let output = "";
    let emissionQueue = Promise.resolve();
    const forward = (event: Parameters<RuntimeRequest["emit"]>[0]): void => {
      emissionQueue = emissionQueue.then(() => request.emit(event));
    };
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        const text = event.assistantMessageEvent.delta;
        output += text;
        forward({ type: "text_delta", text });
      } else if (event.type === "tool_execution_start") {
        forward({ type: "tool_start", toolName: event.toolName });
      } else if (event.type === "tool_execution_end") {
        forward({
          type: "tool_end",
          toolName: event.toolName,
          isError: event.isError,
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
      const prompt = session.prompt(buildUserPrompt(request));
      await request.emit({ type: "prompt_accepted" });
      await prompt;
      await emissionQueue;
      if (session.agent.state.errorMessage) {
        throw new Error(`Pi model error: ${session.agent.state.errorMessage}`);
      }
      return { output: output.trim() || "(Pi returned no text output)" };
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

export function resolvePiAvailability(
  spec: PiRuntimeSpec,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeAvailability {
  const credentialKeys: Record<string, string[]> = {
    "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
    zai: ["ZAI_API_KEY"],
    deepseek: ["DEEPSEEK_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    anthropic: ["ANTHROPIC_API_KEY"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  };
  const expected = credentialKeys[spec.provider];
  const configured = !expected || expected.some((key) => Boolean(environment[key]));
  return {
    available: configured,
    label: `${spec.provider}/${spec.model}`,
    ...(!configured
      ? { detail: `Missing credential: ${expected?.join(" or ") ?? "provider credential"}` }
      : {}),
  };
}

export function piToolsForAccess(accessMode: RuntimeRequest["agent"]["accessMode"]): string[] {
  if (accessMode === "read-only") {
    return ["read", "grep", "find", "ls", "post_message"];
  }
  if (accessMode === "workspace-write") {
    return ["read", "edit", "write", "grep", "find", "ls", "post_message"];
  }
  return ["read", "bash", "edit", "write", "grep", "find", "ls", "post_message"];
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
