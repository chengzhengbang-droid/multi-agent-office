import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectBallCustody,
  type A2ARoutingProjection,
  type PendingBallHold,
} from "../src/core/collaboration.js";

const at = "2026-08-27T00:00:00.000Z";

test("ball custody projects parallel holders and a grounded managed wait", () => {
  const firstRouting: A2ARoutingProjection = {
    mode: "parallel",
    index: 1,
    total: 2,
    batchId: "batch-1",
  };
  let projection = projectBallCustody(undefined, {
    type: "ball.handed",
    threadId: "thread-1",
    chainId: "chain-1",
    holderAgentId: "pi",
    routing: firstRouting,
    recordedAt: at,
  });
  projection = projectBallCustody(projection, {
    type: "ball.handed",
    threadId: "thread-1",
    chainId: "chain-1",
    holderAgentId: "codex",
    routing: { ...firstRouting, index: 2 },
    recordedAt: at,
  });
  assert.deepEqual(projection.holders, ["pi", "codex"]);

  const hold: PendingBallHold = {
    id: "hold-1",
    runId: "run-1",
    threadId: "thread-1",
    chainId: "chain-1",
    agentId: "pi",
    wakeAt: "2026-08-27T00:05:00.000Z",
    waitSourceRef: {
      kind: "ci",
      value: "build-42",
      expectedSignal: "terminal status",
    },
    causal: { chainId: "chain-1", depth: 0 },
  };
  projection = projectBallCustody(projection, { type: "ball.held", hold, recordedAt: at });
  assert.equal(projection.state, "active");
  assert.equal(projection.heldUntil, hold.wakeAt);
  assert.equal(projection.waitingOn?.value, "build-42");

  projection = projectBallCustody(projection, {
    type: "ball.wake_sent",
    threadId: "thread-1",
    chainId: "chain-1",
    agentId: "pi",
    recordedAt: at,
  });
  assert.equal(projection.heldUntil, undefined);
  assert.deepEqual(projection.holders, ["pi"]);
});

test("human handoff parks the ball and task.done resolves it", () => {
  let projection = projectBallCustody(undefined, {
    type: "ball.handed_user",
    threadId: "thread-1",
    chainId: "chain-1",
    recordedAt: at,
  });
  assert.equal(projection.state, "parked");
  projection = projectBallCustody(projection, {
    type: "task.done",
    threadId: "thread-1",
    chainId: "chain-1",
    recordedAt: at,
  });
  assert.equal(projection.state, "resolved");
});
