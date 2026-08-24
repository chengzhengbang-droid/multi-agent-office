import { readFile } from "node:fs/promises";
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
  DeliverableDeclaration,
  Id,
  MessageAttachment,
  PlanApproval,
  PlanDecision,
  PlanPeerOutcome,
  PlatformEventPayload,
  ReviewEscalation,
  ReviewOutcome,
  ReviewSubmission,
  ReviewType,
  StoredPlatformEvent,
  Thread,
  ThreadMessage,
} from "./types.js";
import type {
  AgentRuntime,
  DeclareDeliverableInput,
  DeclareDeliverableResult,
  PostAgentMessageInput,
  PostAgentMessageResult,
  ReviewAssignment,
  RuntimeEvent,
  RuntimeImage,
  SubmitReviewInput,
  SubmitReviewResult,
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
  /**
   * "smart" reviews what an Agent declares as a deliverable (or what quietly
   * wrote files), leaving conversation ungated. "required" gates every user
   * task. "off" restores the pre-review behaviour where a completed run is the
   * final deliverable.
   */
  reviewMode?: ReviewMode;
  maxReviewRounds?: number;
}

export type ReviewMode = "smart" | "required" | "off";

/**
 * Tools whose use means the run changed the workspace. A run that wrote files
 * is reviewed whether or not its Agent declared anything: "I'm done" is a
 * claim, and an undeclared edit is the case the gate exists for. Shell tools
 * are deliberately absent — a reviewer reading files with `bash` would
 * otherwise arm the gate on its own review run.
 */
const WRITE_EFFECT_TOOLS = new Set(["file_change", "edit", "write"]);

export interface PostUserMessageInput {
  content: string;
  threadId?: Id;
  title?: string;
  humanId?: string;
  workingDirectory?: string;
  attachments?: MessageAttachment[];
  /**
   * Deliver into a run that is already in flight instead of queueing behind it.
   * Targets whose runtime cannot steer fall back to a queued run.
   */
  steer?: boolean;
  /**
   * Ask for a plan instead of the work. Runs start read-only, their deliverable
   * is a plan a peer critiques, and the plan reaches the human for approval
   * before anything is built.
   */
  planMode?: boolean;
  /**
   * Pre-assigned id for the message this call creates. The plan gate uses it to
   * record its decision before starting the follow-up, so a crash between the
   * two cannot leave a decided plan looking like it is still awaiting one.
   */
  messageId?: Id;
  /**
   * Route to these Agents instead of reading @handles out of the content. The
   * plan gate needs it because the message it sends quotes a plan an Agent
   * wrote: a handle inside that plan must not choose who runs next, and an
   * unknown one must not fail the send.
   */
  targets?: Id[];
}

export interface PostUserMessageResult {
  threadId: Id;
  chainId: Id;
  messageId: Id;
  /** Agents that received the message mid-run rather than through a new run. */
  steered: Id[];
}

export interface DecidePlanInput {
  taskRunId: Id;
  decision: PlanDecision;
  /** What the human said. Required to reject: a rejection has to say why. */
  note?: string;
  humanId?: string;
}

export interface DecidePlanResult {
  threadId: Id;
  taskRunId: Id;
  decision: PlanDecision;
  /** The Agent that now executes the plan, or revises it. */
  authorAgentId: Id;
  chainId: Id;
  messageId: Id;
}

/** A plan whose text is known but whose review has not settled yet. */
interface PlanDraft {
  planRunId: Id;
  authorAgentId: Id;
  plan: string;
  declaration?: DeliverableDeclaration;
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
  /** Streamed text/thinking awaiting a coalesced flush. See flushDeltas. */
  deltas: DeltaBuffer;
}

/**
 * Token deltas arrive one per token; each recorded event is an awaited append
 * to the JSONL log plus an SSE frame. Buffering them into ~one event per
 * DELTA_FLUSH_MS keeps the log and the socket sane without changing what a
 * client renders, since App.tsx appends chunks of any size.
 */
interface DeltaBuffer {
  text: string;
  thinking: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes flushes so a timer flush cannot interleave with an event flush. */
  tail: Promise<void>;
}

