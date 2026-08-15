import { createId } from "./ids.js";
import type { ContextCompiler } from "./context-compiler.js";
import type { EventStore } from "./event-store.js";
import type {
  AgentDefinition,
  AgentRun,
  CausalMetadata,
  Id,
  PlatformEventPayload,
  StoredPlatformEvent,
  ThreadMessage,
} from "./types.js";
import type {
  AgentRuntime,
  RuntimeEvent,
  SendAgentMessageInput,
} from "../runtime/runtime.js";

export interface MultiAgentPlatformOptions {
  agents: AgentDefinition[];
  runtimes: AgentRuntime[];
  eventStore: EventStore;
  contextCompiler: ContextCompiler;
  maxA2ADepth?: number;
  maxAgentRunsPerChain?: number;
}

export interface PostUserMessageInput {
  content: string;
  threadId?: Id;
  title?: string;
  humanId?: string;
}

export interface PostUserMessageResult {
  threadId: Id;
  rootRunId: Id;
}

type PlatformEventListener = (event: StoredPlatformEvent) => void;

interface ActiveRun {
  run: AgentRun;
  controller: AbortController;
  runtime: AgentRuntime;
}

export class MultiAgentPlatform {
  private readonly agents = new Map<Id, AgentDefinition>();
  private readonly runtimes = new Map<string, AgentRuntime>();
  private readonly listeners = new Set<PlatformEventListener>();
  private readonly queue: AgentRun[] = [];
  private readonly messages = new Map<Id, ThreadMessage>();
  private readonly threadMessages = new Map<Id, ThreadMessage[]>();
  private readonly activeRuns = new Map<Id, ActiveRun>();
  private readonly acceptedIdempotencyKeys = new Set<string>();
  private readonly cancelledGroups = new Set<Id>();
  private readonly groupRunCounts = new Map<Id, number>();
  private readonly maxA2ADepth: number;
  private readonly maxAgentRunsPerChain: number;
  private hydrated = false;
  private drainPromise: Promise<void> | undefined;

  public constructor(private readonly options: MultiAgentPlatformOptions) {
    for (const agent of options.agents) {
      if (this.agents.has(agent.id)) {
        throw new Error(`Duplicate agent id: ${agent.id}`);
      }
      this.agents.set(agent.id, agent);
    }

    for (const runtime of options.runtimes) {
      if (this.runtimes.has(runtime.id)) {
        throw new Error(`Duplicate runtime id: ${runtime.id}`);
      }
      this.runtimes.set(runtime.id, runtime);
    }

    for (const agent of options.agents) {
      if (!this.runtimes.has(agent.runtimeId)) {
        throw new Error(
          `Agent ${agent.id} refers to unknown runtime ${agent.runtimeId}`,
        );
      }
    }

    this.maxA2ADepth = options.maxA2ADepth ?? 4;
    this.maxAgentRunsPerChain = options.maxAgentRunsPerChain ?? 8;
  }

