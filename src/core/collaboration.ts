import type { Id } from "./types.js";

/**
 * Clowder-style structured routing. Inline prose never decides whether work is
 * serial or parallel: the scheduling contract travels with every run.
 */
export type A2ARoutingMode = "serial" | "parallel";

/** The three meanings of a collaboration message. */
export type CollaborationIntent = "handoff" | "fyi" | "done_notify";

export interface A2ARoutingProjection {
  mode: A2ARoutingMode;
  /** One-based position in the real scheduling unit. */
  index: number;
  total: number;
  batchId: Id;
  /** Serial work cannot start until this run reaches a terminal state. */
  predecessorRunId?: Id;
}

export interface WaitSourceRef {
  /** Kind of external condition being polled, for example ci, pr, webhook. */
  kind: string;
  /** Stable external identity, never a natural-language guess. */
  value: string;
  /** The concrete signal that will make the resumed Agent re-check the work. */
  expectedSignal: string;
  /** Optional service-level deadline in ISO-8601 form. */
  slaUntil?: string;
}

export interface PendingBallHold {
  id: Id;
  runId: Id;
  threadId: Id;
  chainId: Id;
  agentId: Id;
  wakeAt: string;
  waitSourceRef: WaitSourceRef;
  causal: {
    chainId: Id;
    parentRunId?: Id;
    depth: number;
  };
}

export type BallState =
  | "new"
  | "active"
  | "blocked"
  | "parked"
  | "dead"
  | "void"
  | "resolved"
  | "cancelled";

export interface BallCustodyProjection {
  threadId: Id;
  chainId: Id;
  state: BallState;
  /** Parallel fan-out may temporarily have more than one legitimate holder. */
  holders: Id[];
  heldUntil?: string;
  waitingOn?: WaitSourceRef;
  lastEventAt: string;
}

export type BallCustodySignal =
  | {
      type: "ball.handed";
      threadId: Id;
      chainId: Id;
      holderAgentId: Id;
      routing: A2ARoutingProjection;
      recordedAt: string;
    }
  | {
      type: "ball.held";
      hold: PendingBallHold;
      recordedAt: string;
    }
  | {
      type: "ball.wake_sent";
      threadId: Id;
      chainId: Id;
      agentId: Id;
      recordedAt: string;
    }
  | {
      type: "ball.handed_user";
      threadId: Id;
      chainId: Id;
      recordedAt: string;
    }
  | {
      type: "ball.void_pass";
      threadId: Id;
      chainId: Id;
      recordedAt: string;
    }
  | {
      type: "invocation.died";
      threadId: Id;
      chainId: Id;
      agentId: Id;
      recordedAt: string;
    }
  | {
      type: "task.done" | "ball.cancelled";
      threadId: Id;
      chainId: Id;
      recordedAt: string;
    };

/**
 * Rebuildable read model over append-only platform events. It intentionally
 * carries no IO so replay and live projection use the same semantics.
 */
export function projectBallCustody(
  current: BallCustodyProjection | undefined,
  event: BallCustodySignal,
): BallCustodyProjection {
  const base: BallCustodyProjection = current ?? {
    threadId: event.type === "ball.held" ? event.hold.threadId : event.threadId,
    chainId: event.type === "ball.held" ? event.hold.chainId : event.chainId,
    state: "new",
    holders: [],
    lastEventAt: event.recordedAt,
  };
  if (event.type === "ball.handed") {
    const holders = event.routing.mode === "parallel"
      ? [...new Set([...base.holders, event.holderAgentId])]
      : [event.holderAgentId];
    return clearWait({ ...base, state: "active", holders, lastEventAt: event.recordedAt });
  }
  if (event.type === "ball.held") {
    return {
      ...base,
      state: "active",
      holders: [event.hold.agentId],
      heldUntil: event.hold.wakeAt,
      waitingOn: event.hold.waitSourceRef,
      lastEventAt: event.recordedAt,
    };
  }
  if (event.type === "ball.wake_sent") {
    return clearWait({
      ...base,
      state: "active",
      holders: [event.agentId],
      lastEventAt: event.recordedAt,
    });
  }
  if (event.type === "ball.handed_user") {
    return clearWait({ ...base, state: "parked", holders: [], lastEventAt: event.recordedAt });
  }
  if (event.type === "ball.void_pass") {
    return clearWait({ ...base, state: "void", holders: [], lastEventAt: event.recordedAt });
  }
  if (event.type === "invocation.died") {
    return clearWait({ ...base, state: "dead", holders: [], lastEventAt: event.recordedAt });
  }
  return clearWait({
    ...base,
    state: event.type === "task.done" ? "resolved" : "cancelled",
    holders: [],
    lastEventAt: event.recordedAt,
  });
}

function clearWait(projection: BallCustodyProjection): BallCustodyProjection {
  const { heldUntil: _heldUntil, waitingOn: _waitingOn, ...rest } = projection;
  return rest;
}
