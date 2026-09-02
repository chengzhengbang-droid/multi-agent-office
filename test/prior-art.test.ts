import assert from "node:assert/strict";
import { test } from "node:test";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import { InMemoryEventStore } from "../src/core/event-store.js";
import {
  MultiAgentPlatform,
  type MultiAgentPlatformOptions,
} from "../src/core/platform.js";
import {
  mergePriorArt,
  priorArtCritiqueBrief,
  summarizePriorArt,
  validatePriorArt,
  type PriorArtEntry,
  type PriorArtLedger,
} from "../src/core/prior-art.js";
import type {
  AgentDefinition,
  RuntimeAvailability,
  StoredPlatformEvent,
} from "../src/core/types.js";
import type {
  AgentRuntime,
  RuntimeRequest,
  RuntimeResult,
} from "../src/runtime/runtime.js";

// ---------------------------------------------------------------------------
// Prior art in plan mode
//
// The platform never decides which plans deserve a look at how others solved
// the problem — it cannot read that intent, and a guessed expectation is worse
// than none. What it does enforce is that a recorded precedent can be checked,
// and that whether one was recorded at all reaches both the critique reviewer
// and the human instead of quietly evaporating.
// ---------------------------------------------------------------------------

const CHECKED_ENTRY: PriorArtEntry = {
  source: "github.com/example/router",
  sourceKind: "source",
  claim: "它把路由决策放在纯函数里，调度器只消费结果",
  verdict: "adopt",
  checked: "读了 src/routing/match.ts，确认没有 IO",
};

test("adopting a precedent requires a firsthand look, not its README", () => {
  const marketing = validatePriorArt({
    entries: [{ ...CHECKED_ENTRY, sourceKind: "marketing", checked: "读了 README 的架构章节" }],
  });
  assert.equal(marketing.ok, false);
  assert.match(marketing.ok ? "" : marketing.reason, /firsthand look/);

  const secondhand = validatePriorArt({
    entries: [{ ...CHECKED_ENTRY, sourceKind: "secondhand", checked: "看了一篇解析文章" }],
  });
  assert.equal(secondhand.ok, false);

  // The same source is a perfectly good entry once the verdict matches how
  // deeply it was actually read.
  const downgraded = validatePriorArt({
    entries: [
      {
        ...withoutChecked(CHECKED_ENTRY),
        sourceKind: "marketing",
        verdict: "adapt",
        tradeoff: "自述没写并发模型，我们这里必须单写者，所以只借形状",
      },
    ],
  });
  assert.equal(downgraded.ok, true);
});

test("adopting requires naming what was checked, the way an approval does", () => {
  const unchecked = validatePriorArt({ entries: [withoutChecked(CHECKED_ENTRY)] });
  assert.equal(unchecked.ok, false);
  assert.match(unchecked.ok ? "" : unchecked.reason, /checked/);

  assert.equal(validatePriorArt({ entries: [CHECKED_ENTRY] }).ok, true);
});

test("declining to copy a precedent requires the tradeoff, so the next round is not the same round", () => {
  for (const verdict of ["adapt", "reject"] as const) {
    const result = validatePriorArt({
      entries: [{ ...withoutChecked(CHECKED_ENTRY), verdict }],
    });
    assert.equal(result.ok, false, `${verdict} without tradeoff must be refused`);
    assert.match(result.ok ? "" : result.reason, /tradeoff/);
  }

  const withReason = validatePriorArt({
    entries: [
      {
        source: "clowder-ai",
        sourceKind: "source",
        claim: "它用 Redis 做跨进程队列租约",
        verdict: "reject",
        tradeoff: "本项目是单机对等工作台，引入 Redis 只增加运维面，不换来能力",
      },
    ],
  });
  assert.equal(withReason.ok, true);
});

test("finding nothing is an answer, but only with a reason attached", () => {
  const empty = validatePriorArt({ entries: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.ok ? "" : empty.reason, /abstained/);

  const abstained = validatePriorArt({ abstained: "这一层是本项目事件日志特有的，没有可比先例" });
  assert.equal(abstained.ok, true);
  assert.deepEqual(abstained.ok ? abstained.entries : undefined, []);

  // Recording both would leave the outcome ambiguous on the approval card.
  const both = validatePriorArt({ entries: [CHECKED_ENTRY], abstained: "没查" });
  assert.equal(both.ok, false);
});

test("a revision corrects its own earlier verdict instead of stacking a second one", () => {
  const first = ledger([{ ...CHECKED_ENTRY, verdict: "adopt" }]);
  const second = ledger([
    {
      ...withoutChecked(CHECKED_ENTRY),
      verdict: "adapt",
      tradeoff: "同侪指出它假设单线程，我们这里不是",
    },
  ]);

  const merged = mergePriorArt(first, second);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0]?.verdict, "adapt");
});

