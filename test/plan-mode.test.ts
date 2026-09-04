import assert from "node:assert/strict";
import { test } from "node:test";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import { InMemoryEventStore } from "../src/core/event-store.js";
import {
  MultiAgentPlatform,
  type MultiAgentPlatformOptions,
} from "../src/core/platform.js";
import type {
  AgentDefinition,
  AgentRun,
  ReviewVerdict,
  RuntimeAvailability,
  StoredPlatformEvent,
} from "../src/core/types.js";
import type {
  AgentRuntime,
  RuntimeRequest,
  RuntimeResult,
} from "../src/runtime/runtime.js";

// ---------------------------------------------------------------------------
// Plan mode
//
// Plan mode is one pipeline with two gates: a peer critiques the plan, and then
// a human decides whether it is built. The tests below hold the second gate to
// the same standard as the first — nothing passes silently, and no run starts
// on an Agent's or a reviewer's say-so alone.
// ---------------------------------------------------------------------------

test("a plan-mode run is read-only even when its Agent may write", async () => {
  let seen: string | undefined;
  const platform = createPlanPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      seen = request.agent.accessMode;
      assert.equal(request.planMode, true);
      await request.declareDeliverable({ kind: "plan", summary: "先加测试再改实现" });
      return emitOutput(request, "方案：1) 加测试 2) 改实现");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 想想怎么重构解析器", planMode: true });

  // The Agent is configured to write; the run it was given is not.
  assert.equal(seen, "read-only");
  const queued = queuedRuns(await platform.getEvents());
  assert.equal(queued[0]?.mode, "plan");
  assert.equal(queued[0]?.accessMode, "read-only");
});

test("a plan-mode run cannot claim it finished the work", async () => {
  let refusal: string | undefined;
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      const result = await request.declareDeliverable({ kind: "completion", summary: "改完了" });
      refusal = result.reason;
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "方案");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });

  assert.match(refusal ?? "", /plan mode/);
  const declared = (await platform.getEvents()).filter(
    (event) => event.type === "deliverable.declared",
  );
  assert.deepEqual(declared.map((event) => event.kind), ["plan"]);
});

test("plan mode is reviewed as a critique even when the Agent declares nothing", async () => {
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    // No submit_plan call: forgetting the tool must not turn a plan into
    // conversation that nobody reviews.
    codex: async (request) => emitOutput(request, "我建议分三步走"),
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const events = await platform.getEvents();

  assert.equal(single(events, "review.requested").reviewType, "critique");
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("plan mode asks the human before drafting or peer review", async () => {
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      assert.equal(request.planMode, true);
      await request.requestClarification({
        questions: ["这个方案优先优化准确率还是运行成本？"],
      });
      return emitOutput(request, "请先确认：优先优化准确率还是运行成本？");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "clarification.requested"), 1);
  assert.equal(countEvents(events, "review.requested"), 0);
  assert.equal(countEvents(events, "plan.awaiting-approval"), 0);
  assert.equal(queuedRuns(events).length, 1);
});

test("a material question found during plan rework stops the review loop", async () => {
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      if ((request.reviewOf?.round ?? 0) > 0) throw new Error("author runs are not reviewers");
      if (request.incoming.kind === "review-feedback") {
        await request.requestClarification({
          questions: ["数据会跨项目复用吗？这会决定隔离键的设计。"],
        });
        return emitOutput(request, "继续修订前请确认：数据是否会跨项目复用？");
      }
      await request.declareDeliverable({ kind: "plan", summary: "按项目保存经验" });
      return emitOutput(request, "方案：按项目保存经验");
    },
    pi: async (request) => {
      await request.submitReview?.({
        verdict: "changes-requested",
        summary: "隔离范围没有依据",
        findings: ["确认经验是否跨项目复用"],
      });
      return emitOutput(request, "需要修改");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个经验库方案", planMode: true });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.requested"), 1);
  assert.equal(countEvents(events, "clarification.requested"), 1);
  assert.equal(single(events, "review.resolved").escalation, "clarification-needed");
  assert.equal(countEvents(events, "plan.awaiting-approval"), 0);
  assert.equal(queuedRuns(events).length, 3);
});

