import { resolve } from "node:path";
import { createId } from "./ids.js";
import type { ContextCompiler } from "./context-compiler.js";
import type { EventStore } from "./event-store.js";
import { parseAgentMentions, parseUserMentions } from "./mentions.js";
import type {
  AccessMode,
  AgentDefinition,
  AgentRun,
  CausalMetadata,
  Id,
  PlatformEventPayload,
  StoredPlatformEvent,
  Thread,
  ThreadMessage,
} from "./types.js";
import type {
  AgentRuntime,
  PostAgentMessageInput,
  PostAgentMessageResult,
  RuntimeEvent,
} from "../runtime/runtime.js";

export interface MultiAgentPlatformOptions {
  agents: AgentDefinition[];
  defaultAgentId: Id;
  runtimes: Map<Id, AgentRuntime>;
  eventStore: EventStore;
  contextCompiler: ContextCompiler;
  maxA2ADepth?: number;
  maxAgentRunsPerChain?: number;
  maxMentionTargets?: number;
  maxPingPongHops?: number;
  maxParallelReadRuns?: number;
}

export interface PostUserMessageInput {
  content: string;
  threadId?: Id;
  title?: string;
  humanId?: string;
  workingDirectory?: string;
}

export interface PostUserMessageResult {
  threadId: Id;
  chainId: Id;
}

export interface StartedUserMessage extends PostUserMessageResult {
  completion: Promise<void>;
}

type PlatformEventListener = (event: StoredPlatformEvent) => void;

interface ActiveRun {
  run: AgentRun;
  controller: AbortController;
  runtime: AgentRuntime;
  workspaceKey: string;
  context: Awaited<ReturnType<ContextCompiler["compile"]>>;
}

interface ChainWaiter {
  resolve(): void;
}

export class MultiAgentPlatform {
  private readonly agents = new Map<Id, AgentDefinition>();
  private readonly runtimes = new Map<Id, AgentRuntime>();
  private readonly listeners = new Set<PlatformEventListener>();
  private readonly queue: AgentRun[] = [];
  private readonly threads = new Map<Id, Thread>();
  private readonly messages = new Map<Id, ThreadMessage>();
  private readonly threadMessages = new Map<Id, ThreadMessage[]>();
  private readonly runs = new Map<Id, AgentRun>();
  private readonly runStatuses = new Map<Id, AgentRun["status"]>();
  private readonly activeRuns = new Map<Id, ActiveRun>();
  private readonly acceptedIdempotencyKeys = new Set<string>();
  private readonly cancelledChains = new Set<Id>();
  private readonly groupRunCounts = new Map<Id, number>();
  private readonly chainPendingCounts = new Map<Id, number>();
  private readonly chainWaiters = new Map<Id, Set<ChainWaiter>>();
  private readonly deliveryCursors = new Map<string, Id>();
  private readonly latestSuccessfulAgentByThread = new Map<Id, Id>();
  private readonly maxA2ADepth: number;
  private readonly maxAgentRunsPerChain: number;
  private readonly maxMentionTargets: number;
  private readonly maxPingPongHops: number;
  private readonly maxParallelReadRuns: number;
  private defaultAgentId: Id;
  private hydrated = false;
  private hydratePromise: Promise<void> | undefined;
  private schedulerPromise: Promise<void> | undefined;
  private schedulerWake: (() => void) | undefined;
  private rosterUpdateInProgress = false;

  public constructor(private readonly options: MultiAgentPlatformOptions) {
    this.defaultAgentId = options.defaultAgentId;
    this.installRoster(options.agents, options.runtimes, options.defaultAgentId);
    this.maxA2ADepth = options.maxA2ADepth ?? 4;
    this.maxAgentRunsPerChain = options.maxAgentRunsPerChain ?? 8;
    this.maxMentionTargets = options.maxMentionTargets ?? 2;
    this.maxPingPongHops = options.maxPingPongHops ?? 4;
    this.maxParallelReadRuns = options.maxParallelReadRuns ?? 4;
  }

  public async initialize(): Promise<void> {
    await this.ensureHydrated();
  }