  public subscribe(listener: PlatformEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async postUserMessage(
    input: PostUserMessageInput,
  ): Promise<PostUserMessageResult> {
    await this.ensureHydrated();

    const targetAgentId = this.resolveMention(input.content);
    if (!targetAgentId) {
      throw new Error(
        `Message must mention one registered agent: ${[...this.agents.keys()]
          .map((id) => `@${id}`)
          .join(", ")}`,
      );
    }

    const threadId = input.threadId ?? createId("thread");
    if (!input.threadId) {
      const title = input.title ?? summarizeTitle(input.content);
      await this.record({
        type: "thread.created",
        thread: { id: threadId, title, createdAt: now() },
      });
    }

    const rootRunId = createId("run");
    const causal: CausalMetadata = {
      rootRunId,
      depth: 0,
      abortGroupId: rootRunId,
    };
    const message: ThreadMessage = {
      id: createId("msg"),
      threadId,
      sender: { type: "human", id: input.humanId ?? "operator" },
      recipientAgentId: targetAgentId,
      content: input.content,
      createdAt: now(),
      causal,
    };

    await this.addMessage(message);
    this.groupRunCounts.set(rootRunId, 1);
    await this.enqueueRun({
      id: rootRunId,
      threadId,
      agentId: targetAgentId,
      incomingMessageId: message.id,
      status: "queued",
      causal,
      createdAt: now(),
    });
    await this.drain();

    return { threadId, rootRunId };
  }

  public async cancelGroup(rootRunId: Id, reason = "Cancelled by operator"): Promise<void> {
    await this.ensureHydrated();
    this.cancelledGroups.add(rootRunId);

    const cancellations: Promise<void>[] = [];
    for (const active of this.activeRuns.values()) {
      if (active.run.causal.rootRunId !== rootRunId) {
        continue;
      }
      active.controller.abort(reason);
      cancellations.push(active.runtime.cancel(active.run.id));
    }
    await Promise.allSettled(cancellations);
  }

  public async getThreadMessages(threadId: Id): Promise<ThreadMessage[]> {
    await this.ensureHydrated();
    return structuredClone(this.threadMessages.get(threadId) ?? []);
  }

  public async getEvents(): Promise<StoredPlatformEvent[]> {
    await this.ensureHydrated();
    return this.options.eventStore.readAll();
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) {
      return;
    }

    const events = await this.options.eventStore.readAll();
    for (const event of events) {
      if (event.type === "message.created") {
        this.cacheMessage(event.message);
      } else if (event.type === "routing.accepted") {
        this.acceptedIdempotencyKeys.add(event.idempotencyKey);
      }
    }
    this.hydrated = true;
  }