test("a peer-approved plan waits for the human instead of being executed", async () => {
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "分三步重构" });
      return emitOutput(request, "方案：1) 加测试 2) 改实现 3) 删旧代码");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个重构方案", planMode: true });
  const events = await platform.getEvents();

  const awaiting = single(events, "plan.awaiting-approval");
  assert.equal(awaiting.authorAgentId, "codex");
  assert.equal(awaiting.peerOutcome, "approved");
  assert.equal(awaiting.reviewerAgentId, "pi");
  assert.equal(awaiting.rounds, 1);
  assert.match(awaiting.plan, /删旧代码/);
  // Peer approval settles the critique, not the plan: no execution run exists.
  assert.equal(countEvents(events, "plan.decided"), 0);
  assert.equal(countEvents(events, "ball.handed_user"), 1);
  assert.equal(countEvents(events, "task.done"), 0);
  const taskRuns = queuedRuns(events).filter((run) => run.purpose === "task");
  assert.equal(taskRuns.length, 1);
  const pending = await platform.getPendingPlanApprovals();
  assert.deepEqual(pending.map((approval) => approval.taskRunId), [awaiting.taskRunId]);
});

test("approving a plan starts the work as a normal run that is verified on delivery", async () => {
  const modes: Array<string | undefined> = [];
  const platform = createPlanPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      modes.push(request.planMode ? "plan" : "normal");
      if (request.planMode) {
        await request.declareDeliverable({ kind: "plan", summary: "分三步重构" });
        return emitOutput(request, "方案：分三步");
      }
      await request.declareDeliverable({ kind: "completion", summary: "按方案改完了" });
      return emitOutput(request, "已按方案执行完毕");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个重构方案", planMode: true });
  const awaiting = single(await platform.getEvents(), "plan.awaiting-approval");
  const decision = await platform.decidePlan({
    taskRunId: awaiting.taskRunId,
    decision: "approved",
    note: "第三步先别删，留一个版本",
  });
  await waitForQuiet(platform);
  const events = await platform.getEvents();

  assert.equal(decision.authorAgentId, "codex");
  assert.deepEqual(modes, ["plan", "normal"]);
  const decided = single(events, "plan.decided");
  assert.equal(decided.decision, "approved");
  assert.equal(decided.note, "第三步先别删，留一个版本");
  // The decision is recorded before the follow-up message exists, so a crash
  // between the two cannot resurrect an approval the human already gave.
  const order = events.map((event) => event.type);
  assert.ok(order.indexOf("plan.decided") < order.lastIndexOf("message.created"));

  const followUp = (await platform.getThreadMessages(awaiting.threadId)).find(
    (message) => message.id === decided.followUpMessageId,
  );
  assert.equal(followUp?.sender.type, "human");
  assert.match(followUp?.content ?? "", /approved your plan/);
  assert.match(followUp?.content ?? "", /第三步先别删/);

  // The execution run writes, and is verified rather than critiqued.
  const execution = queuedRuns(events).filter(
    (run) => run.incomingMessageId === decided.followUpMessageId,
  );
  assert.equal(execution.length, 1);
  assert.equal(execution[0]?.mode, undefined);
  assert.equal(execution[0]?.accessMode, "workspace-write");
  const reviewTypes = events
    .filter((event) => event.type === "review.requested")
    .map((event) => (event.type === "review.requested" ? event.reviewType : undefined));
  assert.deepEqual(reviewTypes, ["critique", "verify"]);
});