  public subscribe(listener: PlatformEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public getRoster(): AgentDefinition[] {
    return [...this.agents.values()].map((agent) => structuredClone(agent));
  }

  public getDefaultAgentId(): Id {
    return this.defaultAgentId;
  }

  public getRuntime(agentId: Id): AgentRuntime | undefined {
    return this.runtimes.get(agentId);
  }

  public hasLiveAgentRun(agentId: Id): boolean {
    return (
      this.queue.some((run) => run.agentId === agentId) ||
      [...this.activeRuns.values()].some((active) => active.run.agentId === agentId)
    );
  }

  public assertRosterChangeAllowed(nextAgents: AgentDefinition[]): void {
    const next = new Map(nextAgents.map((agent) => [agent.id, agent]));
    for (const current of this.agents.values()) {
      if (!this.hasLiveAgentRun(current.id)) continue;
      const replacement = next.get(current.id);
      if (!replacement || JSON.stringify(replacement) !== JSON.stringify(current)) {
        throw new Error(`Agent @${current.id} has an active or queued run`);
      }
    }
  }

  public beginRosterUpdate(nextAgents: AgentDefinition[]): void {
    if (this.rosterUpdateInProgress) throw new Error("An Agent catalog update is already in progress");
    this.assertRosterChangeAllowed(nextAgents);
    this.rosterUpdateInProgress = true;
  }

  public abortRosterUpdate(): void {
    this.rosterUpdateInProgress = false;
  }

  public async replaceRoster(
    agents: AgentDefinition[],
    runtimes: Map<Id, AgentRuntime>,
    defaultAgentId: Id,
  ): Promise<void> {
    if (!this.rosterUpdateInProgress) this.beginRosterUpdate(agents);
    else this.assertRosterChangeAllowed(agents);
    const previous = [...this.runtimes.values()];
    try {
      this.installRoster(agents, runtimes, defaultAgentId);
    } finally {
      this.rosterUpdateInProgress = false;
    }
    await Promise.allSettled(
      previous
        .filter((runtime) => ![...runtimes.values()].includes(runtime))
        .map((runtime) => runtime.dispose?.()),
    );
    this.wakeScheduler();
  }

  public async postUserMessage(
    input: PostUserMessageInput,
  ): Promise<PostUserMessageResult> {
    const { completion, ...result } = await this.startUserMessage(input);
    await completion;
    return result;
  }

  public async startUserMessage(
    input: PostUserMessageInput,
  ): Promise<StartedUserMessage> {
    await this.ensureHydrated();
    if (this.rosterUpdateInProgress) throw new Error("The Agent catalog is being updated; retry the message");
    const content = input.content.trim();
    if (!content) throw new Error("Message content cannot be empty");

    const threadId = input.threadId ?? createId("thread");
    if (input.threadId && !this.threads.has(input.threadId)) {
      throw new Error(`Unknown thread: ${input.threadId}`);
    }
    const parsed = parseUserMentions(content, [...this.agents.values()], this.maxMentionTargets);
    if (parsed.unknown.length > 0) {
      throw new Error(`Unknown Agent handle: @${parsed.unknown.join(", @")}`);
    }
    if (parsed.overflow) {
      throw new Error(`A message can target at most ${this.maxMentionTargets} Agents`);
    }
    const targets = parsed.targets.length > 0
      ? parsed.targets
      : [this.resolveFallbackAgent(threadId)].filter((id): id is string => Boolean(id));
    if (targets.length === 0) throw new Error("No enabled and available Agent can receive this message");
    for (const target of targets) this.assertRoutable(target);

    if (!input.threadId) {
      const thread: Thread = {
        id: threadId,
        title: input.title ?? summarizeTitle(content),
        createdAt: now(),
        ...(input.workingDirectory ? { workingDirectory: input.workingDirectory } : {}),
      };
      this.cacheThread(thread);
      await this.record({ type: "thread.created", thread });
    }

    const chainId = createId("chain");
    const causal: CausalMetadata = { chainId, depth: 0 };
    const message: ThreadMessage = {
      id: createId("msg"),
      threadId,
      sender: { type: "human", id: input.humanId ?? "operator" },
      kind: "chat",
      mentions: targets,
      content,
      createdAt: now(),
      causal,
    };
    await this.addMessage(message);

    for (const target of targets) {
      const agent = this.agents.get(target);
      if (!agent) continue;
      await this.enqueueRun({
        id: createId("run"),
        threadId,
        agentId: target,
        incomingMessageId: message.id,
        status: "queued",
        accessMode: agent.accessMode,
        causal,
        createdAt: now(),
      });
    }
    this.startScheduler();
    const completion = this.waitForChain(chainId);
    return { threadId, chainId, completion };
  }

  public async cancelGroup(chainId: Id, reason = "Cancelled by operator"): Promise<void> {
    await this.ensureHydrated();
    this.cancelledChains.add(chainId);

    const queued = this.queue.filter((run) => run.causal.chainId === chainId);
    for (const run of queued) {
      const index = this.queue.findIndex((candidate) => candidate.id === run.id);
      if (index >= 0) this.queue.splice(index, 1);
      await this.recordCancelled(run, reason);
      this.finishPendingRun(run);
    }

    const cancellations: Promise<void>[] = [];
    for (const active of this.activeRuns.values()) {
      if (active.run.causal.chainId !== chainId) continue;
      active.controller.abort(reason);
      cancellations.push(active.runtime.cancel(active.run.id));
    }
    await Promise.allSettled(cancellations);
    this.wakeScheduler();
  }

  public async getThreadMessages(threadId: Id): Promise<ThreadMessage[]> {
    await this.ensureHydrated();
    return structuredClone(this.threadMessages.get(threadId) ?? []);
  }

  public async getEvents(): Promise<StoredPlatformEvent[]> {
    await this.ensureHydrated();
    return this.normalizeEvents(await this.options.eventStore.readAll());
  }

  private installRoster(
    agents: AgentDefinition[],
    runtimes: Map<Id, AgentRuntime>,
    defaultAgentId: Id,
  ): void {
    const nextAgents = new Map<Id, AgentDefinition>();
    for (const agent of agents) {
      if (nextAgents.has(agent.id)) throw new Error(`Duplicate Agent id: ${agent.id}`);
      nextAgents.set(agent.id, structuredClone(agent));
    }
    const defaultAgent = nextAgents.get(defaultAgentId);
    if (!defaultAgent?.enabled) throw new Error("Default Agent must exist and be enabled");
    for (const [agentId, runtime] of runtimes) {
      if (!nextAgents.has(agentId)) throw new Error(`Runtime refers to unknown Agent: ${agentId}`);
      if (runtime.id !== agentId) throw new Error(`Runtime id must equal Agent id: ${agentId}`);
    }
    this.agents.clear();
    for (const [id, agent] of nextAgents) this.agents.set(id, agent);
    this.runtimes.clear();
    for (const [id, runtime] of runtimes) this.runtimes.set(id, runtime);
    this.defaultAgentId = defaultAgentId;
  }

  private async ensureHydrated(): Promise<void> {
    if (this.hydrated) return;
    if (this.hydratePromise) return this.hydratePromise;
    this.hydratePromise = this.hydrate();
    return this.hydratePromise;
  }

  private async hydrate(): Promise<void> {
    const events = this.normalizeEvents(await this.options.eventStore.readAll());
    for (const event of events) {
      if (event.type === "thread.created") {
        this.cacheThread(event.thread);
      } else if (event.type === "message.created") {
        this.cacheMessage(event.message);
      } else if (event.type === "run.queued") {
        this.runs.set(event.run.id, event.run);
        this.runStatuses.set(event.run.id, "queued");
        this.groupRunCounts.set(
          event.run.causal.chainId,
          (this.groupRunCounts.get(event.run.causal.chainId) ?? 0) + 1,
        );
      } else if (event.type === "run.started") {
        this.runStatuses.set(event.runId, "running");
      } else if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled" ||
        event.type === "run.interrupted"
      ) {
        this.runStatuses.set(event.runId, terminalStatus(event.type));
        if (event.type === "run.completed") {
          this.latestSuccessfulAgentByThread.set(event.threadId, event.agentId);
        }
      } else if (event.type === "routing.accepted") {
        this.acceptedIdempotencyKeys.add(event.idempotencyKey);
      } else if (event.type === "context.delivered") {
        this.deliveryCursors.set(cursorKey(event.threadId, event.agentId), event.messageId);
      }
    }
    this.hydrated = true;

    const interrupted: AgentRun[] = [];
    for (const run of this.runs.values()) {
      const status = this.runStatuses.get(run.id);
      if (status === "queued") {
        if (this.isRoutable(run.agentId)) {
          this.queue.push(run);
          this.incrementPending(run.causal.chainId);
        } else {
          interrupted.push(run);
        }
      } else if (status === "running") {
        interrupted.push(run);
      }
    }
    for (const run of interrupted) {
      await this.recordInterrupted(run, "The previous server process stopped before this run reached a terminal state");
    }
    if (this.queue.length > 0) this.startScheduler();
  }

