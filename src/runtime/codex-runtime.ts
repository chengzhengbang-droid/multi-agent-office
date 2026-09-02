import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import type { AccessMode, CodexRuntimeSpec, RuntimeAvailability } from "../core/types.js";
import type { PriorArtEntry } from "../core/prior-art.js";
import { buildSystemPrompt, buildUserPrompt } from "./pi-runtime.js";
import type { AgentRuntime, RuntimeEvent, RuntimeRequest, RuntimeResult } from "./runtime.js";
import type { RuntimeSessionStore } from "./session-store.js";

export interface CodexRuntimeAdapterOptions {
  id: string;
  cwd: string;
  spec: CodexRuntimeSpec;
  /** The configured access is a default; plan mode narrows individual runs. */
  accessMode: AccessMode;
  fingerprint: string;
  sessionStore: RuntimeSessionStore;
  availability?: RuntimeAvailability;
}

type JsonRpcId = number | string;

interface DynamicToolResult {
  contentItems: Array<{ type: "inputText"; text: string }>;
  success: boolean;
}

interface UsageAccumulator {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  contextTokens?: number;
  contextWindow?: number;
}

interface TurnCompletion {
  id?: string;
  status?: string;
  error?: unknown;
}

/**
 * Dynamic tools persist with a Codex thread. Bump this when their contract
 * changes so sessions created by the old `codex exec` + MCP adapter are not
 * resumed without the native tools.
 */
export const CODEX_SESSION_PROTOCOL = "app-server-dynamic-tools-v4-prior-art";

export class CodexRuntimeAdapter implements AgentRuntime {
  public readonly id: string;
  public readonly availability: RuntimeAvailability;
  private readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

  public constructor(private readonly options: CodexRuntimeAdapterOptions) {
    this.id = options.id;
    this.availability = options.availability ?? resolveCodexAvailability(options.spec);
  }