test("an abstention stops being true once a later round examines something", () => {
  const abstained: PriorArtLedger = {
    ...ledger([]),
    outcome: "abstained",
    abstainedReason: "当时没找到可比的",
  };
  const merged = mergePriorArt(abstained, ledger([CHECKED_ENTRY]));

  assert.equal(merged.outcome, "recorded");
  assert.equal(merged.abstainedReason, undefined);
});

test("the critique brief names all three states, including the silent one", () => {
  const none = priorArtCritiqueBrief(summarizePriorArt(undefined)).join("\n");
  assert.match(none, /recorded no prior art/);

  const abstained = priorArtCritiqueBrief(
    summarizePriorArt({ ...ledger([]), outcome: "abstained", abstainedReason: "没有可比先例" }),
  ).join("\n");
  assert.match(abstained, /没有可比先例/);
  assert.match(abstained, /Judge the reason/);

  // A ledger resting on marketing is reported as such, so the reviewer knows
  // which entries are load-bearing and which are repeated pitches.
  const thin = priorArtCritiqueBrief(
    summarizePriorArt(
      ledger([
        CHECKED_ENTRY,
        {
          source: "example.com/blog",
          sourceKind: "marketing",
          claim: "宣称零拷贝",
          verdict: "reject",
          tradeoff: "没有实现可读，无法验证",
        },
      ]),
    ),
  ).join("\n");
  assert.match(thin, /2 examined precedent/);
  assert.match(thin, /1 of them rest on the project's own pitch/);
});

test("prior art belongs to plan mode and to the author, not to a reviewer or an executor", async () => {
  const refusals: string[] = [];
  const platform = createPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      const result = await request.recordPriorArt({ entries: [CHECKED_ENTRY] });
      if (!result.accepted) refusals.push(result.reason ?? "");
      await request.declareDeliverable({ kind: "completion", summary: "改完了" });
      return emitOutput(request, "做完了");
    },
    pi: async (request) => {
      const result = await request.recordPriorArt({ entries: [CHECKED_ENTRY] });
      if (!result.accepted) refusals.push(result.reason ?? "");
      await request.submitReview?.({
        verdict: "approved",
        summary: "核对过了",
        checks: ["打开了它说改过的文件"],
      });
      return emitOutput(request, "审毕");
    },
  });

  // No planMode: this is ordinary execution, where the approach is already set.
  await platform.postUserMessage({ content: "@codex 把解析器改了" });

  assert.equal(refusals.length, 2);
  assert.match(refusals[0] ?? "", /plan mode/);
  assert.match(refusals[1] ?? "", /reviewer/);
  assert.equal(
    (await platform.getEvents()).filter((event) => event.type === "prior-art.recorded").length,
    0,
  );
});

test("a recorded ledger reaches the critique reviewer and the human's approval card", async () => {
  let brief = "";
  const platform = createPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.recordPriorArt({
        entries: [
          CHECKED_ENTRY,
          {
            source: "clowder-ai",
            sourceKind: "source",
            claim: "它把调研做成按需 skill，不做计划前置门禁",
            verdict: "adapt",
            tradeoff: "我们没有 operator 语义信号，改成留痕而不是判定该不该查",
          },
        ],
      });
      await request.declareDeliverable({ kind: "plan", summary: "照 clowder 的口径落一层留痕" });
      return emitOutput(request, "方案：先加纯模块，再接平台");
    },
    pi: async (request) => {
      brief = request.incoming.content;
      assert.equal(request.reviewOf?.priorArt?.outcome, "recorded");
      assert.equal(request.reviewOf?.priorArt?.examined, 2);
      await request.submitReview?.({
        verdict: "approved",
        summary: "先例读过了",
        checks: ["自己打开了 clowder 的 reviewer-matcher 对照"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });

  // The reviewer is told what the author read, and told it is a claim.
  assert.match(brief, /2 examined precedent/);
  assert.match(brief, /not established fact/);

  const events = await platform.getEvents();
  const recorded = events.filter((event) => event.type === "prior-art.recorded");
  assert.equal(recorded.length, 1);

  const [approval] = await platform.getPendingPlanApprovals();
  assert.equal(approval?.priorArt?.outcome, "recorded");
  assert.equal(approval?.priorArt?.entries.length, 2);
  assert.equal(approval?.priorArt?.entries[1]?.verdict, "adapt");
});

test("saying nothing about prior art does not block the plan, but the card and the brief say so", async () => {
  let brief = "";
  const platform = createPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "直接开干" });
      return emitOutput(request, "方案：照我想的做");
    },
    pi: async (request) => {
      brief = request.incoming.content;
      assert.equal(request.reviewOf?.priorArt?.outcome, "none");
      await request.submitReview?.({
        verdict: "approved",
        summary: "读过了",
        checks: ["对照了原始任务"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });

  // Advisory, not a gate: the plan still reaches the human.
  const [approval] = await platform.getPendingPlanApprovals();
  assert.ok(approval, "the plan must still reach the human");
  assert.equal(approval?.priorArt, undefined);
  assert.match(brief, /recorded no prior art/);
});