  private startScheduler(): void {
    if (this.schedulerPromise) {
      this.wakeScheduler();
      return;
    }
    this.schedulerPromise = this.schedulerLoop().finally(() => {
      this.schedulerPromise = undefined;
      if (this.queue.length > 0 || this.activeRuns.size > 0) this.startScheduler();
    });
  }

  private async schedulerLoop(): Promise<void> {
    while (this.queue.length > 0 || this.activeRuns.size > 0) {
      let started = false;
      for (let index = 0; index < this.queue.length; ) {
        const run = this.queue[index];
        if (!run || !this.isEligible(run)) {
          index++;
          continue;
        }
        this.queue.splice(index, 1);
        const active = await this.reserveRun(run);
        if (!active) {
          this.finishPendingRun(run);
          continue;
        }
        started = true;
        void this.executeRun(active).finally(() => {
          this.activeRuns.delete(active.run.id);
          this.finishPendingRun(active.run);
          this.wakeScheduler();
        });
      }
      if (!started && (this.queue.length > 0 || this.activeRuns.size > 0)) {
        await new Promise<void>((resolve) => {
          this.schedulerWake = resolve;
        });
      }
    }
  }

  private isEligible(run: AgentRun): boolean {
    if (!this.isRoutable(run.agentId)) return true;
    if ([...this.activeRuns.values()].some((active) => active.run.agentId === run.agentId)) {
      return false;
    }
    const workspaceKey = this.workspaceKey(run);
    const sameWorkspace = [...this.activeRuns.values()].filter(
      (active) => active.workspaceKey === workspaceKey,
    );
    if (run.accessMode === "read-only") {
      const activeReaders = [...this.activeRuns.values()].filter(
        (active) => active.run.accessMode === "read-only",
      ).length;
      return (
        activeReaders < this.maxParallelReadRuns &&
        !sameWorkspace.some((active) => active.run.accessMode !== "read-only")
      );
    }
    return sameWorkspace.length === 0;
  }