test("rejecting a plan starts another planning round carrying what the human said", async () => {
  const platform = createPlanPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "分三步重构" });
      return emitOutput(request, "方案：分三步");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个重构方案", planMode: true });
  const first = single(await platform.getEvents(), "plan.awaiting-approval");
  await platform.decidePlan({
    taskRunId: first.taskRunId,
    decision: "rejected",
    note: "没有回滚方案，重来",
  });
  await waitForQuiet(platform);
  const events = await platform.getEvents();

  const decided = single(events, "plan.decided");
  assert.equal(decided.decision, "rejected");
  const revision = queuedRuns(events).filter(
    (run) => run.incomingMessageId === decided.followUpMessageId,
  );
  // A rejection is more planning, not building: the revision stays read-only.
  assert.equal(revision.length, 1);
  assert.equal(revision[0]?.mode, "plan");
  assert.equal(revision[0]?.accessMode, "read-only");
  const followUp = (await platform.getThreadMessages(first.threadId)).find(
    (message) => message.id === decided.followUpMessageId,
  );
  assert.match(followUp?.content ?? "", /没有回滚方案/);
  assert.match(followUp?.content ?? "", /do not start building/);
  // The revised plan comes back to the human rather than passing on its own.
  const awaiting = events.filter((event) => event.type === "plan.awaiting-approval");
  assert.equal(awaiting.length, 2);
  assert.notEqual(awaiting[1]?.taskRunId, first.taskRunId);
});

test("a critique rework round is still planning, so it still cannot write", async () => {
  const verdicts: ReviewVerdict[] = ["changes-requested", "approved"];
  const access: Array<string | undefined> = [];
  const platform = createPlanPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      access.push(request.agent.accessMode);
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "方案");
    },
    pi: async (request) => {
      await request.submitReview?.({
        verdict: verdicts.shift() ?? "approved",
        summary: "回滚路径没写清楚",
        findings: ["补上回滚方案"],
        checks: ["逐条对照了原始任务与方案步骤"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });

  // "Address these findings" must not become "build it".
  assert.deepEqual(access, ["read-only", "read-only"]);
  const rework = queuedRuns(await platform.getEvents()).filter((run) => run.reviewRound === 1 && run.purpose === "task");
  assert.equal(rework[0]?.mode, "plan");
  assert.equal(rework[0]?.accessMode, "read-only");
});

test("a rejection without a reason is refused rather than sent back empty", async () => {
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "方案");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const awaiting = single(await platform.getEvents(), "plan.awaiting-approval");

  await assert.rejects(
    () => platform.decidePlan({ taskRunId: awaiting.taskRunId, decision: "rejected" }),
    /说明需要改什么/,
  );
  assert.equal(countEvents(await platform.getEvents(), "plan.decided"), 0);
});

test("a plan can only be decided once", async () => {
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "方案");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const awaiting = single(await platform.getEvents(), "plan.awaiting-approval");
  await platform.decidePlan({ taskRunId: awaiting.taskRunId, decision: "approved" });

  await assert.rejects(
    () => platform.decidePlan({ taskRunId: awaiting.taskRunId, decision: "approved" }),
    /不在等待人工确认/,
  );
  await waitForQuiet(platform);
  assert.equal(countEvents(await platform.getEvents(), "plan.decided"), 1);
});

