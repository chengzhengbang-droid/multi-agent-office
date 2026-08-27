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
import { providerEnvKeys } from "../config/provider-presets.js";
import type { PiRuntimeSpec, RuntimeAvailability } from "../core/types.js";
import { PiSharedRuntime, RequestResourceLoader } from "./pi-shared.js";
import type {
  AgentRuntime,
  PostAgentMessageInput,
  ReviewAssignment,
  RuntimeRequest,
  RuntimeResult,
  RuntimeSessionStats,
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
  private readonly sessionsByThread = new Map<string, AgentSession>();

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

    // Declared on every run so a resumed session keeps a stable tool surface.
    // Authority to accept a verdict lives in the platform, which refuses any
    // submission from a run that is not reviewing someone else's work.
    const submitReviewTool = defineTool({
      name: "submit_review",
      label: "Submit a peer-review verdict",
      description:
        "Record your current verdict in a peer discussion. Only available while reviewing another Agent's deliverable. Approve a final candidate you checked and can stand behind; changes-requested states objections for continued discussion. Call it exactly once.",
      parameters: Type.Object({
        verdict: Type.Union([Type.Literal("approved"), Type.Literal("changes-requested")], {
          description: "approved when the work can ship as is",
        }),
        summary: Type.String({ description: "Justification handed back to the author verbatim" }),
        findings: Type.Optional(
          Type.Array(Type.String(), {
            description: "Concrete, actionable changes. Required for changes-requested.",
          }),
        ),
        checks: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "What you verified yourself: files you opened, commands you ran, output you read. Required for approved.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) => {
        const submit = request.submitReview;
        if (!submit) {
          return {
            content: [
              {
                type: "text",
                text: "submit_review is only available while reviewing another Agent's work.",
              },
            ],
            details: { accepted: false },
          };
        }
        const result = await submit({
          verdict: params.verdict,
          summary: params.summary,
          ...(params.findings ? { findings: params.findings } : {}),
          ...(params.checks ? { checks: params.checks } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text: result.accepted
                ? `Verdict recorded: ${params.verdict}.`
                : `Verdict rejected: ${result.reason ?? "unknown reason"}`,
            },
          ],
          details: result,
        };
      },
    });

    const requestClarificationTool = defineTool({
      name: "request_clarification",
      label: "Ask the human before planning or executing",
      description:
        "Call before submit_plan or complete_task when missing human input would materially change the goal, architecture, acceptance criteria, or implementation. Each question may include options with label/value/recommended to give the human a choice. Ask only the smallest focused set of questions, put the same questions in your assistant response, then stop and wait. Do not use this for details you can discover locally or resolve with a safe reversible assumption.",
      parameters: Type.Object({
        questions: Type.Array(Type.Union([Type.String(), Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), value: Type.Optional(Type.String()), recommended: Type.Optional(Type.Boolean()) }))) })]), {
          minItems: 1,
          maxItems: 5,
          description: "The focused questions the human must answer before the task can continue",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const result = await request.requestClarification({ questions: params.questions });
        return {
          content: [
            {
              type: "text",
              text: result.accepted
                ? "Clarification requested. Ask these questions in your response, do not submit a deliverable, and stop."
                : `Clarification request rejected: ${result.reason ?? "unknown reason"}`,
            },
          ],
          details: result,
        };
      },
    });

    // Declaring a deliverable is how an Agent opens the review gate on itself.
    // Declared on every run so a resumed session keeps a stable tool surface;
    // the platform decides whether a declaration is admissible.
    const declare = async (
      kind: "completion" | "plan",
      summary: string,
      evidence: string[] | undefined,
      verb: string,
    ) => {
      const result = await request.declareDeliverable({
        kind,
        summary,
        ...(evidence ? { evidence } : {}),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: result.accepted
              ? `${verb} submitted for peer review. A different Agent will check it before it counts as delivered.`
              : `Declaration rejected: ${result.reason ?? "unknown reason"}`,
          },
        ],
        details: result,
      };
    };

    const completeTaskTool = defineTool({
      name: "complete_task",
      label: "Declare the task finished and submit it for verification",
      description:
        "Call when you have FINISHED work a human asked for and produced a real deliverable. Include evidence a reviewer can check: files you changed, commands you ran, how to verify it. This submits your work to a peer for verification — your own word that it is done is not enough. Do not call it for conversation, questions, explanations, or while material human questions remain unresolved; use request_clarification first.",
      parameters: Type.Object({
        summary: Type.String({ description: "What you delivered, in your own words" }),
        evidence: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "How a reviewer can check the claim: files changed, commands run, tests to execute.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) =>
        declare("completion", params.summary, params.evidence, "Completed work"),
    });

    const submitPlanTool = defineTool({
      name: "submit_plan",
      label: "Submit a plan for peer critique",
      description:
        "Call only when your plan, design, or proposal is ready to be pressure-tested as written. A teammate critiques it, then the human decides whether it gets built. Do not submit a plan that still contains blocking questions or choices for the human; call request_clarification first and wait. Do not call it for conversation or finished work.",
      parameters: Type.Object({
        summary: Type.String({ description: "The plan you are proposing, in your own words" }),
        evidence: Type.Optional(
          Type.Array(Type.String(), {
            description:
              "Evidence, constraints, and non-blocking assumptions supporting the ready plan. Human choices that would change the plan must be resolved through request_clarification before submission.",
          }),
        ),
      }),
      execute: async (_toolCallId, params) =>
        declare("plan", params.summary, params.evidence, "Plan"),
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
      customTools: [
        postMessageTool,
        submitReviewTool,
        requestClarificationTool,
        completeTaskTool,
        submitPlanTool,
      ],
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
    this.sessionsByThread.set(request.threadId, session);
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
      this.sessionsByThread.delete(request.threadId);
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

  public async dispose(): Promise<void> {
    for (const session of this.activeSessions.values()) await session.abort();
    this.activeSessions.clear();
    this.sessionsByThread.clear();
  }

  public async sessionStats(threadId: string): Promise<RuntimeSessionStats | undefined> {
    return this.withSession(threadId, async (session) => {
      const stats = session.getSessionStats();
      const context = session.getContextUsage();
      return {
        sessionId: stats.sessionId,
        ...(stats.sessionFile ? { sessionFile: stats.sessionFile } : {}),
        userMessages: stats.userMessages,
        assistantMessages: stats.assistantMessages,
        toolCalls: stats.toolCalls,
        totalTokens: stats.tokens.total,
        costUsd: stats.cost,
        ...(context?.tokens !== null && context !== undefined
          ? { contextTokens: context.tokens, contextWindow: context.contextWindow }
          : {}),
      };
    });
  }

  public async compactSession(
    threadId: string,
  ): Promise<{ compacted: boolean; detail: string }> {
    // Compaction aborts the agent, so it must not run against a live session.
    if (this.sessionsByThread.has(threadId)) {
      return { compacted: false, detail: "该 Agent 正在运行，请等待本轮结束后再压缩" };
    }
    const result = await this.withSession(threadId, async (session) => {
      const compaction = await session.compact();
      const after = compaction.estimatedTokensAfter;
      return {
        compacted: true,
        detail:
          after === undefined
            ? `已压缩，压缩前约 ${compaction.tokensBefore} tokens`
            : `已压缩：约 ${compaction.tokensBefore} → ${after} tokens`,
      };
    });
    return result ?? { compacted: false, detail: "该 Agent 在此任务中还没有 session" };
  }

  public async exportSession(
    threadId: string,
    format: "html" | "jsonl",
  ): Promise<string> {
    const path = await this.withSession(threadId, async (session) =>
      format === "html" ? await session.exportToHtml() : session.exportToJsonl(),
    );
    if (!path) throw new Error("该 Agent 在此任务中还没有 session");
    return path;
  }

  /**
   * Runs an operation against this Agent's session for a thread. A live session
   * is reused; otherwise the persisted session file is reopened read-mostly and
   * disposed afterwards, so idle threads hold no resources.
   */
  private async withSession<T>(
    threadId: string,
    operation: (session: AgentSession) => Promise<T>,
  ): Promise<T | undefined> {
    const live = this.sessionsByThread.get(threadId);
    if (live) return operation(live);
    const binding = await this.options.sessionStore.get(threadId, this.id);
    if (
      !binding ||
      binding.runtimeKind !== "pi" ||
      binding.fingerprint !== this.options.fingerprint ||
      !existsSync(binding.locator)
    ) {
      return undefined;
    }
    const cwd = this.options.cwd;
    const { loader: sharedLoader, settingsManager } =
      await this.options.shared.resourcesFor(cwd);
    const modelRuntime = await this.options.shared.modelRuntime();
    const selectedModel = this.resolveModel(modelRuntime);
    const { session } = await createAgentSession({
      cwd,
      resourceLoader: new RequestResourceLoader(sharedLoader, ""),
      sessionManager: SessionManager.open(binding.locator),
      settingsManager,
      modelRuntime,
      ...(selectedModel.model ? { model: selectedModel.model } : {}),
    });
    try {
      return await operation(session);
    } finally {
      session.dispose();
    }
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
const PROVIDER_ENVIRONMENT_KEYS: Record<string, string[]> = providerEnvKeys();

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
    "- You are a peer. There is no boss Agent and no fixed handoff pipeline.",
    "- Judge for yourself what your output is. Conversation, questions, and explanations are just answers: declare nothing, and nobody reviews them.",
    "- Before drafting a plan or starting execution, check whether missing human input would materially change the goal, architecture, acceptance criteria, or implementation. If so, call request_clarification, ask only the smallest necessary questions in your response, then stop. Do not create or submit a provisional deliverable and do not ask a peer to review it.",
    "- After the human answers, generate or execute the work, resolve any remaining non-blocking uncertainty with explicit safe assumptions, and only then submit the deliverable for peer review.",
    "- Finished work a human asked for is a deliverable: call complete_task with evidence a reviewer can check (files changed, commands run, how to verify).",
    "- A plan, design, or proposal is a deliverable too: call submit_plan so a peer pressure-tests it and the human decides before anyone builds it.",
    "- What you declare is reviewed by a different peer before it counts as delivered. The reviewer is a peer, not a supervisor.",
    "- Your own word that the work is done does not settle it. Neither does a teammate's: when you review, disbelieve first and check the artifacts yourself.",
    "- Review findings are arguments, not commands. When your work comes back, use your own judgment: improve what is genuinely wrong, rebut mistaken claims with evidence, and offer alternatives where neither proposal is best.",
    "- Discuss through the ordinary response and the next complete candidate; there is no separate accept/reject ceremony for the author. Do not comply merely to satisfy the reviewer.",
    "- Accept work you can own; challenge weak assumptions with evidence. The goal is a version both peers can stand behind, or a clear disagreement for the human to decide.",
    "- If a teammate should act, call post_message and put their @handle at the start of a line.",
    "- A post_message without a recognized teammate mention is visible to the human but wakes nobody.",
    "- Ordinary assistant output, including @handles, never routes to another Agent.",
    "- Do not retry a rejected post_message with a new idempotency key.",
    "- Do not request clarification for facts you can inspect yourself or details that a safe reversible assumption can settle.",
    ...(request.planMode ? planBrief() : []),
    ...(request.reviewOf ? reviewBrief(request.reviewOf) : []),
    "",
    "Available peers:",
    roster || "(none)",
  ].join("\n");
}

/**
 * Plan mode: the human asked what you would do, not for you to do it. Read-only
 * is enforced by the tool surface, so the brief spends its words on what makes
 * a plan worth approving rather than on repeating the prohibition.
 */
function planBrief(): string[] {
  return [
    "",
    "Plan mode is on for this run — the human asked for a plan, not the work:",
    "- You are read-only here. Editing and shell tools are withheld deliberately, not by accident.",
    "- Investigate first. Read the code, the tests, and the configuration you would touch, and plan against what is actually there.",
    "- Write the plan so someone else could execute it: the files to change, the order to change them in, and how each step is verified.",
    "- Resolve uncertainty before submission: ask the human first when an answer would materially change the plan; otherwise state the safe non-blocking assumptions you made.",
    "- Finish by calling submit_plan only when the plan is executable as written and contains no blocking questions. A peer critiques it, then the human decides whether it is built.",
    "- Nothing here is executed until the human approves it, so do not promise progress you have not made.",
  ];
}

function reviewBrief(assignment: ReviewAssignment): string[] {
  const critique = assignment.reviewType === "critique";
  const header = critique
    ? `Independent critique assignment — you are the skeptic on @${assignment.authorAgentId}'s plan, round ${assignment.round} of ${assignment.maxRounds}:`
    : `Independent verification assignment — you are the skeptic on @${assignment.authorAgentId}'s completed work, round ${assignment.round} of ${assignment.maxRounds}:`;
  // A plan is judged on its reasoning; finished work is judged on artifacts.
  // Both start from disbelief: reading the author's summary and agreeing with
  // it is not review, it is repetition. Trust is what the evidence has to buy.
  const body = critique
    ? [
        "- Start from not-ready. The plan has to convince you; your doubt needs no justification.",
        "- Judge it against the human's original task, not against the author's framing of that task.",
        "- Attack the assumptions it never argues for, the failure modes it skips, the work it hides behind one line.",
        "- approved means both peers have reached a plan you would put your own name on executing as written; changes-requested states concrete objections for continued discussion.",
      ]
    : [
        "- Start from not-approved. The author's claim is the thing under test, not evidence for itself.",
        "- Reach the primary sources yourself: open the files it says it changed, run the commands it says it ran, read the real output.",
        "- Treat the author's evidence list as a set of assertions to reproduce, not a report to summarize.",
        "- Hunt for what a confident claim would hide: dropped requirements, untouched edge cases, error paths, tests that assert nothing, changes it never mentioned.",
        "- Anything you could not check with the access you have is unverified: say so, and never approve on it.",
        "- Do not redo the work yourself. State concrete objections and the evidence behind them.",
      ];
  return [
    "",
    header,
    ...body,
    ...(assignment.round > 1
      ? [
          "- This is a continued discussion, not a compliance inspection. Read the author's latest reasoning and candidate on their merits.",
          "- The author may adopt, rebut, or replace your earlier suggestion. Reconsider it honestly; do not repeat a finding without answering the author's evidence.",
          "- Withdraw or refine an objection when the author has resolved it. Either peer is allowed to change their mind.",
        ]
      : [
          "- Your findings are peer arguments, not orders. The author may adopt them, rebut them with evidence, or propose a better alternative.",
        ]),
    ...(assignment.independent
      ? []
      : [
          "- You already worked in this chain, so you are not a neutral party: no uninvolved peer was available.",
          "- Hold your own contribution to the standard you would apply to anyone else's.",
        ]),
    "- Finish by calling submit_review exactly once, approved or changes-requested.",
    "- changes-requested requires at least one concrete finding.",
    "- approved requires listing in checks what you ran yourself; an approval that cannot name one is rejected.",
    "- Ending without submit_review is not an approval: the task is escalated to the human.",
    "- The goal is a final candidate both peers can stand behind, not obedience to you and not victory for either side.",
    "- Do not manufacture agreement to close the loop. If material disagreement remains in the final round, request changes so the human decides.",
    ...(assignment.round >= assignment.maxRounds
      ? ["- This is the final round. If material disagreement remains, request changes so the human decides."]
      : []),
  ];
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