  private async reserveRun(run: AgentRun): Promise<ActiveRun | undefined> {
    const agent = this.agents.get(run.agentId);
    const incoming = this.messages.get(run.incomingMessageId);
    const runtime = this.runtimes.get(run.agentId);
    if (!agent || !incoming || !runtime || !this.isRoutable(run.agentId)) {
      await this.record({
        type: "run.failed",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        error: `Agent @${run.agentId} is unavailable`,
      });
      this.runStatuses.set(run.id, "failed");
      return undefined;
    }
    if (this.cancelledChains.has(run.causal.chainId)) {
      await this.recordCancelled(run, "Collaboration chain was cancelled before execution");
      return undefined;
    }
    const delivered = this.deliveryCursors.get(cursorKey(run.threadId, run.agentId));
    const context = await this.options.contextCompiler.compile({
      agent,
      incoming,
      threadMessages: this.threadMessages.get(run.threadId) ?? [],
      ...(delivered ? { lastDeliveredMessageId: delivered } : {}),
    });
    const active: ActiveRun = {
      run,
      controller: new AbortController(),
      runtime,
      workspaceKey: this.workspaceKey(run),
      context,
    };
    this.activeRuns.set(run.id, active);
    return active;
  }

  private async executeRun(active: ActiveRun): Promise<void> {
    const { run, runtime, controller, context } = active;
    const agent = this.agents.get(run.agentId);
    const incoming = this.messages.get(run.incomingMessageId);
    if (!agent || !incoming) return;
    this.runStatuses.set(run.id, "running");
    await this.record({
      type: "run.started",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
    });

    try {
      const workingDirectory = this.threads.get(run.threadId)?.workingDirectory;
      const result = await runtime.execute({
        runId: run.id,
        threadId: run.threadId,
        ...(workingDirectory ? { workingDirectory } : {}),
        agent,
        roster: [...this.agents.values()].filter((candidate) => candidate.enabled),
        incoming,
        context,
        signal: controller.signal,
        emit: (event) => this.recordRuntimeEvent(active, event),
        postMessage: (message) => this.acceptAgentMessage(run, message),
      });

      if (controller.signal.aborted || this.cancelledChains.has(run.causal.chainId)) {
        await this.recordCancelled(run, abortReason(controller.signal));
        return;
      }
      await this.addMessage({
        id: createId("msg"),
        threadId: run.threadId,
        sender: { type: "agent", id: run.agentId },
        kind: "chat",
        mentions: [],
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
      this.latestSuccessfulAgentByThread.set(run.threadId, run.agentId);
      this.runStatuses.set(run.id, "completed");
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
        this.runStatuses.set(run.id, "failed");
      }
    }
  }

  private async acceptAgentMessage(
    sourceRun: AgentRun,
    input: PostAgentMessageInput,
  ): Promise<PostAgentMessageResult> {
    const scopedKey = `${sourceRun.id}:${input.idempotencyKey}`;
    const reject = async (
      reason: string,
      targetAgentId?: Id,
      messageId?: Id,
    ): Promise<PostAgentMessageResult> => {
      await this.record({
        type: "routing.rejected",
        runId: sourceRun.id,
        threadId: sourceRun.threadId,
        ...(targetAgentId ? { targetAgentId } : {}),
        reason,
        idempotencyKey: scopedKey,
      });
      return {
        accepted: false,
        targets: [],
        reason,
        ...(messageId ? { messageId } : {}),
      };
    };

    const content = input.content.trim();
    if (this.rosterUpdateInProgress) return reject("The Agent catalog is being updated; retry after it completes");
    if (!content || content.length > 20_000) {
      return reject("Collaboration message must contain 1-20,000 characters");
    }
    if (!input.idempotencyKey.trim()) return reject("idempotencyKey is required");
    if (this.acceptedIdempotencyKeys.has(scopedKey)) {
      return reject("Duplicate idempotency key");
    }
    this.acceptedIdempotencyKeys.add(scopedKey);

    const parsed = parseAgentMentions(content, [...this.agents.values()], this.maxMentionTargets);
    const targets = parsed.targets.filter((target) => target !== sourceRun.agentId);
    const depth = sourceRun.causal.depth + 1;
    const message: ThreadMessage = {
      id: createId("msg"),
      threadId: sourceRun.threadId,
      sender: { type: "agent", id: sourceRun.agentId },
      kind: "collaboration",
      mentions: targets,
      content,
      createdAt: now(),
      causal: {
        chainId: sourceRun.causal.chainId,
        parentRunId: sourceRun.id,
        depth,
      },
      ...(input.intent ? { intent: input.intent } : {}),
    };
    await this.addMessage(message);

    if (parsed.unknown.length > 0) {
      return reject(`Unknown Agent handle: @${parsed.unknown.join(", @")}`, undefined, message.id);
    }
    if (parsed.overflow) {
      return reject(
        `A collaboration message can target at most ${this.maxMentionTargets} Agents`,
        undefined,
        message.id,
      );
    }
    if (targets.length === 0) {
      return { accepted: true, targets: [], messageId: message.id };
    }
    if (this.cancelledChains.has(sourceRun.causal.chainId)) {
      return reject("Collaboration chain is cancelled", undefined, message.id);
    }
    if (depth > this.maxA2ADepth) {
      return reject(`A2A depth limit exceeded (${this.maxA2ADepth})`, undefined, message.id);
    }
    const currentRunCount = this.groupRunCounts.get(sourceRun.causal.chainId) ?? 1;
    if (currentRunCount + targets.length > this.maxAgentRunsPerChain) {
      return reject(`Agent run limit exceeded (${this.maxAgentRunsPerChain})`, undefined, message.id);
    }
    for (const target of targets) {
      if (!this.isRoutable(target)) {
        return reject(`Agent @${target} is disabled or unavailable`, target, message.id);
      }
      if (this.projectedPingPongHops(sourceRun, target) > this.maxPingPongHops) {
        return reject(
          `Ping-pong limit exceeded for @${sourceRun.agentId} and @${target}`,
          target,
          message.id,
        );
      }
    }

    for (const target of targets) {
      await this.record({
        type: "routing.accepted",
        runId: sourceRun.id,
        threadId: sourceRun.threadId,
        messageId: message.id,
        targetAgentId: target,
        idempotencyKey: scopedKey,
      });
      const agent = this.agents.get(target);
      if (!agent) continue;
      await this.enqueueRun({
        id: createId("run"),
        threadId: sourceRun.threadId,
        agentId: target,
        incomingMessageId: message.id,
        status: "queued",
        accessMode: agent.accessMode,
        causal: message.causal as CausalMetadata,
        createdAt: now(),
      });
    }
    this.startScheduler();
    return { accepted: true, targets, messageId: message.id };
  }

  private projectedPingPongHops(sourceRun: AgentRun, targetAgentId: Id): number {
    const pair = unorderedPair(sourceRun.agentId, targetAgentId);
    let count = 1;
    let current = sourceRun;
    while (current.causal.parentRunId) {
      const parent = this.runs.get(current.causal.parentRunId);
      if (!parent || unorderedPair(parent.agentId, current.agentId) !== pair) break;
      count++;
      current = parent;
    }
    return count;
  }

  private resolveFallbackAgent(threadId: Id): Id | undefined {
    const latest = this.latestSuccessfulAgentByThread.get(threadId);
    if (latest && this.isRoutable(latest)) return latest;
    if (this.isRoutable(this.defaultAgentId)) return this.defaultAgentId;
    return [...this.agents.keys()].find((id) => this.isRoutable(id));
  }

  private assertRoutable(agentId: Id): void {
    const agent = this.agents.get(agentId);
    const runtime = this.runtimes.get(agentId);
    if (!agent) throw new Error(`Unknown Agent: @${agentId}`);
    if (!agent.enabled) throw new Error(`Agent @${agentId} is disabled`);
    if (!runtime?.availability.available) {
      throw new Error(`Agent @${agentId} is unavailable: ${runtime?.availability.detail ?? "runtime unavailable"}`);
    }
  }

  private isRoutable(agentId: Id): boolean {
    const agent = this.agents.get(agentId);
    const runtime = this.runtimes.get(agentId);
    return Boolean(agent?.enabled && runtime?.availability.available);
  }

  private async enqueueRun(run: AgentRun): Promise<void> {
    this.queue.push(run);
    this.runs.set(run.id, run);
    this.runStatuses.set(run.id, "queued");
    this.groupRunCounts.set(
      run.causal.chainId,
      (this.groupRunCounts.get(run.causal.chainId) ?? 0) + 1,
    );
    this.incrementPending(run.causal.chainId);
    await this.record({ type: "run.queued", run });
    this.wakeScheduler();
  }

  private async addMessage(message: ThreadMessage): Promise<void> {
    this.cacheMessage(message);
    await this.record({ type: "message.created", message });
  }

  private cacheMessage(message: ThreadMessage): void {
    if (this.messages.has(message.id)) return;
    this.messages.set(message.id, message);
    const messages = this.threadMessages.get(message.threadId) ?? [];
    messages.push(message);
    this.threadMessages.set(message.threadId, messages);
  }

  private cacheThread(thread: Thread): void {
    if (!this.threads.has(thread.id)) this.threads.set(thread.id, thread);
  }

  private async recordRuntimeEvent(active: ActiveRun, event: RuntimeEvent): Promise<void> {
    const { run, context } = active;
    if (event.type === "text_delta") {
      await this.record({
        type: "run.delta",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        text: event.text,
      });
      return;
    }
    if (event.type === "session") {
      await this.record({
        type: "run.session",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        runtimeKind: event.runtimeKind,
        resumed: event.resumed,
      });
      return;
    }
    if (event.type === "prompt_accepted") {
      const key = cursorKey(run.threadId, run.agentId);
      if (this.deliveryCursors.get(key) === context.deliveryCursor) return;
      this.deliveryCursors.set(key, context.deliveryCursor);
      await this.record({
        type: "context.delivered",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        messageId: context.deliveryCursor,
        truncated: context.truncated,
      });
      return;
    }
    if (event.type === "thinking_delta") {
      await this.record({
        type: "run.thinking",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        text: event.text,
      });
      return;
    }
    if (event.type === "output_reset") {
      await this.record({
        type: "run.reset",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        reason: event.reason,
      });
      return;
    }
    if (event.type === "lifecycle") {
      await this.record({
        type: "run.lifecycle",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        phase: event.phase,
        ...(event.detail ? { detail: event.detail } : {}),
      });
      return;
    }
    if (event.type === "diagnostic") {
      await this.record({
        type: "run.diagnostic",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        source: event.source,
        message: event.message,
      });
      return;
    }
    if (event.type === "usage") {
      const { type: _type, ...usage } = event;
      await this.record({
        type: "run.usage",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        ...usage,
      });
      return;
    }
    await this.record({
      type: "run.tool",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      phase: event.type === "tool_start" ? "start" : "end",
      toolName: event.toolName,
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.type === "tool_start" && event.args ? { args: event.args } : {}),
      ...(event.type === "tool_end"
        ? {
            isError: event.isError,
            ...(event.resultSummary ? { resultSummary: event.resultSummary } : {}),
          }
        : {}),
    });
  }