  public async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const cwd = request.workingDirectory ?? this.options.cwd;
    const binding = await this.options.sessionStore.get(request.threadId, request.agent.id);
    const resumeSessionId =
      binding?.runtimeKind === "codex" && binding.fingerprint === this.options.fingerprint
        ? binding.locator
        : undefined;
    const child = spawn(this.options.spec.command, this.buildArgs(), {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.activeProcesses.set(request.runId, child);

    let stderr = "";
    let turnId: string | undefined;
    let completed = false;
    const outputParts: string[] = [];
    const completedItems = new Set<string>();
    const usage: UsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    };
    let emissionQueue = Promise.resolve();
    const forward = (event: RuntimeEvent): void => {
      emissionQueue = emissionQueue.then(() => request.emit(event));
    };
    const turnCompletion = deferred<TurnCompletion>();
    const connection = new CodexAppServerConnection(
      child,
      (message) => {
        const projection = projectCodexAppServerEvent(message);
        if (projection?.type === "text") {
          if (projection.itemId && completedItems.has(projection.itemId)) return;
          if (projection.itemId) completedItems.add(projection.itemId);
          outputParts.push(projection.text);
          forward({ type: "text_delta", text: projection.text });
          return;
        }
        if (projection?.type === "thinking") {
          forward({ type: "thinking_delta", text: projection.text });
          return;
        }
        if (projection?.type === "tool_start") {
          forward({
            type: "tool_start",
            toolName: projection.toolName,
            ...(projection.itemId ? { toolCallId: projection.itemId } : {}),
            ...(projection.args ? { args: projection.args } : {}),
          });
          return;
        }
        if (projection?.type === "tool_end") {
          if (projection.itemId && completedItems.has(projection.itemId)) return;
          if (projection.itemId) completedItems.add(projection.itemId);
          forward({
            type: "tool_end",
            toolName: projection.toolName,
            isError: projection.isError,
            ...(projection.itemId ? { toolCallId: projection.itemId } : {}),
            ...(projection.resultSummary ? { resultSummary: projection.resultSummary } : {}),
          });
          return;
        }
        if (projection?.type === "usage") {
          usage.inputTokens += projection.usage.inputTokens;
          usage.outputTokens += projection.usage.outputTokens;
          usage.cacheReadTokens += projection.usage.cacheReadTokens;
          usage.cacheWriteTokens += projection.usage.cacheWriteTokens;
          usage.totalTokens += projection.usage.totalTokens;
          if (projection.contextTokens !== undefined) usage.contextTokens = projection.contextTokens;
          if (projection.contextWindow !== undefined) usage.contextWindow = projection.contextWindow;
          return;
        }
        if (projection?.type === "turn_completed") {
          if (!turnId || !projection.turn.id || projection.turn.id === turnId) {
            turnCompletion.resolve(projection.turn);
          }
          return;
        }
        if (projection?.type === "error") {
          stderr += `${projection.message}\n`;
          forward({ type: "diagnostic", source: "runtime", message: projection.message });
        }
      },
      async (method, params) => {
        if (method !== "item/tool/call") {
          throw new Error(`Unsupported Codex app-server request: ${method}`);
        }
        const record = asRecord(params);
        const tool = typeof record?.tool === "string" ? record.tool : "";
        return executeDynamicTool(request, tool, record?.arguments);
      },
    );
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });
    const exitPromise = waitForExit(child);
    void exitPromise.then(
      (exit) => {
        if (!completed) {
          connection.close(
            new Error(
              `Codex app-server exited with ${exit.code ?? exit.signal ?? "unknown status"}: ${stderr.trim().slice(-2_000) || "no diagnostic output"}`,
            ),
          );
        }
      },
      (error: unknown) => connection.close(error instanceof Error ? error : new Error(String(error))),
    );

    const onAbort = () => {
      connection.close(abortError(request.signal.reason));
      terminate(child);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (request.signal.aborted) {
        onAbort();
        throw abortError(request.signal.reason);
      }
      await connection.request("initialize", {
        clientInfo: { name: "multi-agent-office", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      connection.notify("initialized");

      const accessMode = request.agent.accessMode ?? this.options.accessMode;
      const threadResult = resumeSessionId
        ? await connection.request("thread/resume", {
            threadId: resumeSessionId,
            cwd,
            approvalPolicy: "never",
            sandbox: accessSandbox(accessMode),
            ...(this.options.spec.model ? { model: this.options.spec.model } : {}),
          })
        : await connection.request("thread/start", {
            cwd,
            approvalPolicy: "never",
            sandbox: accessSandbox(accessMode),
            dynamicTools: codexDynamicTools(),
            ...(this.options.spec.model ? { model: this.options.spec.model } : {}),
          });
      const sessionId = threadIdFromResult(threadResult);
      await request.emit({
        type: "session",
        runtimeKind: "codex",
        resumed: Boolean(resumeSessionId),
      });

      const prompt = [
        "<agent-system-instructions>",
        buildSystemPrompt(request),
        "</agent-system-instructions>",
        "",
        buildUserPrompt(request),
        ...(request.attachments && request.attachments.length > 0
          ? [
              "",
              "<attachments>",
              ...request.attachments.map(
                (attachment) => `${attachment.mediaType} ${attachment.path}`,
              ),
              "</attachments>",
            ]
          : []),
      ].join("\n");
      const input: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
      for (const attachment of request.attachments ?? []) {
        if (attachment.mediaType.startsWith("image/")) {
          input.push({ type: "localImage", path: attachment.path });
        } else if (attachment.mediaType.startsWith("audio/")) {
          input.push({ type: "localAudio", path: attachment.path });
        }
      }
      const turnResult = await connection.request("turn/start", {
        threadId: sessionId,
        input,
        cwd,
        approvalPolicy: "never",
        ...(this.options.spec.model ? { model: this.options.spec.model } : {}),
        ...(this.options.spec.reasoningEffort ? { effort: this.options.spec.reasoningEffort } : {}),
      });
      turnId = turnIdFromResult(turnResult);
      await request.emit({ type: "prompt_accepted" });

      const turn = await Promise.race([
        turnCompletion.promise,
        connection.closedPromise.then((error) => Promise.reject(error)),
      ]);
      await emissionQueue;
      if (request.signal.aborted) throw abortError(request.signal.reason);
      if (turn.status !== "completed") {
        throw new Error(`Codex turn ${turn.status ?? "failed"}: ${turnErrorMessage(turn.error)}`);
      }
      await this.options.sessionStore.set({
        threadId: request.threadId,
        agentId: request.agent.id,
        runtimeKind: "codex",
        fingerprint: this.options.fingerprint,
        locator: sessionId,
        updatedAt: new Date().toISOString(),
      });
      if (usage.totalTokens > 0) {
        await request.emit({ type: "usage", ...usage, costUsd: 0 });
      }
      completed = true;
      terminate(child);
      await exitPromise.catch(() => undefined);
      return { output: outputParts.join("\n\n").trim() || "(Codex returned no text output)" };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      connection.close(new Error("Codex run ended"));
      if (!completed) {
        terminate(child);
        // Do not release the run while its app-server still owns the working
        // directory. Windows refuses to remove or replace that directory until
        // the child has fully exited.
        await exitPromise.catch(() => undefined);
      }
      this.activeProcesses.delete(request.runId);
    }
  }

  public async cancel(runId: string): Promise<void> {
    const child = this.activeProcesses.get(runId);
    if (!child) return;
    terminate(child);
    await waitForExit(child).catch(() => undefined);
  }

  private buildArgs(): string[] {
    return [
      ...(this.options.spec.profile ? ["--profile", this.options.spec.profile] : []),
      "app-server",
      "--stdio",
    ];
  }
}

export function resolveCodexAvailability(spec: CodexRuntimeSpec): RuntimeAvailability {
  const appServer = spawnSync(spec.command, ["app-server", "--help"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (appServer.error) {
    return { available: false, label: "Codex CLI", detail: appServer.error.message };
  }
  if (appServer.status !== 0) {
    return {
      available: false,
      label: "Codex CLI",
      detail: "This Codex CLI does not support app-server dynamic tools; update Codex to use this Agent.",
    };
  }
  const result = spawnSync(spec.command, ["login", "status"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) return { available: false, label: "Codex CLI", detail: result.error.message };
  if (result.status !== 0) {
    if (process.env.OPENAI_API_KEY) {
      return { available: true, label: spec.model ? `Codex/${spec.model}` : "Codex/API key" };
    }
    return {
      available: false,
      label: "Codex CLI",
      detail: (result.stderr || result.stdout || "Codex is not logged in").trim(),
    };
  }
  return {
    available: true,
    label: spec.model ? `Codex/${spec.model}` : "Codex/default model",
  };
}

export type CodexAppServerProjection =
  | { type: "text"; text: string; itemId?: string }
  | { type: "thinking"; text: string }
  | { type: "tool_start"; toolName: string; itemId?: string; args?: string }
  | { type: "tool_end"; toolName: string; itemId?: string; isError: boolean; resultSummary?: string }
  | {
      type: "usage";
      usage: Omit<UsageAccumulator, "contextTokens" | "contextWindow">;
      contextTokens?: number;
      contextWindow?: number;
    }
  | { type: "turn_completed"; turn: TurnCompletion }
  | { type: "error"; message: string };

/** Pure app-server notification projection used by the adapter and fixtures. */
export function projectCodexAppServerEvent(value: unknown): CodexAppServerProjection | undefined {
  const record = asRecord(value);
  if (!record || typeof record.method !== "string") return undefined;
  const params = asRecord(record.params);
  if (record.method === "item/reasoning/summaryTextDelta" && typeof params?.delta === "string") {
    return { type: "thinking", text: params.delta };
  }
  if (record.method === "item/completed") {
    const item = asRecord(params?.item);
    const itemType = typeof item?.type === "string" ? item.type : undefined;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    if (itemType === "agentMessage" && typeof item?.text === "string") {
      return { type: "text", text: item.text, ...(itemId ? { itemId } : {}) };
    }
    if (item && itemType && isToolItem(itemType)) {
      const resultSummary = toolResultSummary(item);
      return {
        type: "tool_end",
        toolName: toolName(itemType, item),
        ...(itemId ? { itemId } : {}),
        isError: toolItemFailed(item),
        ...(resultSummary ? { resultSummary } : {}),
      };
    }
    return undefined;
  }
  if (record.method === "item/started") {
    const item = asRecord(params?.item);
    const itemType = typeof item?.type === "string" ? item.type : undefined;
    if (!item || !itemType || !isToolItem(itemType)) return undefined;
    const itemId = typeof item.id === "string" ? item.id : undefined;
    const args = summarizePayload(item.arguments ?? item.command ?? item.changes);
    return {
      type: "tool_start",
      toolName: toolName(itemType, item),
      ...(itemId ? { itemId } : {}),
      ...(args ? { args } : {}),
    };
  }
  if (record.method === "thread/tokenUsage/updated") {
    const tokenUsage = asRecord(params?.tokenUsage);
    const last = asRecord(tokenUsage?.last);
    const total = asRecord(tokenUsage?.total);
    if (!last) return undefined;
    return {
      type: "usage",
      usage: {
        inputTokens: numberField(last.inputTokens),
        outputTokens: numberField(last.outputTokens),
        cacheReadTokens: numberField(last.cachedInputTokens),
        cacheWriteTokens: numberField(last.cacheWriteInputTokens),
        totalTokens: numberField(last.totalTokens),
      },
      ...(total ? { contextTokens: numberField(total.totalTokens) } : {}),
      ...(typeof tokenUsage?.modelContextWindow === "number"
        ? { contextWindow: tokenUsage.modelContextWindow }
        : {}),
    };
  }
  if (record.method === "turn/completed") {
    const turn = asRecord(params?.turn);
    if (!turn) return undefined;
    return {
      type: "turn_completed",
      turn: {
        ...(typeof turn.id === "string" ? { id: turn.id } : {}),
        ...(typeof turn.status === "string" ? { status: turn.status } : {}),
        ...(turn.error !== undefined ? { error: turn.error } : {}),
      },
    };
  }
  if (record.method === "error") {
    const error = asRecord(params?.error);
    const message =
      typeof params?.message === "string"
        ? params.message
        : typeof error?.message === "string"
          ? error.message
          : "Codex app-server error";
    return { type: "error", message };
  }
  return undefined;
}

function codexDynamicTools(): Array<Record<string, unknown>> {
  const stringArray = { type: "array", items: { type: "string" } };
  return [
    {
      type: "function",
      name: "post_message",
      description:
        "Post a visible structured collaboration message. handoff transfers the next action; fyi does not. Multi-target dispatch is serial unless routingMode is explicitly parallel.",
      inputSchema: {
        type: "object",
        properties: {
          content: { type: "string", minLength: 1, maxLength: 20_000 },
          intent: { type: "string" },
          collaborationIntent: { type: "string", enum: ["handoff", "fyi", "done_notify"] },
          routingMode: { type: "string", enum: ["serial", "parallel"] },
          idempotencyKey: { type: "string", minLength: 1 },
        },
        required: ["content", "idempotencyKey"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "hold_ball",
      description:
        "Keep custody while waiting for a named external condition. Requires grounded waitSourceRef; the platform persists the hold and wakes this Agent after wakeAfterMs.",
      inputSchema: {
        type: "object",
        properties: {
          wakeAfterMs: { type: "number", minimum: 10, maximum: 86_400_000 },
          waitSourceRef: {
            type: "object",
            properties: {
              kind: { type: "string", minLength: 1 },
              value: { type: "string", minLength: 1 },
              expectedSignal: { type: "string", minLength: 1 },
              slaUntil: { type: "string" },
            },
            required: ["kind", "value", "expectedSignal"],
            additionalProperties: false,
          },
        },
        required: ["wakeAfterMs", "waitSourceRef"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "submit_review",
      description:
        "Record your current verdict in a peer discussion. Call exactly once. Approve only a final candidate you checked and can stand behind; changes-requested states evidence-backed objections, not orders.",
      inputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approved", "changes-requested"] },
          summary: { type: "string", minLength: 1, maxLength: 20_000 },
          findings: stringArray,
          checks: stringArray,
        },
        required: ["verdict", "summary"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "request_clarification",
      description:
        "Ask the human before planning or executing when missing input would materially change the outcome. questions may be strings, or objects with question and optional options [{label,value,recommended}]; use recommended for the best default. Ask the same focused questions in your response, then stop without submitting a deliverable.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            items: { anyOf: [
              { type: "string", minLength: 1, maxLength: 2_000 },
              { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 2_000 }, options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, recommended: { type: "boolean" } }, required: ["label"], additionalProperties: false } } }, required: ["question"], additionalProperties: false },
            ] },
            minItems: 1,
            maxItems: 5,
          },
        },
        required: ["questions"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "record_prior_art",
      description:
        "While planning, before submit_plan: record how comparable systems solve this and what you decided about each. Pass entries you actually examined, or abstained with the reason you examined none (nothing comparable, unreachable from this run, or too local to inform). adopt requires a firsthand look (sourceKind source or docs) plus checked naming the file or command that proved the claim; adapt and reject require tradeoff. Declining to copy a precedent is a valid answer; saying nothing is not.",
      inputSchema: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                source: { type: "string", minLength: 1, maxLength: 2_000 },
                sourceKind: { type: "string", enum: ["source", "docs", "marketing", "secondhand"] },
                claim: { type: "string", minLength: 1, maxLength: 2_000 },
                verdict: { type: "string", enum: ["adopt", "adapt", "reject"] },
                checked: { type: "string", maxLength: 2_000 },
                tradeoff: { type: "string", maxLength: 2_000 },
              },
              required: ["source", "sourceKind", "claim", "verdict"],
              additionalProperties: false,
            },
          },
          abstained: { type: "string", minLength: 1, maxLength: 2_000 },
        },
        additionalProperties: false,
      },
    },
    ...(["complete_task", "submit_plan"] as const).map((name) => ({
      type: "function",
      name,
      description:
        name === "complete_task"
          ? "Declare finished work and submit it for peer verification. Include evidence another Agent can check. Never call while material human questions remain unresolved; use request_clarification first."
          : "Submit a ready-to-execute plan for peer critique before the human decides whether to execute it. Never submit a provisional plan with blocking questions; use request_clarification first.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 20_000 },
          evidence: stringArray,
        },
        required: ["summary"],
        additionalProperties: false,
      },
    })),
  ];
}

