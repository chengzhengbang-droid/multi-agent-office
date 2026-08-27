import type { PendingBallHold } from "./collaboration.js";
import type { AgentRun, Id, RunStatus, StoredPlatformEvent } from "./types.js";

export type CollaborationChainState =
  | "queued"
  | "active"
  | "waiting-external"
  | "waiting-human"
  | "completed"
  | "needs-attention"
  | "cancelled";

export interface CollaborationRunProjection {
  runId: Id;
  agentId: Id;
  incomingMessageId: Id;
  status: RunStatus;
  purpose: AgentRun["purpose"];
  routing?: AgentRun["routing"];
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface CollaborationChainProjection {
  chainId: Id;
  threadId: Id;
  state: CollaborationChainState;
  runs: CollaborationRunProjection[];
  activeAgentIds: Id[];
  queuedAgentIds: Id[];
  failedAgentIds: Id[];
  pendingHolds: PendingBallHold[];
  waitingHumanReason?: Extract<
    StoredPlatformEvent,
    { type: "ball.handed_user" }
  >["reason"];
  voidPassCount: number;
  createdAt: string;
  updatedAt: string;
}

export type HandoffDeliveryStatus = "accepted" | RunStatus;

export interface HandoffDeliveryProjection {
  messageId: Id;
  sourceRunId: Id;
  targetAgentId: Id;
  status: HandoffDeliveryStatus;
  runId?: Id;
  acceptedAt: string;
  updatedAt: string;
  detail?: string;
}

interface MutableChain {
  chainId: Id;
  threadId: Id;
  runs: Map<Id, CollaborationRunProjection>;
  holds: Map<Id, PendingBallHold>;
  waitingHumanReason?: CollaborationChainProjection["waitingHumanReason"];
  voidPassCount: number;
  resolved: boolean;
  cancelled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Rebuild the collaboration fleet view from the append-only event log. This is
 * deliberately a projection, not a second scheduler state: UI, diagnostics,
 * and restart audits all read the same facts that drove execution.
 */
export function projectCollaborationChains(
  events: StoredPlatformEvent[],
  threadId?: Id,
): CollaborationChainProjection[] {
  const chains = new Map<Id, MutableChain>();
  const runToChain = new Map<Id, Id>();
  const holdToChain = new Map<Id, Id>();

  const ensure = (chainId: Id, candidateThreadId: Id, recordedAt: string): MutableChain => {
    const existing = chains.get(chainId);
    if (existing) {
      existing.updatedAt = recordedAt;
      return existing;
    }
    const created: MutableChain = {
      chainId,
      threadId: candidateThreadId,
      runs: new Map(),
      holds: new Map(),
      voidPassCount: 0,
      resolved: false,
      cancelled: false,
      createdAt: recordedAt,
      updatedAt: recordedAt,
    };
    chains.set(chainId, created);
    return created;
  };

  for (const event of events) {
    if (event.type === "run.queued") {
      if (threadId && event.run.threadId !== threadId) continue;
      const chain = ensure(event.run.causal.chainId, event.run.threadId, event.recordedAt);
      chain.runs.set(event.run.id, {
        runId: event.run.id,
        agentId: event.run.agentId,
        incomingMessageId: event.run.incomingMessageId,
        status: "queued",
        purpose: event.run.purpose,
        ...(event.run.routing ? { routing: event.run.routing } : {}),
      });
      runToChain.set(event.run.id, event.run.causal.chainId);
      continue;
    }

    if (isRunLifecycleEvent(event)) {
      const chainId = runToChain.get(event.runId);
      const chain = chainId ? chains.get(chainId) : undefined;
      const run = chain?.runs.get(event.runId);
      if (!chain || !run) continue;
      chain.updatedAt = event.recordedAt;
      if (event.type === "run.started") {
        run.status = "running";
        run.startedAt = event.recordedAt;
      } else {
        run.status = runStatusFromEvent(event.type);
        run.finishedAt = event.recordedAt;
        if (event.type === "run.failed") run.detail = event.error;
        if (event.type === "run.cancelled" || event.type === "run.interrupted") {
          run.detail = event.reason;
        }
      }
      continue;
    }

    if (event.type === "ball.held") {
      if (threadId && event.hold.threadId !== threadId) continue;
      const chain = ensure(event.hold.chainId, event.hold.threadId, event.recordedAt);
      chain.holds.set(event.hold.id, event.hold);
      holdToChain.set(event.hold.id, event.hold.chainId);
      continue;
    }

    if (event.type === "ball.wake_sent" || event.type === "ball.hold_cancelled") {
      const chainId = holdToChain.get(event.holdId);
      const chain = chainId ? chains.get(chainId) : undefined;
      if (!chain) continue;
      chain.holds.delete(event.holdId);
      chain.updatedAt = event.recordedAt;
      continue;
    }

    if (!isChainSignal(event) || (threadId && event.threadId !== threadId)) continue;
    const chain = ensure(event.chainId, event.threadId, event.recordedAt);
    if (event.type === "ball.handed_user") {
      chain.waitingHumanReason = event.reason;
    } else if (event.type === "ball.void_pass") {
      chain.voidPassCount += 1;
    } else if (event.type === "task.done") {
      chain.resolved = true;
      chain.waitingHumanReason = undefined;
    } else if (event.type === "ball.cancelled") {
      chain.cancelled = true;
    }
  }

  return [...chains.values()]
    .map(finalizeChain)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** Per-target delivery receipts for visible post_message handoffs. */
export function projectHandoffDeliveries(
  events: StoredPlatformEvent[],
  threadId?: Id,
): HandoffDeliveryProjection[] {
  const deliveries = new Map<string, HandoffDeliveryProjection>();
  const runToDelivery = new Map<Id, string>();

  for (const event of events) {
    if (event.type === "routing.accepted") {
      if (threadId && event.threadId !== threadId) continue;
      const key = deliveryKey(event.messageId, event.targetAgentId);
      deliveries.set(key, {
        messageId: event.messageId,
        sourceRunId: event.runId,
        targetAgentId: event.targetAgentId,
        status: "accepted",
        acceptedAt: event.recordedAt,
        updatedAt: event.recordedAt,
      });
      continue;
    }
    if (event.type === "run.queued") {
      const key = deliveryKey(event.run.incomingMessageId, event.run.agentId);
      const delivery = deliveries.get(key);
      if (!delivery) continue;
      delivery.status = "queued";
      delivery.runId = event.run.id;
      delivery.updatedAt = event.recordedAt;
      runToDelivery.set(event.run.id, key);
      continue;
    }
    if (!isRunLifecycleEvent(event)) continue;
    const key = runToDelivery.get(event.runId);
    const delivery = key ? deliveries.get(key) : undefined;
    if (!delivery) continue;
    delivery.updatedAt = event.recordedAt;
    if (event.type === "run.started") {
      delivery.status = "running";
    } else {
      delivery.status = runStatusFromEvent(event.type);
      if (event.type === "run.failed") delivery.detail = event.error;
      if (event.type === "run.cancelled" || event.type === "run.interrupted") {
        delivery.detail = event.reason;
      }
    }
  }

  return [...deliveries.values()];
}

function finalizeChain(chain: MutableChain): CollaborationChainProjection {
  const runs = [...chain.runs.values()];
  const activeAgentIds = unique(runs.filter((run) => run.status === "running").map((run) => run.agentId));
  for (const hold of chain.holds.values()) {
    if (!activeAgentIds.includes(hold.agentId)) activeAgentIds.push(hold.agentId);
  }
  const queuedAgentIds = unique(runs.filter((run) => run.status === "queued").map((run) => run.agentId));
  const failedAgentIds = unique(
    runs
      .filter((run) => run.status === "failed" || run.status === "interrupted")
      .map((run) => run.agentId),
  );
  return {
    chainId: chain.chainId,
    threadId: chain.threadId,
    state: chainState(chain, runs),
    runs,
    activeAgentIds,
    queuedAgentIds,
    failedAgentIds,
    pendingHolds: [...chain.holds.values()],
    ...(chain.waitingHumanReason ? { waitingHumanReason: chain.waitingHumanReason } : {}),
    voidPassCount: chain.voidPassCount,
    createdAt: chain.createdAt,
    updatedAt: chain.updatedAt,
  };
}

function chainState(chain: MutableChain, runs: CollaborationRunProjection[]): CollaborationChainState {
  if (chain.cancelled) return "cancelled";
  if (chain.resolved) return "completed";
  if (chain.waitingHumanReason) return "waiting-human";
  if (chain.voidPassCount > 0) return "needs-attention";
  if (chain.holds.size > 0) return "waiting-external";
  if (runs.some((run) => run.status === "running")) return "active";
  if (runs.some((run) => run.status === "queued")) return "queued";
  if (runs.some((run) => run.status === "failed" || run.status === "interrupted")) {
    return "needs-attention";
  }
  return runs.length > 0 && runs.every((run) => run.status === "completed")
    ? "completed"
    : "needs-attention";
}

function isRunLifecycleEvent(
  event: StoredPlatformEvent,
): event is Extract<
  StoredPlatformEvent,
  { type: "run.started" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted" }
> {
  return event.type === "run.started" ||
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.interrupted";
}

function isChainSignal(
  event: StoredPlatformEvent,
): event is Extract<
  StoredPlatformEvent,
  { type: "ball.handed_user" | "ball.void_pass" | "task.done" | "ball.cancelled" }
> {
  return event.type === "ball.handed_user" ||
    event.type === "ball.void_pass" ||
    event.type === "task.done" ||
    event.type === "ball.cancelled";
}

function runStatusFromEvent(
  type: "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted",
): RunStatus {
  return type.slice("run.".length) as RunStatus;
}

function deliveryKey(messageId: Id, targetAgentId: Id): string {
  return `${messageId}\u0000${targetAgentId}`;
}

function unique(values: Id[]): Id[] {
  return [...new Set(values)];
}