const DELTA_FLUSH_MS = 120;

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
  /** reviewRunId -> the verdict that run submitted, if any. */
  private readonly reviewSubmissions = new Map<Id, ReviewSubmission>();
  /** taskRunId -> review rounds requested so far. */
  private readonly reviewRounds = new Map<Id, number>();
  /** taskRunId values that already carry a terminal review.resolved. */
  private readonly resolvedTaskRuns = new Set<Id>();
  /** reviewRunId -> the Agent whose work that review judges. */
  private readonly reviewAuthors = new Map<Id, Id>();
  /** runId -> what that run's Agent declared it produced. */
  private readonly runDeliverables = new Map<Id, DeliverableDeclaration>();
  /** runIds that changed the workspace, declared or not. */
  private readonly runWriteEffects = new Set<Id>();
  /** taskRunId -> what its review rounds judge, stable across rework. */
  private readonly taskReviewTypes = new Map<Id, ReviewType>();
  /** reviewRunId -> the claim that review is checking, if the author made one. */
  private readonly reviewDeclarations = new Map<Id, DeliverableDeclaration>();
  /** taskRunId -> the newest plan text, until its critique settles. */
  private readonly planDrafts = new Map<Id, PlanDraft>();
  /** taskRunId -> a plan parked in front of the human. Cleared when decided. */
  private readonly planApprovals = new Map<Id, PlanApproval>();
  private readonly maxA2ADepth: number;
  private readonly maxAgentRunsPerChain: number;
  private readonly maxMentionTargets: number;
  private readonly maxPingPongHops: number;
  private readonly maxParallelReadRuns: number;
  private readonly reviewMode: ReviewMode;
  private readonly maxReviewRounds: number;
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
    this.reviewMode = options.reviewMode ?? "smart";
    this.maxReviewRounds = Math.max(1, options.maxReviewRounds ?? 2);
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
    const targets = input.targets
      ? [...new Set(input.targets)]
      : this.parseMessageTargets(content, threadId);
    if (targets.length === 0) throw new Error("No enabled and available Agent can receive this message");
    if (targets.length > this.maxMentionTargets) {
      throw new Error(`A message can target at most ${this.maxMentionTargets} Agents`);
    }
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
    const planMode = input.planMode === true;
    const message: ThreadMessage = {
      id: input.messageId ?? createId("msg"),
      threadId,
      sender: { type: "human", id: input.humanId ?? "operator" },
      kind: "chat",
      mentions: targets,
      content,
      createdAt: now(),
      causal,
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
    };
    await this.addMessage(message);

    const steered: Id[] = [];
    for (const target of targets) {
      const agent = this.agents.get(target);
      if (!agent) continue;
      // Steering drops a message into a run that is already executing, so it
      // cannot change that run's mode or its access. A plan-mode message must
      // start its own read-only run rather than land inside a writing one.
      if (input.steer && !planMode && (await this.trySteer(threadId, target, message))) {
        steered.push(target);
        continue;
      }
      await this.enqueueRun({
        id: createId("run"),
        threadId,
        agentId: target,
        incomingMessageId: message.id,
        status: "queued",
        // Plan mode is read-only by construction, not by convention: an Agent
        // asked for a proposal is denied the tools that would let it skip
        // ahead and build the thing instead.
        accessMode: planMode ? "read-only" : agent.accessMode,
        causal,
        createdAt: now(),
        purpose: "task",
        ...(planMode ? { mode: "plan" as const } : {}),
      });
    }
    this.startScheduler();
    const completion = this.waitForChain(chainId);
    return { threadId, chainId, messageId: message.id, steered, completion };
  }

  /** Who a human message wakes, read off its @handles. */
  private parseMessageTargets(content: string, threadId: Id): Id[] {
    const parsed = parseUserMentions(content, [...this.agents.values()], this.maxMentionTargets);
    if (parsed.unknown.length > 0) {
      throw new Error(`Unknown Agent handle: @${parsed.unknown.join(", @")}`);
    }
    if (parsed.overflow) {
      throw new Error(`A message can target at most ${this.maxMentionTargets} Agents`);
    }
    if (parsed.targets.length > 0) return parsed.targets;
    return [this.resolveFallbackAgent(threadId)].filter((id): id is string => Boolean(id));
  }

  /**
   * Hands a human message to a run that is already streaming. Only human
   * messages steer: routing an A2A post this way would bypass the depth,
   * ping-pong, and idempotency accounting that collaboration chains rely on.
   */
  private async trySteer(
    threadId: Id,
    agentId: Id,
    message: ThreadMessage,
  ): Promise<boolean> {
    const active = [...this.activeRuns.values()].find(
      (candidate) => candidate.run.agentId === agentId && candidate.run.threadId === threadId,
    );
    if (!active || !active.runtime.steer) return false;
    const text = [
      "<steering-message>",
      `sender_type: ${message.sender.type}`,
      `sender_id: ${message.sender.id}`,
      message.content,
      "</steering-message>",
      "",
      "This arrived while you were working. Take it into account before continuing.",
    ].join("\n");
    let delivered = false;
    try {
      delivered = await active.runtime.steer(active.run.id, text);
    } catch {
      return false;
    }
    if (!delivered) return false;
    // The cursor moves so the steered message is not replayed as fresh context
    // on this Agent's next run.
    this.deliveryCursors.set(cursorKey(threadId, agentId), message.id);
    await this.record({
      type: "run.steered",
      runId: active.run.id,
      threadId,
      agentId,
      messageId: message.id,
    });
    return true;
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
        if (countsTowardChainBudget(event.run)) {
          this.groupRunCounts.set(
            event.run.causal.chainId,
            (this.groupRunCounts.get(event.run.causal.chainId) ?? 0) + 1,
          );
        }
      } else if (event.type === "run.started") {
        this.runStatuses.set(event.runId, "running");
      } else if (
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled" ||
        event.type === "run.interrupted"
      ) {
        this.runStatuses.set(event.runId, terminalStatus(event.type));
        if (event.type === "run.completed" && this.runs.get(event.runId)?.purpose !== "review") {
          this.latestSuccessfulAgentByThread.set(event.threadId, event.agentId);
        }
      } else if (event.type === "routing.accepted") {
        this.acceptedIdempotencyKeys.add(event.idempotencyKey);
      } else if (event.type === "context.delivered") {
        this.deliveryCursors.set(cursorKey(event.threadId, event.agentId), event.messageId);
      } else if (event.type === "deliverable.declared") {
        this.runDeliverables.set(event.runId, {
          kind: event.kind,
          summary: event.summary,
          ...(event.evidence ? { evidence: event.evidence } : {}),
        });
      } else if (event.type === "review.requested") {
        this.reviewRounds.set(event.taskRunId, event.round);
        this.reviewAuthors.set(event.reviewRunId, event.authorAgentId);
        // Pre-smart-gate logs carry no reviewType; those reviews were all
        // completion checks, which is exactly what "verify" means.
        this.taskReviewTypes.set(event.taskRunId, event.reviewType ?? "verify");
      } else if (event.type === "review.rework") {
        this.reviewRounds.set(event.taskRunId, event.round);
      } else if (event.type === "review.submitted") {
        this.reviewSubmissions.set(event.reviewRunId, {
          verdict: event.verdict,
          summary: event.summary,
          ...(event.findings ? { findings: event.findings } : {}),
        });
      } else if (event.type === "review.resolved") {
        this.resolvedTaskRuns.add(event.taskRunId);
        this.forgetReviewState(event.taskRunId);
      } else if (event.type === "plan.awaiting-approval") {
        this.planApprovals.set(event.taskRunId, {
          threadId: event.threadId,
          taskRunId: event.taskRunId,
          planRunId: event.planRunId,
          authorAgentId: event.authorAgentId,
          plan: event.plan,
          ...(event.kind && event.summary
            ? {
                declaration: {
                  kind: event.kind,
                  summary: event.summary,
                  ...(event.evidence ? { evidence: event.evidence } : {}),
                },
              }
            : {}),
          peerOutcome: event.peerOutcome,
          rounds: event.rounds,
          ...(event.reviewerAgentId ? { reviewerAgentId: event.reviewerAgentId } : {}),
          ...(event.peerSummary ? { peerSummary: event.peerSummary } : {}),
          ...(event.escalation ? { escalation: event.escalation } : {}),
          requestedAt: event.recordedAt,
        });
      } else if (event.type === "plan.decided") {
        this.planApprovals.delete(event.taskRunId);
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
          this.forgetRunGateState(active.run.id);
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
      await this.escalateReviewRun(run, `审核者 @${run.agentId} 已不可用`);
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
      deltas: { text: "", thinking: "", timer: undefined, tail: Promise.resolve() },
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

    let completedOutput: string | undefined;
    try {
      const workingDirectory = this.threads.get(run.threadId)?.workingDirectory;
      const attachments = incoming.attachments ?? [];
      const images = await loadAttachmentImages(attachments);
      const assignment = this.reviewAssignmentFor(run);
      const result = await runtime.execute({
        runId: run.id,
        threadId: run.threadId,
        ...(workingDirectory ? { workingDirectory } : {}),
        // run.accessMode, not agent.accessMode: a plan-mode run is read-only
        // for this run only, and the runtime is what enforces that.
        agent: { ...agent, accessMode: run.accessMode },
        roster: [...this.agents.values()].filter((candidate) => candidate.enabled),
        incoming,
        context,
        ...(run.mode === "plan" ? { planMode: true as const } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(images.length > 0 ? { images } : {}),
        signal: controller.signal,
        // submit_review exists only on review runs, so no Agent can approve
        // work it produced itself.
        ...(assignment
          ? {
              reviewOf: assignment,
              submitReview: (input: SubmitReviewInput) =>
                this.acceptReviewSubmission(run, input),
            }
          : {}),
        emit: (event) => this.recordRuntimeEvent(active, event),
        postMessage: (message) => this.acceptAgentMessage(run, message),
        declareDeliverable: (input) => this.acceptDeliverableDeclaration(run, input),
      });

      await this.flushDeltas(active);
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
      // A reviewer answering the gate is not "the Agent handling this thread";
      // letting it win here would silently rewrite resolveFallbackAgent.
      if (run.purpose !== "review") {
        this.latestSuccessfulAgentByThread.set(run.threadId, run.agentId);
      }
      this.runStatuses.set(run.id, "completed");
      completedOutput = result.output;
    } catch (error) {
      await this.flushDeltas(active);
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
        await this.escalateReviewRun(run, `审核运行失败：${errorMessage(error)}`);
      }
    }

    // Outside the try/catch on purpose: a throw in here must not be recorded as
    // a failure of a run that already completed. Still inside executeRun, so
    // enqueueRun's incrementPending lands before the scheduler's
    // finishPendingRun — the chain cannot resolve while a review is owed.
    if (completedOutput !== undefined) {
      await this.advanceReview(run, completedOutput);
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
        purpose: "task",
      });
    }
    this.startScheduler();
    return { accepted: true, targets, messageId: message.id };
  }

  // ---------------------------------------------------------------------------
  // Mandatory peer-review gate
  //
  // A user task is not delivered when its run completes; it is delivered when a
  // different Agent approves it. Two invariants hold everywhere below: nothing
  // silently passes (a missing reviewer, a missing verdict, or a failed review
  // all escalate to the human), and nothing with side effects is auto-retried.
  // ---------------------------------------------------------------------------

  /** The stable id of the task a run serves, across every rework round. */
  private taskRunIdOf(run: AgentRun): Id {
    return run.taskRunId ?? run.id;
  }

  /**
   * Only work a human directly asked for is gated; A2A collaboration is not.
   *
   * "required" gates every such run, which is what made a greeting cost a full
   * review round-trip. "smart" additionally asks what the run actually
   * produced: an Agent that declared a deliverable, a run that wrote files
   * without declaring one, or a rework round already inside the gate. Plain
   * conversation declares nothing, touches nothing, and is reviewed by nobody.
   */
  private isReviewGated(run: AgentRun): boolean {
    if (this.reviewMode === "off") return false;
    if ((run.purpose ?? "task") !== "task") return false;
    if (run.causal.depth !== 0) return false;
    const humanAsked =
      this.messages.get(run.incomingMessageId)?.sender.type === "human" ||
      (run.reviewRound ?? 0) > 0;
    if (!humanAsked) return false;
    if (this.reviewMode === "required") return true;
    return (
      // A plan-mode run was asked for a plan, so a plan is what it produced.
      // Forgetting to call submit_plan does not turn it into conversation.
      run.mode === "plan" ||
      this.runDeliverables.has(run.id) ||
      this.runWriteEffects.has(run.id) ||
      (run.reviewRound ?? 0) > 0
    );
  }

  /** What the pending review round judges, given how the gate was armed. */
  private reviewTypeFor(run: AgentRun, taskRunId: Id): ReviewType {
    const settled = this.taskReviewTypes.get(taskRunId);
    if (settled) return settled;
    if (run.mode === "plan") return "critique";
    return this.runDeliverables.get(run.id)?.kind === "plan" ? "critique" : "verify";
  }

  private reviewAssignmentFor(run: AgentRun): ReviewAssignment | undefined {
    if (run.purpose !== "review" || !run.taskRunId) return undefined;
    const authorAgentId = this.reviewAuthors.get(run.id);
    if (!authorAgentId) return undefined;
    const declaration = this.reviewDeclarations.get(run.id);
    return {
      taskRunId: run.taskRunId,
      authorAgentId,
      round: run.reviewRound ?? 1,
      maxRounds: this.maxReviewRounds,
      reviewType: run.reviewType ?? this.taskReviewTypes.get(run.taskRunId) ?? "verify",
      independent: this.isIndependentReviewer(run.causal.chainId, run.agentId),
      ...(declaration ? { declaration } : {}),
    };
  }

  /** Runs after every completed run: opens the gate, or settles it. */
  private async advanceReview(run: AgentRun, output: string): Promise<void> {
    if (run.purpose === "review") {
      await this.settleReview(run);
      return;
    }
    const taskRunId = this.taskRunIdOf(run);
    // A critique judges a plan, so this run's output is the plan under review.
    // Recorded before the gate opens because the no-reviewer path settles the
    // task inside requestReview, and the human still has to see the plan.
    if (this.reviewTypeFor(run, taskRunId) === "critique") {
      this.planDrafts.set(taskRunId, {
        planRunId: run.id,
        authorAgentId: run.agentId,
        plan: output,
        ...(this.runDeliverables.get(run.id)
          ? { declaration: this.runDeliverables.get(run.id) as DeliverableDeclaration }
          : {}),
      });
    }
    if (!this.isReviewGated(run)) {
      // The gate is off, but plan mode is something the human asked for by
      // name. Nobody critiques the plan; it still stops here for approval.
      if (run.mode === "plan") await this.awaitPlanApproval(run.threadId, taskRunId, "skipped", 0);
      return;
    }
    await this.requestReview(run, output);
  }

  private async requestReview(run: AgentRun, output: string): Promise<void> {
    const taskRunId = this.taskRunIdOf(run);
    if (this.resolvedTaskRuns.has(taskRunId)) return;
    if (this.cancelledChains.has(run.causal.chainId)) return;
    const round = (this.reviewRounds.get(taskRunId) ?? 0) + 1;
    const reviewType = this.reviewTypeFor(run, taskRunId);
    // Settled before the reviewer is resolved: the no-reviewer branch below
    // ends the task through resolveReview, which has to know it was judging a
    // plan in order to hand that plan to the human.
    this.taskReviewTypes.set(taskRunId, reviewType);
    const declaration = this.runDeliverables.get(run.id);

    const reviewerAgentId = this.resolveReviewer(run.agentId, run.causal.chainId);
    const reviewer = reviewerAgentId ? this.agents.get(reviewerAgentId) : undefined;
    if (!reviewerAgentId || !reviewer) {
      await this.resolveReview(
        run,
        "escalated",
        round - 1,
        "no-reviewer",
        `没有除 @${run.agentId} 以外可用的 Agent 来审核，任务需要人工确认`,
      );
      return;
    }

    const originRun = this.runs.get(taskRunId) ?? run;
    const task = this.messages.get(originRun.incomingMessageId);
    const message: ThreadMessage = {
      id: createId("msg"),
      threadId: run.threadId,
      // Attributed to the author: the platform submits the work on its behalf.
      // A third "system" sender would ripple through the context compiler and
      // both prompt builders for no gain.
      sender: { type: "agent", id: run.agentId },
      kind: "review-request",
      mentions: [reviewerAgentId],
      content: buildReviewRequestContent({
        reviewerAgentId,
        authorAgentId: run.agentId,
        task: task?.content ?? "(原始任务不可用)",
        deliverable: output,
        round,
        maxRounds: this.maxReviewRounds,
        reviewType,
        independent: this.isIndependentReviewer(run.causal.chainId, reviewerAgentId),
        ...(declaration ? { declaration } : {}),
      }),
      intent: "review-request",
      createdAt: now(),
      // Review runs keep the author's depth. Spending A2A depth on the gate
      // would leave a reworking Agent unable to collaborate at all.
      causal: {
        chainId: run.causal.chainId,
        parentRunId: run.id,
        depth: run.causal.depth,
      },
    };
    await this.addMessage(message);

    const reviewRun: AgentRun = {
      id: createId("run"),
      threadId: run.threadId,
      agentId: reviewerAgentId,
      incomingMessageId: message.id,
      status: "queued",
      accessMode: reviewer.accessMode,
      causal: message.causal as CausalMetadata,
      createdAt: now(),
      purpose: "review",
      taskRunId,
      reviewRound: round,
      reviewType,
    };
    this.reviewRounds.set(taskRunId, round);
    this.reviewAuthors.set(reviewRun.id, run.agentId);
    if (declaration) this.reviewDeclarations.set(reviewRun.id, declaration);
    await this.record({
      type: "review.requested",
      threadId: run.threadId,
      taskRunId,
      reviewRunId: reviewRun.id,
      authorAgentId: run.agentId,
      reviewerAgentId,
      round,
      messageId: message.id,
      reviewType,
    });
    await this.enqueueRun(reviewRun);
    this.startScheduler();
  }

  /** Plans waiting on a human, newest last. */
  public async getPendingPlanApprovals(threadId?: Id): Promise<PlanApproval[]> {
    await this.ensureHydrated();
    return [...this.planApprovals.values()]
      .filter((approval) => !threadId || approval.threadId === threadId)
      .map((approval) => structuredClone(approval));
  }

  /**
   * The human's answer on a plan, and the only way past the plan gate. An
   * approval starts the work as its own task, reviewed on delivery like any
   * other; a rejection starts another planning round carrying what the human
   * said. Either way the answer is recorded before the follow-up starts, so a
   * crash in between cannot leave a decided plan looking undecided.
   */
  public async decidePlan(input: DecidePlanInput): Promise<DecidePlanResult> {
    await this.ensureHydrated();
    if (input.decision !== "approved" && input.decision !== "rejected") {
      throw new Error("decision must be approved or rejected");
    }
    const approval = this.planApprovals.get(input.taskRunId);
    if (!approval) throw new Error("这个计划不在等待人工确认，可能已经处理过了");
    const note = input.note?.trim() ?? "";
    // A rejection that says nothing sends the Agent back to guess what the
    // human disliked, which is how a second round repeats the first.
    if (input.decision === "rejected" && !note) {
      throw new Error("打回计划时必须说明需要改什么");
    }
    if (note.length > 20_000) throw new Error("批注不能超过 20,000 字符");
    if (this.rosterUpdateInProgress) throw new Error("The Agent catalog is being updated; retry the decision");
    if (!this.threads.has(approval.threadId)) throw new Error("任务不存在或已无法恢复");
    if (!this.isRoutable(approval.authorAgentId)) {
      throw new Error(`@${approval.authorAgentId} 当前不可用，无法继续这份计划`);
    }
    const content = buildPlanDecisionContent(approval, input.decision, note);
    const messageId = createId("msg");
    const decidedBy = input.humanId ?? "operator";

    // Consumed here so a double-click cannot start the work twice.
    this.planApprovals.delete(input.taskRunId);
    await this.record({
      type: "plan.decided",
      threadId: approval.threadId,
      taskRunId: input.taskRunId,
      decision: input.decision,
      decidedBy,
      ...(note ? { note } : {}),
      followUpMessageId: messageId,
    });

    let started: StartedUserMessage;
    try {
      started = await this.startUserMessage({
        threadId: approval.threadId,
        content,
        humanId: decidedBy,
        messageId,
        // The message quotes the Agent's own plan; only the author runs next.
        targets: [approval.authorAgentId],
        // A rejection is another planning round, so it stays read-only. An
        // approval is the point where building becomes allowed.
        ...(input.decision === "rejected" ? { planMode: true } : {}),
      });
    } catch (error) {
      // The decision stands — it is what the human said — but nothing picked
      // it up, so say that plainly instead of reporting a started run.
      throw new Error(`计划决定已记录，但没能派发给 @${approval.authorAgentId}：${errorMessage(error)}`);
    }
    void started.completion.catch(() => {});
    return {
      threadId: approval.threadId,
      taskRunId: input.taskRunId,
      decision: input.decision,
      authorAgentId: approval.authorAgentId,
      chainId: started.chainId,
      messageId: started.messageId,
    };
  }

  /**
   * Picks the most independent peer available. An Agent that already produced
   * work in this chain has its own judgment invested in the result: asking it
   * to review is asking it to find fault with a plan it helped make, so a peer
   * that touched nothing here outranks even the configured reviewer. A
   * compromised reviewer still beats no reviewer — the last fallback keeps the
   * old behaviour rather than escalating a task nobody looked at.
   */
  private resolveReviewer(authorAgentId: Id, chainId: Id): Id | undefined {
    // Roster order throughout, so every fallback stays deterministic.
    const candidates = [...this.agents.keys()].filter(
      (id) => id !== authorAgentId && this.isRoutable(id),
    );
    const contributors = this.chainContributors(chainId);
    const independent = candidates.filter((id) => !contributors.has(id));
    const preferred = this.agents.get(authorAgentId)?.reviewerAgentId;
    if (preferred && independent.includes(preferred)) return preferred;
    if (independent.length > 0) return independent[0];
    if (preferred && candidates.includes(preferred)) return preferred;
    return candidates[0];
  }

  /** True when the reviewer produced no work of its own in this chain. */
  private isIndependentReviewer(chainId: Id, reviewerAgentId: Id): boolean {
    return !this.chainContributors(chainId).has(reviewerAgentId);
  }

  /**
   * Agents that produced work in this collaboration chain. Review runs are not
   * counted: a reviewer that already rejected round 1 is exactly who should
   * judge the rework, and counting its own review would disqualify it.
   */
  private chainContributors(chainId: Id): Set<Id> {
    const contributors = new Set<Id>();
    for (const run of this.runs.values()) {
      if (run.causal.chainId !== chainId || run.purpose === "review") continue;
      contributors.add(run.agentId);
    }
    return contributors;
  }

  private async settleReview(reviewRun: AgentRun): Promise<void> {
    const taskRunId = reviewRun.taskRunId;
    if (!taskRunId || this.resolvedTaskRuns.has(taskRunId)) return;
    const round = reviewRun.reviewRound ?? 1;
    const reviewType = reviewRun.reviewType ?? this.taskReviewTypes.get(taskRunId) ?? "verify";
    const submission = this.reviewSubmissions.get(reviewRun.id);

    if (!submission) {
      await this.resolveReview(
        reviewRun,
        "escalated",
        round,
        "inconclusive",
        `@${reviewRun.agentId} 结束了审核但没有调用 submit_review，不能视为通过`,
      );
      return;
    }
    if (submission.verdict === "approved") {
      await this.resolveReview(reviewRun, "approved", round);
      return;
    }
    if (this.cancelledChains.has(reviewRun.causal.chainId)) {
      await this.resolveReview(reviewRun, "cancelled", round, undefined, "协作链已取消");
      return;
    }
    if (round >= this.maxReviewRounds) {
      await this.resolveReview(
        reviewRun,
        "escalated",
        round,
        "max-rounds",
        `${round} 轮审核后仍未通过，需要人工判断`,
      );
      return;
    }

    const authorAgentId = this.reviewAuthors.get(reviewRun.id);
    const author = authorAgentId ? this.agents.get(authorAgentId) : undefined;
    if (!authorAgentId || !author || !this.isRoutable(authorAgentId)) {
      await this.resolveReview(
        reviewRun,
        "escalated",
        round,
        "review-failed",
        `执行者 @${authorAgentId ?? "unknown"} 已不可用，无法返工`,
      );
      return;
    }

    const originRun = this.runs.get(taskRunId);
    const feedback: ThreadMessage = {
      id: createId("msg"),
      threadId: reviewRun.threadId,
      sender: { type: "agent", id: reviewRun.agentId },
      kind: "review-feedback",
      mentions: [authorAgentId],
      content: buildReviewFeedbackContent({
        authorAgentId,
        submission,
        round,
        maxRounds: this.maxReviewRounds,
        reviewType,
      }),
      intent: "review-changes-requested",
      createdAt: now(),
      causal: {
        chainId: reviewRun.causal.chainId,
        parentRunId: reviewRun.id,
        depth: originRun?.causal.depth ?? reviewRun.causal.depth,
      },
    };
    await this.addMessage(feedback);

    const reworkRun: AgentRun = {
      id: createId("run"),
      threadId: reviewRun.threadId,
      agentId: authorAgentId,
      incomingMessageId: feedback.id,
      status: "queued",
      // Revising a plan is still planning. A critique round that handed back
      // write access would let "address these findings" become "build it".
      accessMode: reviewType === "critique" ? "read-only" : author.accessMode,
      causal: feedback.causal as CausalMetadata,
      createdAt: now(),
      purpose: "task",
      taskRunId,
      reviewRound: round,
      reviewType,
      ...(reviewType === "critique" ? { mode: "plan" as const } : {}),
    };
    await this.record({
      type: "review.rework",
      threadId: reviewRun.threadId,
      taskRunId,
      reworkRunId: reworkRun.id,
      authorAgentId,
      round,
      messageId: feedback.id,
    });
    await this.enqueueRun(reworkRun);
    this.startScheduler();
  }

  /** The single terminal marker for a gated task. Fires at most once. */
  private async resolveReview(
    run: AgentRun,
    outcome: ReviewOutcome,
    rounds: number,
    escalation?: ReviewEscalation,
    detail?: string,
  ): Promise<void> {
    const taskRunId = this.taskRunIdOf(run);
    if (this.resolvedTaskRuns.has(taskRunId)) return;
    this.resolvedTaskRuns.add(taskRunId);
    const reviewType = run.reviewType ?? this.taskReviewTypes.get(taskRunId);
    await this.record({
      type: "review.resolved",
      threadId: run.threadId,
      taskRunId,
      outcome,
      rounds,
      ...(escalation ? { escalation } : {}),
      ...(detail ? { detail } : {}),
      ...(reviewType ? { reviewType } : {}),
    });
    // A critique settling is not the end of a plan, only the end of the peer
    // round. Approved or escalated, the plan now goes to the human — the peers
    // advise, the human decides. Cancellation is the operator's own doing and
    // asks nothing of them.
    if (reviewType === "critique" && outcome !== "cancelled") {
      await this.awaitPlanApproval(
        run.threadId,
        taskRunId,
        outcome === "approved" ? "approved" : "escalated",
        rounds,
        run.purpose === "review" ? run.agentId : undefined,
        run.purpose === "review" ? this.reviewSubmissions.get(run.id)?.summary : undefined,
        escalation,
      );
    }
    this.forgetReviewState(taskRunId);
  }

  /**
   * Parks a finalized plan in front of the human. No run is queued here on
   * purpose: plan mode exists so that nothing is built until a person says so,
   * and an auto-started execution would quietly delete that guarantee.
   */
  private async awaitPlanApproval(
    threadId: Id,
    taskRunId: Id,
    peerOutcome: PlanPeerOutcome,
    rounds: number,
    reviewerAgentId?: Id,
    peerSummary?: string,
    escalation?: ReviewEscalation,
  ): Promise<void> {
    const draft = this.planDrafts.get(taskRunId);
    // No draft means no plan text was ever captured for this task, which only
    // happens on a replayed log from before plan mode. Nothing to approve.
    if (!draft) return;
    if (this.planApprovals.has(taskRunId)) return;
    this.planDrafts.delete(taskRunId);
    const approval: PlanApproval = {
      threadId,
      taskRunId,
      planRunId: draft.planRunId,
      authorAgentId: draft.authorAgentId,
      plan: draft.plan,
      ...(draft.declaration ? { declaration: draft.declaration } : {}),
      peerOutcome,
      rounds,
      ...(reviewerAgentId ? { reviewerAgentId } : {}),
      ...(peerSummary ? { peerSummary } : {}),
      ...(escalation ? { escalation } : {}),
      requestedAt: now(),
    };
    this.planApprovals.set(taskRunId, approval);
    await this.record({
      type: "plan.awaiting-approval",
      threadId,
      taskRunId,
      planRunId: approval.planRunId,
      authorAgentId: approval.authorAgentId,
      plan: approval.plan,
      ...(draft.declaration
        ? {
            kind: draft.declaration.kind,
            summary: draft.declaration.summary,
            ...(draft.declaration.evidence ? { evidence: draft.declaration.evidence } : {}),
          }
        : {}),
      peerOutcome,
      rounds,
      ...(reviewerAgentId ? { reviewerAgentId } : {}),
      ...(peerSummary ? { peerSummary } : {}),
      ...(escalation ? { escalation } : {}),
    });
  }

  /**
   * Drops a finished run's gate bookkeeping. The gate reads it while the run is
   * still executing; by the time the run leaves the scheduler, requestReview
   * has already copied any declaration onto the review run. Without this, a
   * session with the gate off would accumulate declarations forever.
   */
  private forgetRunGateState(runId: Id): void {
    this.runDeliverables.delete(runId);
    this.runWriteEffects.delete(runId);
    this.reviewDeclarations.delete(runId);
  }

  /**
   * Drops the per-task gate bookkeeping once the task is terminal. The
   * resolved-task and round maps outlive it: they are what stop a late review
   * from reopening a settled task.
   */
  private forgetReviewState(taskRunId: Id): void {
    this.taskReviewTypes.delete(taskRunId);
    // Normally consumed by awaitPlanApproval; a cancelled critique never gets
    // there, and a draft nobody will read is just a leak.
    this.planDrafts.delete(taskRunId);
    // Per-run state is dropped as each run leaves the scheduler; the
    // originating run keys itself, so replay reaches it here too.
    this.forgetRunGateState(taskRunId);
  }

  /** A review run that never reached a verdict leaves the task for a human. */
  private async escalateReviewRun(run: AgentRun, detail: string): Promise<void> {
    if (run.purpose !== "review" || !run.taskRunId) return;
    const round = run.reviewRound ?? 1;
    if (this.runStatuses.get(run.id) === "cancelled") {
      await this.resolveReview(run, "cancelled", round, undefined, detail);
      return;
    }
    await this.resolveReview(run, "escalated", round, "review-failed", detail);
  }

  /**
   * Backs the complete_task and submit_plan tools. An Agent judges for itself
   * whether its output is a deliverable; this records that judgment. It is a
   * claim, not a conclusion — accepting it opens the review gate rather than
   * closing the task, and a peer decides whether the claim holds.
   */
  private async acceptDeliverableDeclaration(
    run: AgentRun,
    input: DeclareDeliverableInput,
  ): Promise<DeclareDeliverableResult> {
    if (run.purpose === "review") {
      return {
        accepted: false,
        reason: "a review run judges someone else's deliverable; it does not declare one",
      };
    }
    if (input.kind !== "completion" && input.kind !== "plan") {
      return { accepted: false, reason: "kind must be completion or plan" };
    }
    if (run.mode === "plan" && input.kind === "completion") {
      return {
        accepted: false,
        reason:
          "this run is in plan mode: nothing has been built yet, so call submit_plan instead of complete_task",
      };
    }
    if (this.resolvedTaskRuns.has(this.taskRunIdOf(run))) {
      return { accepted: false, reason: "this task has already been resolved" };
    }
    const summary = input.summary?.trim() ?? "";
    if (!summary) return { accepted: false, reason: "summary is required" };
    if (summary.length > 20_000) {
      return { accepted: false, reason: "summary must be at most 20,000 characters" };
    }
    const existing = this.runDeliverables.get(run.id);
    if (existing && existing.kind !== input.kind) {
      return {
        accepted: false,
        reason: `this run already declared a ${existing.kind}; it cannot also be a ${input.kind}`,
      };
    }
    const evidence = (input.evidence ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 20);
    const declaration: DeliverableDeclaration = {
      kind: input.kind,
      summary,
      ...(evidence.length > 0 ? { evidence } : {}),
    };
    this.runDeliverables.set(run.id, declaration);
    await this.record({
      type: "deliverable.declared",
      runId: run.id,
      threadId: run.threadId,
      agentId: run.agentId,
      ...declaration,
    });
    return { accepted: true };
  }

  /**
   * Backs the submit_review tool. The tool is declared on every run so a
   * resumed session keeps a stable tool surface; authority to accept a verdict
   * lives here, which is what actually stops an Agent approving its own work.
   */
  private async acceptReviewSubmission(
    run: AgentRun,
    input: SubmitReviewInput,
  ): Promise<SubmitReviewResult> {
    if (run.purpose !== "review" || !run.taskRunId) {
      return {
        accepted: false,
        reason: "submit_review is only available while reviewing another Agent's work",
      };
    }
    if (input.verdict !== "approved" && input.verdict !== "changes-requested") {
      return { accepted: false, reason: "verdict must be approved or changes-requested" };
    }
    const summary = input.summary?.trim() ?? "";
    if (!summary) return { accepted: false, reason: "summary is required" };
    if (summary.length > 20_000) {
      return { accepted: false, reason: "summary must be at most 20,000 characters" };
    }
    const findings = (input.findings ?? [])
      .map((finding) => finding.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (input.verdict === "changes-requested" && findings.length === 0) {
      return {
        accepted: false,
        reason: "changes-requested must list at least one concrete finding",
      };
    }
    const checks = (input.checks ?? [])
      .map((check) => check.trim())
      .filter(Boolean)
      .slice(0, 20);
    // The burden of proof sits with the approval, not with the rejection. A
    // reviewer that cannot name one thing it checked for itself has only
    // relayed the author's claim, which is exactly what the gate exists to
    // stop; rejecting here sends it back to verify rather than passing.
    if (input.verdict === "approved" && checks.length === 0) {
      return {
        accepted: false,
        reason:
          "approved must list at least one check you ran yourself (file read, command executed, output observed)",
      };
    }
    const submission: ReviewSubmission = {
      verdict: input.verdict,
      summary,
      ...(findings.length > 0 ? { findings } : {}),
      ...(checks.length > 0 ? { checks } : {}),
    };
    this.reviewSubmissions.set(run.id, submission);
    await this.record({
      type: "review.submitted",
      threadId: run.threadId,
      taskRunId: run.taskRunId,
      reviewRunId: run.id,
      reviewerAgentId: run.agentId,
      ...submission,
    });
    return { accepted: true };
  }

  private projectedPingPongHops(sourceRun: AgentRun, targetAgentId: Id): number {
    const pair = unorderedPair(sourceRun.agentId, targetAgentId);
    let count = 1;
    let current = sourceRun;
    while (current.causal.parentRunId) {
      const parent = this.runs.get(current.causal.parentRunId);
      if (!parent || unorderedPair(parent.agentId, current.agentId) !== pair) break;
      // The review gate makes author -> reviewer -> author lineage routine, and
      // it is platform-driven rather than two Agents talking past each other.
      // Charging it here would spend the budget before the pair says anything.
      if (parent.purpose === "review" || current.purpose === "review") break;
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
    if (countsTowardChainBudget(run)) {
      this.groupRunCounts.set(
        run.causal.chainId,
        (this.groupRunCounts.get(run.causal.chainId) ?? 0) + 1,
      );
    }
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

  /**
   * Holds a streamed chunk until the flush timer fires. Never awaited by the
   * runtime: a token-rate emit() that awaited an fs append would throttle the
   * model's own output loop.
   */
  private bufferDelta(active: ActiveRun, type: "text_delta" | "thinking_delta", text: string): void {
    if (!text) return;
    if (type === "text_delta") active.deltas.text += text;
    else active.deltas.thinking += text;
    if (active.deltas.timer) return;
    active.deltas.timer = setTimeout(() => {
      active.deltas.timer = undefined;
      void this.flushDeltas(active);
    }, DELTA_FLUSH_MS);
    // A pending flush must never hold the process open past its work.
    active.deltas.timer.unref?.();
  }

  /**
   * Emits whatever is buffered as at most one delta event per stream. Flushes
   * are chained rather than concurrent: the timer and an incoming event can
   * both trigger one, and a later event must never be appended ahead of the
   * text that preceded it.
   */
  private flushDeltas(active: ActiveRun): Promise<void> {
    if (active.deltas.timer) {
      clearTimeout(active.deltas.timer);
      active.deltas.timer = undefined;
    }
    active.deltas.tail = active.deltas.tail.then(() => this.emitBufferedDeltas(active));
    return active.deltas.tail;
  }

  private async emitBufferedDeltas(active: ActiveRun): Promise<void> {
    const { text, thinking } = active.deltas;
    if (!text && !thinking) return;
    active.deltas.text = "";
    active.deltas.thinking = "";
    const { run } = active;
    if (thinking) {
      await this.record({
        type: "run.thinking",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        text: thinking,
      });
    }
    if (text) {
      await this.record({
        type: "run.delta",
        runId: run.id,
        threadId: run.threadId,
        agentId: run.agentId,
        text,
      });
    }
  }

  private async recordRuntimeEvent(active: ActiveRun, event: RuntimeEvent): Promise<void> {
    const { run, context } = active;
    if (event.type === "text_delta" || event.type === "thinking_delta") {
      this.bufferDelta(active, event.type, event.text);
      return;
    }
    // Every other event is ordered against the stream the Agent was producing
    // when it fired, so the buffer drains before it is recorded. That includes
    // output_reset: the discarded attempt still happened, and the log keeps it
    // ahead of the reset that tells clients to clear it.
    await this.flushDeltas(active);
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
    // A run that edits the workspace is reviewable on that evidence alone, so
    // an Agent cannot skip the gate by simply not declaring what it did.
    if (
      event.type === "tool_start" &&
      run.accessMode !== "read-only" &&
      WRITE_EFFECT_TOOLS.has(event.toolName)
    ) {
      this.runWriteEffects.add(run.id);
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
    await this.escalateReviewRun(run, `审核被取消：${reason}`);
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
    await this.escalateReviewRun(run, `审核被中断：${reason}`);
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
    purpose: run.purpose ?? "task",
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

const REVIEW_EXCERPT_LIMIT = 12_000;

function excerpt(value: string): string {
  return value.length <= REVIEW_EXCERPT_LIMIT
    ? value
    : `${value.slice(0, REVIEW_EXCERPT_LIMIT)}\n[... truncated for the review context budget]`;
}

function buildReviewRequestContent(input: {
  reviewerAgentId: Id;
  authorAgentId: Id;
  task: string;
  deliverable: string;
  round: number;
  maxRounds: number;
  reviewType: ReviewType;
  /** False when no peer outside this chain was available to review. */
  independent: boolean;
  declaration?: DeliverableDeclaration;
}): string {
  const evidence = input.declaration?.evidence ?? [];
  const claim = input.declaration
    ? [
        "",
        `<author-claim kind="${input.declaration.kind}">`,
        excerpt(input.declaration.summary),
        ...(evidence.length > 0
          ? ["", "Evidence the author offers:", ...evidence.map((item) => `- ${item}`)]
          : []),
        "</author-claim>",
      ]
    : [];
  const header =
    input.reviewType === "critique"
      ? `@${input.reviewerAgentId} Independently critique @${input.authorAgentId}'s plan — round ${input.round} of ${input.maxRounds}.`
      : `@${input.reviewerAgentId} Independently verify @${input.authorAgentId}'s completed work — round ${input.round} of ${input.maxRounds}.`;
  // The two briefs differ in what counts as doing the job: a plan is judged on
  // its reasoning, finished work on the artifacts it claims to have produced.
  // Both start from disbelief: an author's "done" is a claim to test, never a
  // fact to take on trust, and agreement is what has to be earned here.
  const brief =
    input.reviewType === "critique"
      ? [
          "Your default position is not-ready. The author has to convince you, not the other way round.",
          "This is a plan, not finished work. Try to break it before anyone builds it.",
          "Judge it against the human's original task above, not against the author's framing of that task.",
          "Attack the assumptions it never argues for, the failure modes it skips, and the work it hides behind one line.",
          "approved means you would put your own name on executing it as written. changes-requested returns concrete suggestions for one revision round.",
        ]
      : [
          "Your default position is not-approved. The burden of proof is on the author's claim, not on your doubt.",
          "The summary and the evidence above are assertions. They are what you test; they prove nothing by themselves.",
          "Go to the primary sources yourself: open the files it says it changed, run the commands it says it ran, read the real output.",
          "Look for what the claim would hide: dropped requirements from the original task, untouched edge cases, error paths, tests that assert nothing, changes it never mentioned.",
          "Anything you could not check with the access you have is unverified. Say so plainly, and never approve on it.",
          "Do not redo the work yourself. Say concretely what must change.",
        ];
  const independence = input.independent
    ? []
    : [
        "You already worked in this chain, so you are not a neutral party here — no uninvolved peer was available.",
        "Hold your own contribution to the same standard you would apply to anyone else's.",
      ];
  return [
    header,
    "",
    "<original-task>",
    excerpt(input.task),
    "</original-task>",
    ...claim,
    "",
    "<deliverable>",
    excerpt(input.deliverable),
    "</deliverable>",
    "",
    ...brief,
    ...independence,
    "Finish by calling submit_review exactly once: approved, or changes-requested with concrete findings.",
    "approved requires listing at least one check you ran yourself; an approval that cannot name one is rejected.",
    "Do not manufacture agreement to close the loop. A review that finds nothing has usually not looked.",
    "Ending without submit_review is not an approval — it escalates the task to the human.",
  ].join("\n");
}

/**
 * The message a human decision sends back into the thread. It is a human
 * message like any other, so the Agent picks it up through the ordinary path
 * — the only special thing about it is that the platform wrote the words.
 */
function buildPlanDecisionContent(
  approval: PlanApproval,
  decision: PlanDecision,
  note: string,
): string {
  const peer =
    approval.peerOutcome === "approved"
      ? `Peer critique: @${approval.reviewerAgentId ?? "unknown"} approved this plan after ${approval.rounds} round(s).`
      : approval.peerOutcome === "escalated"
        ? `Peer critique did not approve this plan (${approval.escalation ?? "escalated"}); the human read it anyway.`
        : "No peer critiqued this plan; the review gate is off.";
  const humanNote = note ? ["", "<human-note>", note, "</human-note>"] : [];
  if (decision === "approved") {
    return [
      `@${approval.authorAgentId} The human approved your plan. Build it.`,
      "",
      peer,
      "",
      "<approved-plan>",
      excerpt(approval.plan),
      "</approved-plan>",
      ...humanNote,
      "",
      "Execute the plan as approved. It is what the human agreed to, so a departure from it needs saying out loud, not doing quietly.",
      "If you find the plan cannot work as written, stop and say why instead of substituting your own.",
      "Call complete_task when the work is done, with evidence a reviewer can check.",
    ].join("\n");
  }
  return [
    `@${approval.authorAgentId} The human did not approve your plan. Revise it.`,
    "",
    peer,
    "",
    "<rejected-plan>",
    excerpt(approval.plan),
    "</rejected-plan>",
    ...humanNote,
    "",
    "The note above is the human's own judgment and outranks the peer critique. Address it directly rather than restating the plan.",
    "You are still planning: do not start building. Call submit_plan when the revision is ready.",
  ].join("\n");
}

function buildReviewFeedbackContent(input: {
  authorAgentId: Id;
  submission: ReviewSubmission;
  round: number;
  maxRounds: number;
  reviewType: ReviewType;
}): string {
  const findings = input.submission.findings ?? [];
  const closing =
    input.reviewType === "critique"
      ? `Revise your plan to address these. Round ${input.round + 1} will review the revision.`
      : `Fix these and deliver again. Round ${input.round + 1} will verify your update.`;
  return [
    `@${input.authorAgentId} Review round ${input.round} of ${input.maxRounds}: changes requested.`,
    "",
    input.submission.summary,
    ...(findings.length > 0 ? ["", "Findings:", ...findings.map((f) => `- ${f}`)] : []),
    "",
    closing,
  ].join("\n");
}

function cursorKey(threadId: Id, agentId: Id): string {
  return `${threadId}\u0000${agentId}`;
}

/**
 * The per-chain run budget bounds Agent-initiated fan-out, which is unbounded
 * and adversarial. Review and rework runs are platform-initiated and already
 * bounded by maxReviewRounds, so counting them would let an Agent's A2A spend
 * strand a task mid-gate.
 */
function countsTowardChainBudget(run: AgentRun): boolean {
  return (run.purpose ?? "task") === "task" && (run.reviewRound ?? 0) === 0;
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

/**
 * Reads image attachments off disk for runtimes that accept inline images. A
 * file that has been moved or removed is skipped rather than failing the run.
 */
async function loadAttachmentImages(
  attachments: MessageAttachment[],
): Promise<RuntimeImage[]> {
  const images: RuntimeImage[] = [];
  for (const attachment of attachments) {
    if (!attachment.mediaType.startsWith("image/")) continue;
    try {
      const bytes = await readFile(attachment.path);
      images.push({ mediaType: attachment.mediaType, data: bytes.toString("base64") });
    } catch {
      continue;
    }
  }
  return images;
}
