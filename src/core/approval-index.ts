import type { Id, PlanDecision, ReviewEscalation, StoredPlatformEvent } from "./types.js";

/**
 * A unified index of everything currently waiting on a human, modelled on
 * clowder-ai's Approval Hub (`docs/features/F246-approval-hub.md`).
 *
 * The problem it exists for is clowder's own: an approval raised inside one
 * thread is invisible to an operator reading another thread, so gates sit
 * unanswered and the work behind them stalls. Its two base invariants carry
 * over unchanged (F246 KD-11):
 *
 * 1. Every operator gate an Agent raises appears in one index, whatever thread
 *    or chain produced it.
 * 2. Every item can point at both the card that decides it and the message that
 *    triggered it. When there is no message to point at, the item says so
 *    (`origin.kind === "event"`) instead of passing a jump to the top of the
 *    thread off as the original — clowder KD-13.
 *
 * It is a projection over the append-only event log, not a second store: the
 * platform, the HTTP API and the UI all read the same facts that drove
 * execution, so an item cannot drift out of sync with the gate it represents.
 */

/**
 * The four ways a chain can stop on a human. They are exactly the reasons
 * `ball.handed_user` already carries, so the index is complete by construction:
 * a gate that does not park the ball on the human is not an operator gate.
 */
export type ApprovalKind =
  /** A finalized plan nobody may execute until the human answers. */
  | "plan-approval"
  /** Peer review stopped short of an approval and needs a human ruling. */
  | "review-escalation"
  /** An Agent is missing an answer that would materially change the work. */
  | "clarification"
  /** A run failed and the chain has no runnable work left. */
  | "runtime-failure";

/**
 * `pending` is waiting; `stale` is waiting *and* old enough that its context
 * may have moved on. Expiry never rejects anything on the human's behalf
 * (F246 KD-5): a stale item asks to be refreshed, not to be dropped.
 */
export type ApprovalStatus = "pending" | "stale" | "settled";

/** Where an item came from, and whether that origin is a message at all. */
export interface ApprovalRef {
  threadId: Id;
  /** The message to open. Absent when the origin is an event, not a message. */
  messageId?: Id;
  /** The run whose card carries the gate. */
  runId?: Id;
  kind: "message" | "event";
}

export interface ApprovalItem {
  /** Stable across the item's life, so a client can track one gate over time. */
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  threadId: Id;
  chainId?: Id;
  /** The gated task run, for the two kinds that have one. */
  taskRunId?: Id;
  /** The Agent that raised the gate. */
  requesterAgentId: Id;
  summary: string;
  detail?: string;
  /**
   * Whether the human can settle it from the index itself. True only for a
   * binary approve/reject gate that carries the fields the decision needs
   * (F246 KD-4); everything else routes to its card, which is where the
   * context to answer it lives.
   */
  inlineApprovable: boolean;
  /** What triggered the gate. */
  origin: ApprovalRef;
  /** Where the gate is answered. */
  card: ApprovalRef;
  requestedAt: string;
  /** When the item's context should be treated as stale. */
  expiresAt?: string;
  settledAt?: string;
  settledBy?: string;
  decision?: PlanDecision;
}

export interface ApprovalIndexOptions {
  /** Restrict to one thread. Omit for the cross-thread index. */
  threadId?: Id;
  /** Evaluation time for staleness. Defaults to now. */
  now?: Date;
  /** How long a pending item stays fresh. Defaults to 24 hours. */
  staleAfterMs?: number;
  /** Include items a human already settled. Defaults to false. */
  includeSettled?: boolean;
}

export const DEFAULT_APPROVAL_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the index says a review escalation is asking of the human. */
const REVIEW_ESCALATION_SUMMARIES: Record<ReviewEscalation, string> = {
  "no-reviewer": "没有第二个 Agent 能审这份交付，需要你把关",
  inconclusive: "审核 Agent 没有登记正式结论，需要你把关",
  "review-failed": "审核没有完成，需要你把关",
  deadlock: "同一条异议多轮没有进展，需要你裁决",
  "max-rounds": "协商到顶仍有阻塞性异议，需要你裁决",
  "clarification-needed": "Agent 需要你先回答一个它自己定不了的问题",
};