test("a plan the peer would not approve still reaches the human, labelled as such", async () => {
  const verdicts: ReviewVerdict[] = ["changes-requested", "changes-requested"];
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "方案第 N 版");
    },
    pi: async (request) => {
      await request.submitReview?.({
        verdict: verdicts.shift() ?? "changes-requested",
        summary: "回滚路径还是没写清楚",
        findings: ["补上回滚方案"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const events = await platform.getEvents();

  // The same objection twice over is a stall, and a stall is what a real
  // disagreement looks like — not a spent round budget.
  assert.equal(single(events, "review.resolved").escalation, "deadlock");
  const awaiting = single(events, "plan.awaiting-approval");
  // An escalation is exactly when a human is needed, so the plan is handed
  // over with the peer's doubt attached rather than dropped on the floor.
  assert.equal(awaiting.peerOutcome, "escalated");
  assert.equal(awaiting.escalation, "deadlock");
  assert.equal(awaiting.peerSummary, "回滚路径还是没写清楚");
  assert.match(awaiting.plan, /方案第 N 版/);
});

test("with no peer to critique it, a plan goes straight to the human", async () => {
  const platform = createPlanPlatform([agent("codex")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "独立方案");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const events = await platform.getEvents();

  assert.equal(single(events, "review.resolved").escalation, "no-reviewer");
  const awaiting = single(events, "plan.awaiting-approval");
  assert.equal(awaiting.peerOutcome, "escalated");
  assert.equal(awaiting.escalation, "no-reviewer");
});

test("with the review gate off, a plan still stops at the human", async () => {
  const platform = createPlanPlatform(
    [agent("codex"), agent("pi")],
    {
      codex: async (request) => {
        await request.declareDeliverable({ kind: "plan", summary: "方案" });
        return emitOutput(request, "方案");
      },
    },
    { reviewMode: "off" },
  );

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const events = await platform.getEvents();

  // Turning the peer gate off removes the peer, not the person: plan mode is
  // something the human asked for by name.
  assert.equal(countEvents(events, "review.requested"), 0);
  const awaiting = single(events, "plan.awaiting-approval");
  assert.equal(awaiting.peerOutcome, "skipped");
  assert.equal(awaiting.rounds, 0);
});

test("a plan-mode message never steers an in-flight writing run", async () => {
  const platform = createPlanPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      if (request.planMode) {
        await request.declareDeliverable({ kind: "plan", summary: "方案" });
        return emitOutput(request, "方案");
      }
      return emitOutput(request, "在干活");
    },
    pi: approving(),
  });

  await platform.postUserMessage({ content: "@codex 先做点别的" });
  await platform.postUserMessage({ content: "@codex 现在出个方案", planMode: true, steer: true });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "run.steered"), 0);
  const planRuns = queuedRuns(events).filter((run) => run.mode === "plan");
  assert.equal(planRuns.length, 1);
});

test("a decided plan replays as decided rather than waiting all over again", async () => {
  const store = new InMemoryEventStore();
  const agents = [agent("codex"), agent("pi")];
  const handlers = {
    codex: async (request: RuntimeRequest) => {
      await request.declareDeliverable({
        kind: request.planMode ? "plan" : "completion",
        summary: "方案",
      });
      return emitOutput(request, "方案");
    },
    pi: approving(),
  };
  const first = createPlanPlatform(agents, handlers, { eventStore: store });
  await first.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const awaiting = single(await first.getEvents(), "plan.awaiting-approval");
  await first.decidePlan({ taskRunId: awaiting.taskRunId, decision: "approved" });
  await waitForQuiet(first);

  const restarted = createPlanPlatform(agents, handlers, { eventStore: store });
  assert.deepEqual(await restarted.getPendingPlanApprovals(), []);
  await assert.rejects(
    () => restarted.decidePlan({ taskRunId: awaiting.taskRunId, decision: "rejected", note: "再来" }),
    /不在等待人工确认/,
  );
});

test("a plan awaiting approval survives a restart so the human can still answer", async () => {
  const store = new InMemoryEventStore();
  const agents = [agent("codex"), agent("pi")];
  const handlers = {
    codex: async (request: RuntimeRequest) => {
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "重启前写好的方案");
    },
    pi: approving(),
  };
  const first = createPlanPlatform(agents, handlers, { eventStore: store });
  await first.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const awaiting = single(await first.getEvents(), "plan.awaiting-approval");

  const restarted = createPlanPlatform(agents, handlers, { eventStore: store });
  const pending = await restarted.getPendingPlanApprovals();
  assert.deepEqual(pending.map((approval) => approval.taskRunId), [awaiting.taskRunId]);
  assert.match(pending[0]?.plan ?? "", /重启前写好的方案/);
  const decision = await restarted.decidePlan({
    taskRunId: awaiting.taskRunId,
    decision: "approved",
  });
  assert.equal(decision.decision, "approved");
});

