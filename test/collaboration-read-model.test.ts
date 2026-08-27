import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectCollaborationChains,
  projectHandoffDeliveries,
} from "../src/core/collaboration-read-model.js";
import type { AgentRun, StoredPlatformEvent } from "../src/core/types.js";

const baseRun: AgentRun = {
  id: "run-a",
  threadId: "thread-1",
  agentId: "pi",
  incomingMessageId: "handoff-1",
  status: "queued",
  accessMode: "read-only",
  causal: { chainId: "chain-1", depth: 0 },
  createdAt: "2026-08-27T00:00:00.000Z",
  purpose: "task",
};

test("collaboration read model keeps a mixed parallel result in needs-attention", () => {
  const sibling: AgentRun = {
    ...baseRun,
    id: "run-b",
    agentId: "codex",
    routing: { mode: "parallel", index: 2, total: 2, batchId: "batch-1" },
  };
  const events: StoredPlatformEvent[] = [
    stored({ type: "run.queued", run: {
      ...baseRun,
      routing: { mode: "parallel", index: 1, total: 2, batchId: "batch-1" },
    } }, 1),
    stored({ type: "run.queued", run: sibling }, 2),
    stored({ type: "run.started", runId: "run-a", threadId: "thread-1", agentId: "pi" }, 3),
    stored({ type: "run.started", runId: "run-b", threadId: "thread-1", agentId: "codex" }, 4),
    stored({ type: "run.failed", runId: "run-a", threadId: "thread-1", agentId: "pi", error: "boom" }, 5),
    stored({ type: "run.completed", runId: "run-b", threadId: "thread-1", agentId: "codex", output: "ok" }, 6),
  ];

  const chain = projectCollaborationChains(events)[0];
  assert.equal(chain?.state, "needs-attention");
  assert.deepEqual(chain?.failedAgentIds, ["pi"]);
  assert.equal(chain?.runs.find((run) => run.runId === "run-b")?.status, "completed");
});

test("collaboration read model distinguishes external and human waits", () => {
  const hold = {
    id: "hold-1",
    runId: "run-a",
    threadId: "thread-1",
    chainId: "chain-1",
    agentId: "pi",
    wakeAt: "2026-08-27T00:05:00.000Z",
    waitSourceRef: { kind: "ci", value: "build-1", expectedSignal: "terminal" },
    causal: { chainId: "chain-1", depth: 0 },
  };
  const events: StoredPlatformEvent[] = [
    stored({ type: "run.queued", run: baseRun }, 1),
    stored({ type: "run.completed", runId: "run-a", threadId: "thread-1", agentId: "pi", output: "waiting" }, 2),
    stored({ type: "ball.held", hold }, 3),
  ];
  assert.equal(projectCollaborationChains(events)[0]?.state, "waiting-external");

  events.push(stored({
    type: "ball.handed_user",
    threadId: "thread-1",
    chainId: "chain-1",
    runId: "run-a",
    reason: "clarification",
  }, 4));
  const chain = projectCollaborationChains(events)[0];
  assert.equal(chain?.state, "waiting-human");
  assert.equal(chain?.waitingHumanReason, "clarification");
});

test("handoff delivery receipts follow each target run to its terminal status", () => {
  const events: StoredPlatformEvent[] = [
    stored({
      type: "routing.accepted",
      runId: "source-run",
      threadId: "thread-1",
      messageId: "handoff-1",
      targetAgentId: "pi",
      idempotencyKey: "source-run:key",
    }, 1),
    stored({ type: "run.queued", run: baseRun }, 2),
    stored({ type: "run.started", runId: "run-a", threadId: "thread-1", agentId: "pi" }, 3),
    stored({ type: "run.completed", runId: "run-a", threadId: "thread-1", agentId: "pi", output: "done" }, 4),
  ];

  const delivery = projectHandoffDeliveries(events)[0];
  assert.equal(delivery?.messageId, "handoff-1");
  assert.equal(delivery?.runId, "run-a");
  assert.equal(delivery?.status, "completed");
});

type WithoutEventMetadata<T> = T extends unknown
  ? Omit<T, "eventId" | "recordedAt">
  : never;

function stored(
  payload: WithoutEventMetadata<StoredPlatformEvent>,
  order: number,
): StoredPlatformEvent {
  return {
    ...payload,
    eventId: `event-${order}`,
    recordedAt: `2026-08-27T00:00:${String(order).padStart(2, "0")}.000Z`,
  } as StoredPlatformEvent;
}