interface RunFacts {
  threadId: Id;
  chainId: Id;
  agentId: Id;
  incomingMessageId: Id;
  taskRunId?: Id;
}

interface MessageFacts {
  threadId: Id;
  fromHuman: boolean;
}

/**
 * Rebuild the approval index from the event log.
 *
 * Settlement follows the shape of the gate. A plan approval is binary and is
 * settled only by a recorded decision — a human typing in the thread is not an
 * answer to it. The other three ask for a human's attention rather than a
 * verdict, so the human's next message in that thread is what settles them: the
 * ball is back with the Agents. A cancelled chain settles everything it was
 * holding, because cancellation is an operator action, not an unanswered gate.
 */
export function projectApprovals(
  events: StoredPlatformEvent[],
  options: ApprovalIndexOptions = {},
): ApprovalItem[] {
  const runs = new Map<Id, RunFacts>();
  const messages = new Map<Id, MessageFacts>();
  const items = new Map<string, ApprovalItem>();

  const settleThread = (threadId: Id, at: string, by: string) => {
    for (const item of items.values()) {
      // A plan approval outlives an unrelated human message on purpose: only a
      // recorded decision may consume it.
      if (item.kind === "plan-approval" || item.status === "settled") continue;
      if (item.threadId !== threadId) continue;
      item.status = "settled";
      item.settledAt = at;
      item.settledBy = by;
    }
  };

  for (const event of events) {
    if (event.type === "message.created") {
      messages.set(event.message.id, {
        threadId: event.message.threadId,
        fromHuman: event.message.sender.type === "human",
      });
      if (event.message.sender.type === "human") {
        settleThread(event.message.threadId, event.recordedAt, event.message.sender.id);
      }
      continue;
    }

    if (event.type === "run.queued") {
      runs.set(event.run.id, {
        threadId: event.run.threadId,
        chainId: event.run.causal.chainId,
        agentId: event.run.agentId,
        incomingMessageId: event.run.incomingMessageId,
        ...(event.run.taskRunId ? { taskRunId: event.run.taskRunId } : {}),
      });
      continue;
    }

    if (event.type === "ball.cancelled") {
      for (const item of items.values()) {
        if (item.chainId !== event.chainId || item.status === "settled") continue;
        item.status = "settled";
        item.settledAt = event.recordedAt;
        item.settledBy = "cancelled";
      }
      continue;
    }

    if (event.type === "clarification.requested") {
      const run = runs.get(event.runId);
      const questions = event.questions.map((question) =>
        typeof question === "string" ? question : question.question,
      );
      items.set(`clarification:${event.runId}`, {
        id: `clarification:${event.runId}`,
        kind: "clarification",
        status: "pending",
        threadId: event.threadId,
        ...(run ? { chainId: run.chainId } : {}),
        requesterAgentId: event.agentId,
        summary: `@${event.agentId} 需要你补充关键信息才能继续`,
        ...(questions.length > 0 ? { detail: questions.join("；") } : {}),
        inlineApprovable: false,
        origin: originOf(run, messages, event.threadId),
        card: { threadId: event.threadId, runId: event.runId, kind: "event" },
        requestedAt: event.recordedAt,
      });
      continue;
    }

    if (event.type === "plan.awaiting-approval") {
      const originRun = runs.get(event.taskRunId);
      const id = `plan:${event.taskRunId}`;
      items.set(id, {
        id,
        kind: "plan-approval",
        status: "pending",
        threadId: event.threadId,
        ...(originRun ? { chainId: originRun.chainId } : {}),
        taskRunId: event.taskRunId,
        requesterAgentId: event.authorAgentId,
        summary: event.summary?.trim()
          ? event.summary.trim()
          : `@${event.authorAgentId} 的方案等待你拍板`,
        detail: PLAN_PEER_DETAIL[event.peerOutcome],
        // The decision is binary and the plan text travels with the item, so
        // it can be answered from the index — clowder's inlineMinFields check.
        inlineApprovable: event.plan.trim().length > 0,
        origin: originOf(originRun, messages, event.threadId),
        card: { threadId: event.threadId, runId: event.planRunId, kind: "event" },
        requestedAt: event.recordedAt,
      });
      continue;
    }

    if (event.type === "plan.decided") {
      const item = items.get(`plan:${event.taskRunId}`);
      if (!item) continue;
      item.status = "settled";
      item.settledAt = event.recordedAt;
      item.settledBy = event.decidedBy;
      item.decision = event.decision;
      continue;
    }

    if (event.type === "review.resolved") {
      // A critique that stops short of an approval still reaches the human as
      // the plan-approval item above; indexing it twice would double-count one
      // gate and make the badge lie.
      if (event.outcome !== "escalated" || event.reviewType === "critique") continue;
      const originRun = runs.get(event.taskRunId);
      const id = `review:${event.taskRunId}`;
      items.set(id, {
        id,
        kind: "review-escalation",
        status: "pending",
        threadId: event.threadId,
        ...(originRun ? { chainId: originRun.chainId } : {}),
        taskRunId: event.taskRunId,
        requesterAgentId: originRun?.agentId ?? "unknown",
        // Why the human was called is the first thing they need from the index.
        // "Review did not pass" is true of all of these and useful for none:
        // a deadlock wants a ruling, an unanswered question wants an answer.
        summary: REVIEW_ESCALATION_SUMMARIES[event.escalation ?? "review-failed"],
        ...(event.detail ? { detail: event.detail } : {}),
        inlineApprovable: false,
        origin: originOf(originRun, messages, event.threadId),
        card: { threadId: event.threadId, runId: event.taskRunId, kind: "event" },
        requestedAt: event.recordedAt,
      });
      continue;
    }

    if (event.type === "ball.handed_user" && event.reason === "runtime-failure") {
      const run = runs.get(event.runId);
      const id = `runtime-failure:${event.runId}`;
      items.set(id, {
        id,
        kind: "runtime-failure",
        status: "pending",
        threadId: event.threadId,
        chainId: event.chainId,
        requesterAgentId: run?.agentId ?? "unknown",
        summary: "执行链出现失败，剩余工作没有被标记为完成",
        inlineApprovable: false,
        origin: originOf(run, messages, event.threadId),
        card: { threadId: event.threadId, runId: event.runId, kind: "event" },
        requestedAt: event.recordedAt,
      });
    }
  }

  const staleAfter = options.staleAfterMs ?? DEFAULT_APPROVAL_STALE_AFTER_MS;
  const now = (options.now ?? new Date()).getTime();
  return [...items.values()]
    .filter((item) => !options.threadId || item.threadId === options.threadId)
    .filter((item) => options.includeSettled || item.status !== "settled")
    .map((item) => {
      if (item.status === "settled") return item;
      const expiresAt = new Date(new Date(item.requestedAt).getTime() + staleAfter);
      const expiresAtIso = Number.isNaN(expiresAt.getTime()) ? undefined : expiresAt.toISOString();
      return {
        ...item,
        // Expiry marks context as stale and asks for a refresh. It never
        // rejects: a gate nobody answered is unanswered, not declined.
        ...(expiresAtIso && now > expiresAt.getTime() ? { status: "stale" as const } : {}),
        ...(expiresAtIso ? { expiresAt: expiresAtIso } : {}),
      };
    })
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

/** How many gates are waiting on a human right now — the index badge count. */
export function countPendingApprovals(items: ApprovalItem[]): number {
  return items.filter((item) => item.status !== "settled").length;
}

const PLAN_PEER_DETAIL: Record<"approved" | "escalated" | "skipped", string> = {
  approved: "同伴评审已通过，等待你的最终决定",
  escalated: "同伴评审没有通过，仍交由你判断",
  skipped: "没有同伴评审这份方案（审核门已关闭）",
};

/**
 * The message that triggered the gate. A run's incoming message is the honest
 * anchor: it is what the Agent was actually asked. When the run is unknown —
 * a log truncated before it, or an event with no run behind it — the ref is
 * marked as an event so the UI can say "事件来源" rather than jump somewhere
 * that only looks like the original.
 */
function originOf(
  run: RunFacts | undefined,
  messages: Map<Id, MessageFacts>,
  threadId: Id,
): ApprovalRef {
  if (run && messages.has(run.incomingMessageId)) {
    return { threadId: run.threadId, messageId: run.incomingMessageId, kind: "message" };
  }
  return { threadId, kind: "event" };
}
