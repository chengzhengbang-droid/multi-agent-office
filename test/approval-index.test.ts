import assert from "node:assert/strict";
import { test } from "node:test";
import { countPendingApprovals, projectApprovals } from "../src/core/approval-index.js";
import type { AgentRun, StoredPlatformEvent, ThreadMessage } from "../src/core/types.js";

const humanTask: ThreadMessage = {
  id: "msg-task",
  threadId: "thread-1",
  sender: { type: "human", id: "operator" },
  kind: "chat",
  mentions: [],
  content: "请重构缓存层",
  createdAt: "2026-09-01T00:00:00.000Z",
};

const taskRun: AgentRun = {
  id: "run-task",
  threadId: "thread-1",
  agentId: "pi",
  incomingMessageId: "msg-task",
  status: "queued",
  accessMode: "workspace-write",
  causal: { chainId: "chain-1", depth: 0 },
  createdAt: "2026-09-01T00:00:00.000Z",
  purpose: "task",
};

const opened: StoredPlatformEvent[] = [
  stored({ type: "message.created", message: humanTask }, 1),
  stored({ type: "run.queued", run: taskRun }, 2),
];

test("an escalated review becomes a pending item anchored to the original task", () => {
  const items = projectApprovals([
    ...opened,
    stored({
      type: "review.resolved",
      threadId: "thread-1",
      taskRunId: "run-task",
      outcome: "escalated",
      rounds: 2,
      escalation: "max-rounds",
      detail: "双方仍有分歧",
      reviewType: "verify",
    }, 3),
  ], { now: new Date("2026-09-01T00:10:00.000Z") });

  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "review-escalation");
  assert.equal(items[0]?.status, "pending");
  assert.equal(items[0]?.inlineApprovable, false);
  assert.deepEqual(items[0]?.origin, { threadId: "thread-1", messageId: "msg-task", kind: "message" });
  assert.equal(items[0]?.card.runId, "run-task");
  assert.equal(countPendingApprovals(items), 1);
});

test("the human's next message in the thread settles an attention gate", () => {
  const events: StoredPlatformEvent[] = [
    ...opened,
    stored({
      type: "clarification.requested",
      runId: "run-task",
      threadId: "thread-1",
      agentId: "pi",
      questions: ["用哪个缓存后端？"],
    }, 3),
  ];
  assert.equal(projectApprovals(events).length, 1);

  const answered = projectApprovals([
    ...events,
    stored({ type: "message.created", message: { ...humanTask, id: "msg-answer", content: "用 Redis" } }, 4),
  ]);
  assert.deepEqual(answered, []);
});

test("a plan approval survives ordinary chat and is consumed only by a decision", () => {
  const events: StoredPlatformEvent[] = [
    ...opened,
    stored({
      type: "plan.awaiting-approval",
      threadId: "thread-1",
      taskRunId: "run-task",
      planRunId: "run-plan",
      authorAgentId: "pi",
      plan: "1. 抽出缓存接口\n2. 替换调用点",
      summary: "缓存层重构方案",
      peerOutcome: "approved",
      rounds: 1,
      reviewerAgentId: "codex",
    }, 3),
    stored({ type: "message.created", message: { ...humanTask, id: "msg-chat", content: "顺便说一下" } }, 4),
  ];
  const pending = projectApprovals(events);
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, "plan-approval");
  // Binary, and the plan text travels with it, so it can be answered inline.
  assert.equal(pending[0]?.inlineApprovable, true);
  assert.equal(pending[0]?.summary, "缓存层重构方案");

  const decided = projectApprovals([
    ...events,
    stored({
      type: "plan.decided",
      threadId: "thread-1",
      taskRunId: "run-task",
      decision: "approved",
      decidedBy: "operator",
    }, 5),
  ], { includeSettled: true });
  assert.equal(decided[0]?.status, "settled");
  assert.equal(decided[0]?.decision, "approved");
  assert.equal(countPendingApprovals(projectApprovals([...events, stored({
    type: "plan.decided",
    threadId: "thread-1",
    taskRunId: "run-task",
    decision: "approved",
    decidedBy: "operator",
  }, 5)])), 0);
});