async function executeDynamicTool(
  request: RuntimeRequest,
  tool: string,
  rawArguments: unknown,
): Promise<DynamicToolResult> {
  try {
    const args = asRecord(rawArguments);
    if (!args) throw new Error("Tool arguments must be an object");
    if (tool === "post_message") {
      const intent = optionalString(args, "intent");
      const collaborationIntent = optionalCollaborationIntent(args.collaborationIntent);
      const routingMode = optionalRoutingMode(args.routingMode);
      const result = await request.postMessage({
        content: requiredString(args, "content"),
        idempotencyKey: requiredString(args, "idempotencyKey"),
        ...(intent ? { intent } : {}),
        ...(collaborationIntent ? { collaborationIntent } : {}),
        ...(routingMode ? { routingMode } : {}),
      });
      return toolResult(
        result.accepted,
        result.accepted
          ? result.targets.length > 0
            ? `Visible message routed to ${result.targets.map((id) => `@${id}`).join(", ")}.`
            : "Visible message posted without waking another Agent."
          : `Message routing rejected: ${result.reason ?? "unknown reason"}`,
      );
    }
    if (tool === "hold_ball") {
      const waitSourceRef = asRecord(args.waitSourceRef);
      if (!waitSourceRef) throw new Error("waitSourceRef is required");
      const wakeAfterMs = args.wakeAfterMs;
      if (typeof wakeAfterMs !== "number" || !Number.isFinite(wakeAfterMs)) {
        throw new Error("wakeAfterMs must be a number");
      }
      const slaUntil = optionalString(waitSourceRef, "slaUntil");
      const result = await request.holdBall({
        wakeAfterMs,
        waitSourceRef: {
          kind: requiredString(waitSourceRef, "kind"),
          value: requiredString(waitSourceRef, "value"),
          expectedSignal: requiredString(waitSourceRef, "expectedSignal"),
          ...(slaUntil ? { slaUntil } : {}),
        },
      });
      return toolResult(
        result.accepted,
        result.accepted
          ? `Ball held until ${result.wakeAt}. End this turn; the platform will wake you.`
          : `Ball hold rejected: ${result.reason ?? "unknown reason"}`,
      );
    }
    if (tool === "submit_review") {
      if (!request.submitReview) {
        return toolResult(false, "submit_review is only available while reviewing another Agent's work.");
      }
      const verdict = args.verdict;
      if (verdict !== "approved" && verdict !== "changes-requested") {
        throw new Error("verdict must be approved or changes-requested");
      }
      const findings = optionalStringArray(args, "findings");
      const checks = optionalStringArray(args, "checks");
      const result = await request.submitReview({
        verdict,
        summary: requiredString(args, "summary"),
        ...(findings ? { findings } : {}),
        ...(checks ? { checks } : {}),
      });
      return toolResult(
        result.accepted,
        result.accepted
          ? `Verdict recorded: ${verdict}.`
          : `Verdict rejected: ${result.reason ?? "unknown reason"}`,
      );
    }
    if (tool === "request_clarification") {
      const rawQuestions = args.questions;
      if (!Array.isArray(rawQuestions)) throw new Error("questions is required");
      const questions = rawQuestions.map((question) => typeof question === "string" ? question : {
        question: requiredString(question as Record<string, unknown>, "question"),
        ...(Array.isArray((question as Record<string, unknown>).options) ? { options: ((question as Record<string, unknown>).options as unknown[]).filter((option): option is Record<string, unknown> => Boolean(option && typeof option === "object") && typeof (option as Record<string, unknown>).label === "string").map((option) => ({ label: option.label as string, ...(typeof option.value === "string" ? { value: option.value } : {}), ...(typeof option.recommended === "boolean" ? { recommended: option.recommended } : {}) })) } : {}),
      });
      const result = await request.requestClarification({ questions });
      return toolResult(
        result.accepted,
        result.accepted
          ? "Clarification requested. Ask the questions in your response, do not submit a deliverable, and stop."
          : `Clarification request rejected: ${result.reason ?? "unknown reason"}`,
      );
    }
    if (tool === "record_prior_art") {
      const abstained = args.abstained;
      const result = await request.recordPriorArt({
        ...(Array.isArray(args.entries) ? { entries: args.entries as PriorArtEntry[] } : {}),
        ...(typeof abstained === "string" ? { abstained } : {}),
      });
      return toolResult(
        result.accepted,
        result.accepted
          ? "Prior art recorded. It travels with this plan to the peer critique and to the human's approval card."
          : `Prior art rejected: ${result.reason ?? "unknown reason"}`,
      );
    }
    if (tool === "complete_task" || tool === "submit_plan") {
      const kind = tool === "complete_task" ? "completion" : "plan";
      const evidence = optionalStringArray(args, "evidence");
      const result = await request.declareDeliverable({
        kind,
        summary: requiredString(args, "summary"),
        ...(evidence ? { evidence } : {}),
      });
      return toolResult(
        result.accepted,
        result.accepted
          ? kind === "completion"
            ? "Completed work submitted for peer verification."
            : "Plan submitted for peer critique."
          : `Declaration rejected: ${result.reason ?? "unknown reason"}`,
      );
    }
    return toolResult(false, `Unknown collaboration tool: ${tool || "(missing name)"}`);
  } catch (error) {
    return toolResult(false, errorMessage(error));
  }
}