test("a pre-plan-mode event log replays without inventing an approval to wait on", async () => {
  const store = new InMemoryEventStore();
  const platform = createPlanPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "旧日志里的方案" });
      return emitOutput(request, "方案");
    },
    pi: approving(),
  }, { eventStore: store });

  await platform.postUserMessage({ content: "@codex 出个方案" });
  const events = await platform.getEvents();

  // The Agent declared a plan without the human asking for plan mode. That is
  // the old critique path, and it ends where it always did.
  assert.equal(single(events, "review.resolved").outcome, "approved");
  assert.equal(countEvents(events, "plan.awaiting-approval"), 1);
  // ...but the plan gate is the same gate, so the plan still reaches a person
  // rather than being treated as delivered work.
  assert.equal(single(events, "plan.awaiting-approval").peerOutcome, "approved");
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const available: RuntimeAvailability = { available: true, label: "test" };

function createPlanPlatform(
  agents: AgentDefinition[],
  handlers: Record<string, (request: RuntimeRequest) => Promise<RuntimeResult>>,
  options: Partial<MultiAgentPlatformOptions> = {},
): MultiAgentPlatform {
  return new MultiAgentPlatform({
    agents,
    defaultAgentId: agents[0]!.id,
    runtimes: new Map(
      agents.map((definition) => [
        definition.id,
        runtime(definition.id, handlers[definition.id] ?? echo),
      ]),
    ),
    eventStore: new InMemoryEventStore(),
    contextCompiler: new RecentContextCompiler(),
    reviewMode: "smart",
    ...options,
  });
}

function agent(id: string, accessMode: AgentDefinition["accessMode"] = "read-only"): AgentDefinition {
  return {
    id,
    displayName: id.toUpperCase(),
    description: `${id} test peer`,
    systemPrompt: "Act as a peer.",
    capabilities: ["testing"],
    enabled: true,
    accessMode,
    runtime: id === "codex"
      ? { kind: "codex", command: "codex" }
      : { kind: "pi", provider: "test", model: "test", thinkingLevel: "off" },
  };
}

function runtime(
  id: string,
  handler: (request: RuntimeRequest) => Promise<RuntimeResult>,
): AgentRuntime {
  return {
    id,
    availability: available,
    async execute(request) {
      await request.emit({
        type: "session",
        runtimeKind: request.agent.runtime.kind,
        resumed: false,
      });
      return handler(request);
    },
    async cancel() {},
  };
}

/** A reviewer that approves whatever it is handed. */
function approving(): (request: RuntimeRequest) => Promise<RuntimeResult> {
  return async (request) => {
    await request.submitReview?.({
      verdict: "approved",
      summary: "方案读过了，可以照做",
      checks: ["逐条对照了原始任务与方案步骤"],
    });
    return emitOutput(request, "审毕");
  };
}

async function echo(request: RuntimeRequest): Promise<RuntimeResult> {
  return emitOutput(request, `${request.agent.id}: ${request.incoming.content}`);
}

async function emitOutput(request: RuntimeRequest, output: string): Promise<RuntimeResult> {
  await request.emit({ type: "text_delta", text: output });
  return { output };
}

function single<T extends StoredPlatformEvent["type"]>(
  events: StoredPlatformEvent[],
  type: T,
): Extract<StoredPlatformEvent, { type: T }> {
  const matches = events.filter(
    (event): event is Extract<StoredPlatformEvent, { type: T }> => event.type === type,
  );
  assert.equal(matches.length, 1, `expected exactly one ${type} event, got ${matches.length}`);
  return matches[0]!;
}

function queuedRuns(events: StoredPlatformEvent[]): AgentRun[] {
  return events
    .filter((event): event is Extract<StoredPlatformEvent, { type: "run.queued" }> => event.type === "run.queued")
    .map((event) => event.run);
}

function countEvents(events: StoredPlatformEvent[], type: StoredPlatformEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

/** decidePlan starts a chain it does not await; this waits for it to drain. */
async function waitForQuiet(platform: MultiAgentPlatform): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const events = await platform.getEvents();
    const queued = events.filter((event) => event.type === "run.queued").length;
    const finished = events.filter(
      (event) =>
        event.type === "run.completed" ||
        event.type === "run.failed" ||
        event.type === "run.cancelled" ||
        event.type === "run.interrupted",
    ).length;
    if (queued > 0 && queued === finished) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("runs did not settle in time");
}