  private async recordCancelled(run: AgentRun, reason: string): Promise<void> {
    if (isTerminal(this.runStatuses.get(run.id))) return;
    await this.record({
      type: "run.cancelled",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      reason,
    });
    this.runStatuses.set(run.id, "cancelled");
  }

  private async recordInterrupted(run: AgentRun, reason: string): Promise<void> {
    await this.record({
      type: "run.interrupted",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      reason,
    });
    this.runStatuses.set(run.id, "interrupted");
  }

  private async record(payload: PlatformEventPayload): Promise<void> {
    const event = {
      ...payload,
      eventId: createId("evt"),
      recordedAt: now(),
    } as StoredPlatformEvent;
    await this.options.eventStore.append(event);
    for (const listener of this.listeners) listener(event);
  }

  private incrementPending(chainId: Id): void {
    this.chainPendingCounts.set(chainId, (this.chainPendingCounts.get(chainId) ?? 0) + 1);
  }

  private finishPendingRun(run: AgentRun): void {
    const chainId = run.causal.chainId;
    const next = Math.max(0, (this.chainPendingCounts.get(chainId) ?? 1) - 1);
    if (next > 0) {
      this.chainPendingCounts.set(chainId, next);
      return;
    }
    this.chainPendingCounts.delete(chainId);
    const waiters = this.chainWaiters.get(chainId);
    this.chainWaiters.delete(chainId);
    for (const waiter of waiters ?? []) waiter.resolve();
  }