function toolResult(success: boolean, text: string): DynamicToolResult {
  return { success, contentItems: [{ type: "inputText", text }] };
}

class CodexAppServerConnection {
  private readonly lines: ReadLineInterface;
  private readonly pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly closed = deferred<Error>();
  private nextId = 1;
  private isClosed = false;

  public readonly closedPromise = this.closed.promise;

  public constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: (message: Record<string, unknown>) => void,
    private readonly onRequest: (method: string, params: unknown) => Promise<unknown>,
  ) {
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.receive(line));
  }

  public request(method: string, params: unknown): Promise<unknown> {
    if (this.isClosed) return Promise.reject(new Error("Codex app-server connection is closed"));
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send({ id, method, params });
    return Promise.race([promise, this.closedPromise.then((error) => Promise.reject(error))]);
  }

  public notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }

  public close(error: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.lines.close();
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.closed.resolve(error);
  }

  private receive(line: string): void {
    let message: Record<string, unknown> | undefined;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (!message) return;
    if (typeof message.method === "string") {
      if (isJsonRpcId(message.id)) {
        void this.onRequest(message.method, message.params).then(
          (result) => this.send({ id: message.id, result }),
          (error: unknown) => this.send({
            id: message.id,
            error: { code: -32_601, message: errorMessage(error) },
          }),
        );
      } else {
        this.onNotification(message);
      }
      return;
    }
    if (!isJsonRpcId(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error !== undefined) pending.reject(new Error(jsonRpcError(message.error)));
    else pending.resolve(message.result);
  }

  private send(message: Record<string, unknown>): void {
    if (this.isClosed || this.child.stdin.destroyed) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`, "utf8");
  }
}

function accessSandbox(accessMode: AccessMode): "read-only" | "workspace-write" {
  return accessMode === "read-only" ? "read-only" : "workspace-write";
}

function toolName(itemType: string, item: Record<string, unknown>): string {
  if (itemType === "commandExecution") return "command_execution";
  if (itemType === "fileChange") return "file_change";
  if (itemType === "dynamicToolCall") return typeof item.tool === "string" ? item.tool : "tool";
  if (itemType === "mcpToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return `mcp:${tool}`;
  }
  if (itemType === "webSearch") return "web_search";
  return itemType;
}

function isToolItem(itemType: string): boolean {
  return ["commandExecution", "fileChange", "dynamicToolCall", "mcpToolCall", "webSearch"].includes(itemType);
}

function toolItemFailed(item: Record<string, unknown>): boolean {
  return item.status === "failed" || item.status === "declined" || item.success === false ||
    (typeof item.exitCode === "number" && item.exitCode !== 0) || Boolean(item.error);
}

function toolResultSummary(item: Record<string, unknown>): string | undefined {
  return summarizePayload(item.contentItems ?? item.aggregatedOutput ?? item.error);
}

function summarizePayload(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    if (!serialized) return undefined;
    return serialized.length <= 2_000 ? serialized : `${serialized.slice(0, 2_000)}…`;
  } catch {
    return undefined;
  }
}

function threadIdFromResult(value: unknown): string {
  const thread = asRecord(asRecord(value)?.thread);
  if (typeof thread?.id !== "string" || !thread.id) {
    throw new Error("Codex app-server did not return a thread id");
  }
  return thread.id;
}

function turnIdFromResult(value: unknown): string {
  const turn = asRecord(asRecord(value)?.turn);
  if (typeof turn?.id !== "string" || !turn.id) {
    throw new Error("Codex app-server did not return a turn id");
  }
  return turn.id;
}

function turnErrorMessage(value: unknown): string {
  const error = asRecord(value);
  return typeof error?.message === "string" ? error.message : summarizePayload(value) ?? "no diagnostic output";
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}

function optionalCollaborationIntent(
  value: unknown,
): "handoff" | "fyi" | "done_notify" | undefined {
  if (value === undefined) return undefined;
  if (value === "handoff" || value === "fyi" || value === "done_notify") return value;
  throw new Error("collaborationIntent must be handoff, fyi, or done_notify");
}

function optionalRoutingMode(value: unknown): "serial" | "parallel" | undefined {
  if (value === undefined) return undefined;
  if (value === "serial" || value === "parallel") return value;
  throw new Error("routingMode must be serial or parallel");
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "number" || typeof value === "string";
}

function jsonRpcError(value: unknown): string {
  const error = asRecord(value);
  return typeof error?.message === "string" ? error.message : summarizePayload(value) ?? "RPC error";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000);
  timer.unref();
}

function abortError(reason: unknown): Error {
  const error = new Error(String(reason ?? "Aborted"));
  error.name = "AbortError";
  return error;
}