test("a critique escalation is indexed once, as the plan the human still has to answer", () => {
  const items = projectApprovals([
    ...opened,
    stored({
      type: "review.resolved",
      threadId: "thread-1",
      taskRunId: "run-task",
      outcome: "escalated",
      rounds: 2,
      escalation: "max-rounds",
      reviewType: "critique",
    }, 3),
    stored({
      type: "plan.awaiting-approval",
      threadId: "thread-1",
      taskRunId: "run-task",
      planRunId: "run-plan",
      authorAgentId: "pi",
      plan: "方案正文",
      peerOutcome: "escalated",
      rounds: 2,
      escalation: "max-rounds",
    }, 4),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.kind, "plan-approval");
});

test("waiting too long marks an item stale and never rejects it", () => {
  const items = projectApprovals([
    ...opened,
    stored({
      type: "plan.awaiting-approval",
      threadId: "thread-1",
      taskRunId: "run-task",
      planRunId: "run-plan",
      authorAgentId: "pi",
      plan: "方案正文",
      peerOutcome: "approved",
      rounds: 1,
    }, 3),
  ], { now: new Date("2026-09-03T00:00:00.000Z"), staleAfterMs: 60 * 60 * 1000 });

  assert.equal(items[0]?.status, "stale");
  assert.notEqual(items[0]?.decision, "rejected");
  assert.equal(typeof items[0]?.expiresAt, "string");
  assert.equal(countPendingApprovals(items), 1);
});

test("an item with no message behind it is marked as an event source, not a fake jump", () => {
  const items = projectApprovals([
    stored({
      type: "ball.handed_user",
      threadId: "thread-9",
      chainId: "chain-9",
      runId: "run-missing",
      reason: "runtime-failure",
    }, 1),
  ]);
  assert.equal(items[0]?.kind, "runtime-failure");
  assert.deepEqual(items[0]?.origin, { threadId: "thread-9", kind: "event" });
  assert.equal(items[0]?.origin.messageId, undefined);
});

test("cancelling a chain settles the gates it was holding", () => {
  const items = projectApprovals([
    ...opened,
    stored({
      type: "clarification.requested",
      runId: "run-task",
      threadId: "thread-1",
      agentId: "pi",
      questions: ["用哪个缓存后端？"],
    }, 3),
    stored({
      type: "ball.cancelled",
      threadId: "thread-1",
      chainId: "chain-1",
      runId: "run-task",
      agentId: "pi",
      reason: "operator cancelled",
    }, 4),
  ]);
  assert.deepEqual(items, []);
});

test("the index spans threads and can still be scoped to one", () => {
  const otherThread: StoredPlatformEvent[] = [
    stored({ type: "message.created", message: { ...humanTask, id: "msg-b", threadId: "thread-2" } }, 5),
    stored({ type: "run.queued", run: { ...taskRun, id: "run-b", threadId: "thread-2", incomingMessageId: "msg-b", causal: { chainId: "chain-2", depth: 0 } } }, 6),
    stored({
      type: "review.resolved",
      threadId: "thread-2",
      taskRunId: "run-b",
      outcome: "escalated",
      rounds: 1,
      escalation: "no-reviewer",
      reviewType: "verify",
    }, 7),
  ];
  const events = [
    ...opened,
    stored({
      type: "clarification.requested",
      runId: "run-task",
      threadId: "thread-1",
      agentId: "pi",
      questions: ["用哪个缓存后端？"],
    }, 3),
    ...otherThread,
  ];
  assert.equal(projectApprovals(events).length, 2);
  assert.equal(projectApprovals(events, { threadId: "thread-2" }).length, 1);
});

type WithoutEventMetadata<T> = T extends unknown ? Omit<T, "eventId" | "recordedAt"> : never;

function stored(
  payload: WithoutEventMetadata<StoredPlatformEvent>,
  order: number,
): StoredPlatformEvent {
  return {
    ...payload,
    eventId: `event-${order}`,
    recordedAt: `2026-09-01T00:00:${String(order).padStart(2, "0")}.000Z`,
  } as StoredPlatformEvent;
}