  private waitForChain(chainId: Id): Promise<void> {
    if ((this.chainPendingCounts.get(chainId) ?? 0) === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const waiters = this.chainWaiters.get(chainId) ?? new Set<ChainWaiter>();
      waiters.add({ resolve });
      this.chainWaiters.set(chainId, waiters);
    });
  }

  private workspaceKey(run: AgentRun): string {
    const directory = this.threads.get(run.threadId)?.workingDirectory;
    return directory ? resolve(directory) : "__default_workspace__";
  }

  private wakeScheduler(): void {
    const wake = this.schedulerWake;
    this.schedulerWake = undefined;
    wake?.();
  }

  private normalizeEvents(events: StoredPlatformEvent[]): StoredPlatformEvent[] {
    const runIndex = new Map<string, AgentRun>();
    for (const raw of events) {
      if (raw.type !== "run.queued") continue;
      const run = normalizeRun(raw.run as unknown as LegacyRun, this.agents);
      runIndex.set(run.id, run);
    }
    return events.map((raw) => normalizeEvent(raw, runIndex));
  }
}

interface LegacyCausal {
  chainId?: string;
  rootRunId?: string;
  abortGroupId?: string;
  parentRunId?: string;
  depth?: number;
}

interface LegacyRun extends Omit<AgentRun, "causal" | "accessMode"> {
  causal: LegacyCausal;
  accessMode?: AccessMode;
}