  private async drain(): Promise<void> {
    if (this.drainPromise) {
      return this.drainPromise;
    }

    this.drainPromise = this.processQueue().finally(() => {
      this.drainPromise = undefined;
    });
    return this.drainPromise;
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const run = this.queue.shift();
      if (!run) {
        return;
      }
      await this.executeRun(run);
    }
  }

  private async executeRun(run: AgentRun): Promise<void> {
    const agent = this.agents.get(run.agentId);
    const incoming = this.messages.get(run.incomingMessageId);
    if (!agent || !incoming) {
      throw new Error(`Corrupt queued run: ${run.id}`);
    }

    if (this.cancelledGroups.has(run.causal.rootRunId)) {
      await this.recordCancelled(run, "Causal chain was cancelled before execution");
      return;
    }

    const runtime = this.runtimes.get(agent.runtimeId);
    if (!runtime) {
      throw new Error(`Unknown runtime: ${agent.runtimeId}`);
    }

    const context = await this.options.contextCompiler.compile({
      agent,
      incoming,
      threadMessages: this.threadMessages.get(run.threadId) ?? [],
    });
    const controller = new AbortController();
    this.activeRuns.set(run.id, { run, controller, runtime });

    await this.record({
      type: "run.started",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
    });

    try {
      const result = await runtime.execute({
        runId: run.id,
        threadId: run.threadId,
        agent,
        incoming,
        context,
        signal: controller.signal,
        emit: (event) => this.recordRuntimeEvent(run, event),
        sendMessage: (message) => this.acceptAgentMessage(run, message),
      });

      if (controller.signal.aborted || this.cancelledGroups.has(run.causal.rootRunId)) {
        await this.recordCancelled(run, abortReason(controller.signal));
        return;
      }

      await this.addMessage({
        id: createId("msg"),
        threadId: run.threadId,
        sender: { type: "agent", id: run.agentId },
        content: result.output,
        createdAt: now(),
        causal: run.causal,
      });
      await this.record({
        type: "run.completed",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        output: result.output,
      });
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        await this.recordCancelled(run, abortReason(controller.signal));
      } else {
        await this.record({
          type: "run.failed",
          runId: run.id,
          threadId: run.threadId,
          agentId: run.agentId,
          error: errorMessage(error),
        });
      }
    } finally {
      this.activeRuns.delete(run.id);
    }
  }

  private async acceptAgentMessage(
    sourceRun: AgentRun,
    input: SendAgentMessageInput,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const reject = async (reason: string): Promise<{ accepted: false; reason: string }> => {
      await this.record({
        type: "routing.rejected",
        runId: sourceRun.id,
        targetAgentId: input.to,
        reason,
        idempotencyKey: input.idempotencyKey,
      });
      return { accepted: false, reason };
    };

    if (!this.agents.has(input.to)) {
      return reject(`Unknown target agent: ${input.to}`);
    }
    if (this.cancelledGroups.has(sourceRun.causal.rootRunId)) {
      return reject("Causal chain is cancelled");
    }
    if (this.acceptedIdempotencyKeys.has(input.idempotencyKey)) {
      return reject("Duplicate idempotency key");
    }

    const depth = sourceRun.causal.depth + 1;
    if (depth > this.maxA2ADepth) {
      return reject(`A2A depth limit exceeded (${this.maxA2ADepth})`);
    }

    const currentRunCount = this.groupRunCounts.get(sourceRun.causal.rootRunId) ?? 1;
    if (currentRunCount >= this.maxAgentRunsPerChain) {
      return reject(`Agent run limit exceeded (${this.maxAgentRunsPerChain})`);
    }

    this.acceptedIdempotencyKeys.add(input.idempotencyKey);
    this.groupRunCounts.set(sourceRun.causal.rootRunId, currentRunCount + 1);
    await this.record({
      type: "routing.accepted",
      runId: sourceRun.id,
      targetAgentId: input.to,
      idempotencyKey: input.idempotencyKey,
    });

    const causal: CausalMetadata = {
      rootRunId: sourceRun.causal.rootRunId,
      parentRunId: sourceRun.id,
      depth,
      abortGroupId: sourceRun.causal.abortGroupId,
    };
    const message: ThreadMessage = {
      id: createId("msg"),
      threadId: sourceRun.threadId,
      sender: { type: "agent", id: sourceRun.agentId },
      recipientAgentId: input.to,
      content: input.content,
      createdAt: now(),
      causal,
      ...(input.intent ? { intent: input.intent } : {}),
    };
    await this.addMessage(message);
    await this.enqueueRun({
      id: createId("run"),
      threadId: sourceRun.threadId,
      agentId: input.to,
      incomingMessageId: message.id,
      status: "queued",
      causal,
      createdAt: now(),
    });
    return { accepted: true };
  }

  private async enqueueRun(run: AgentRun): Promise<void> {
    this.queue.push(run);
    await this.record({ type: "run.queued", run });
  }

  private async addMessage(message: ThreadMessage): Promise<void> {
    this.cacheMessage(message);
    await this.record({ type: "message.created", message });
  }

  private cacheMessage(message: ThreadMessage): void {
    if (this.messages.has(message.id)) {
      return;
    }
    this.messages.set(message.id, message);
    const messages = this.threadMessages.get(message.threadId) ?? [];
    messages.push(message);
    this.threadMessages.set(message.threadId, messages);
  }

  private async recordRuntimeEvent(run: AgentRun, event: RuntimeEvent): Promise<void> {
    if (event.type === "text_delta") {
      await this.record({
        type: "run.delta",
        runId: run.id,
        threadId: run.threadId,
        text: event.text,
      });
      return;
    }

    await this.record({
      type: "run.tool",
      runId: run.id,
      threadId: run.threadId,
      phase: event.type === "tool_start" ? "start" : "end",
      toolName: event.toolName,
      ...(event.type === "tool_end" ? { isError: event.isError } : {}),
    });
  }

  private async recordCancelled(run: AgentRun, reason: string): Promise<void> {
    await this.record({
      type: "run.cancelled",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      reason,
    });
  }

  private async record(payload: PlatformEventPayload): Promise<void> {
    const event = {
      ...payload,
      eventId: createId("evt"),
      recordedAt: now(),
    } as StoredPlatformEvent;
    await this.options.eventStore.append(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private resolveMention(content: string): Id | undefined {
    const mentions = content.matchAll(/@([a-zA-Z][\w-]*)/g);
    for (const match of mentions) {
      const agentId = match[1];
      if (agentId && this.agents.has(agentId)) {
        return agentId;
      }
    }
    return undefined;
  }
}

function now(): string {
  return new Date().toISOString();
}

function summarizeTitle(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason ?? "Run aborted");
}