test("an abstention travels with its reason instead of looking like silence", async () => {
  const platform = createPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      const result = await request.recordPriorArt({
        abstained: "这条事件日志的重建语义是本项目独有的，没有可比先例",
      });
      assert.equal(result.accepted, true);
      await request.declareDeliverable({ kind: "plan", summary: "重建投影" });
      return emitOutput(request, "方案");
    },
    pi: async (request) => {
      assert.equal(request.reviewOf?.priorArt?.outcome, "abstained");
      await request.submitReview?.({
        verdict: "approved",
        summary: "理由成立",
        checks: ["自己搜了一遍确实没有同型实现"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });

  const [approval] = await platform.getPendingPlanApprovals();
  assert.equal(approval?.priorArt?.outcome, "abstained");
  assert.match(approval?.priorArt?.abstainedReason ?? "", /没有可比先例/);
});

test("the ledger survives a critique round that revises the plan", async () => {
  let round = 0;
  const platform = createPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      round += 1;
      if (round === 1) {
        await request.recordPriorArt({ entries: [CHECKED_ENTRY] });
      }
      // The second round revises the plan without re-listing what it read.
      await request.declareDeliverable({ kind: "plan", summary: `第 ${round} 版` });
      return emitOutput(request, `方案第 ${round} 版`);
    },
    pi: async (request) => {
      const verdict = (request.reviewOf?.round ?? 1) === 1 ? "changes-requested" : "approved";
      await request.submitReview?.({
        verdict,
        summary: verdict === "approved" ? "这版可以" : "第三步没论证",
        ...(verdict === "approved" ? { checks: ["逐条对照了方案与原始任务"] } : { findings: ["第三步的失败路径没写"] }),
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  await waitForQuiet(platform);

  assert.ok(round >= 2, "the critique must have opened a second round");
  const [approval] = await platform.getPendingPlanApprovals();
  assert.equal(approval?.priorArt?.entries.length, 1);
});

test("a replayed log rebuilds the same ledger on the approval card", async () => {
  const eventStore = new InMemoryEventStore();
  const agents = [agent("codex"), agent("pi")];
  const platform = createPlatform(agents, {
    codex: async (request) => {
      await request.recordPriorArt({ entries: [CHECKED_ENTRY] });
      await request.declareDeliverable({ kind: "plan", summary: "方案" });
      return emitOutput(request, "方案正文");
    },
    pi: async (request) => {
      await request.submitReview?.({
        verdict: "approved",
        summary: "可以",
        checks: ["对照了原始任务"],
      });
      return emitOutput(request, "审毕");
    },
  }, { eventStore });

  await platform.postUserMessage({ content: "@codex 出个方案", planMode: true });
  const live = await platform.getPendingPlanApprovals();

  const replayed = createPlatform(agents, {}, { eventStore });
  await replayed.initialize();

  assert.deepEqual(
    (await replayed.getPendingPlanApprovals())[0]?.priorArt,
    live[0]?.priorArt,
  );
});

// ---------------------------------------------------------------------------

/** exactOptionalPropertyTypes: dropping the key is not the same as setting undefined. */
function withoutChecked(entry: PriorArtEntry): PriorArtEntry {
  const { checked: _checked, ...rest } = entry;
  return rest;
}

function ledger(entries: PriorArtEntry[]): PriorArtLedger {
  return {
    taskRunId: "run-1",
    authorAgentId: "codex",
    outcome: entries.length > 0 ? "recorded" : "abstained",
    entries,
    recordedAt: new Date().toISOString(),
  };
}

function createPlatform(
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

function agent(id: string): AgentDefinition {
  return {
    id,
    displayName: id.toUpperCase(),
    description: `${id} test peer`,
    systemPrompt: "Act as a peer.",
    capabilities: ["testing"],
    enabled: true,
    accessMode: "read-only",
    runtime: id === "codex"
      ? { kind: "codex", command: "codex" }
      : { kind: "pi", provider: "test", model: "test", thinkingLevel: "off" },
  };
}

const available: RuntimeAvailability = { available: true, label: "test" };

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

async function echo(request: RuntimeRequest): Promise<RuntimeResult> {
  return emitOutput(request, `${request.agent.id}: ${request.incoming.content}`);
}

async function emitOutput(request: RuntimeRequest, output: string): Promise<RuntimeResult> {
  await request.emit({ type: "text_delta", text: output });
  return { output };
}

/** Discussion rounds queue runs the caller does not await; this drains them. */
async function waitForQuiet(platform: MultiAgentPlatform): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const events: StoredPlatformEvent[] = await platform.getEvents();
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