function normalizeEvent(
  raw: StoredPlatformEvent,
  runs: Map<string, AgentRun>,
): StoredPlatformEvent {
  if (raw.type === "message.created") {
    const legacy = raw.message as ThreadMessage & { causal?: LegacyCausal };
    const mentions = Array.isArray(legacy.mentions)
      ? legacy.mentions
      : legacy.recipientAgentId
        ? [legacy.recipientAgentId]
        : [];
    const kind = legacy.kind ??
      (legacy.sender.type === "agent" && mentions.length > 0 ? "collaboration" : "chat");
    return {
      ...raw,
      message: {
        ...legacy,
        kind,
        mentions,
        ...(legacy.causal ? { causal: normalizeCausal(legacy.causal, legacy.id) } : {}),
      },
    } as StoredPlatformEvent;
  }
  if (raw.type === "run.queued") {
    return { ...raw, run: runs.get(raw.run.id) ?? raw.run } as StoredPlatformEvent;
  }
  if (raw.type === "run.delta" || raw.type === "run.tool") {
    const run = runs.get(raw.runId);
    return { ...raw, agentId: (raw as { agentId?: string }).agentId ?? run?.agentId ?? "unknown" } as StoredPlatformEvent;
  }
  if (raw.type === "routing.accepted") {
    const run = runs.get(raw.runId);
    return {
      ...raw,
      threadId: (raw as { threadId?: string }).threadId ?? run?.threadId ?? "",
      messageId: (raw as { messageId?: string }).messageId ?? run?.incomingMessageId ?? "",
    } as StoredPlatformEvent;
  }
  if (raw.type === "routing.rejected") {
    const run = runs.get(raw.runId);
    return {
      ...raw,
      threadId: (raw as { threadId?: string }).threadId ?? run?.threadId ?? "",
    } as StoredPlatformEvent;
  }
  return raw;
}

function normalizeRun(run: LegacyRun, agents: Map<Id, AgentDefinition>): AgentRun {
  return {
    ...run,
    status: run.status,
    accessMode: run.accessMode ?? agents.get(run.agentId)?.accessMode ?? "read-only",
    causal: normalizeCausal(run.causal, run.id),
  };
}

function normalizeCausal(causal: LegacyCausal, fallback: string): CausalMetadata {
  return {
    chainId: causal.chainId ?? causal.rootRunId ?? causal.abortGroupId ?? fallback,
    ...(causal.parentRunId ? { parentRunId: causal.parentRunId } : {}),
    depth: causal.depth ?? 0,
  };
}

function terminalStatus(type: "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted"): AgentRun["status"] {
  return {
    "run.completed": "completed",
    "run.failed": "failed",
    "run.cancelled": "cancelled",
    "run.interrupted": "interrupted",
  }[type] as AgentRun["status"];
}

function isTerminal(status: AgentRun["status"] | undefined): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function cursorKey(threadId: Id, agentId: Id): string {
  return `${threadId}\u0000${agentId}`;
}

function unorderedPair(first: string, second: string): string {
  return [first, second].sort().join("\u0000");
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
