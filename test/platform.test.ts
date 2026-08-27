import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import { InMemoryEventStore } from "../src/core/event-store.js";
import {
  MultiAgentPlatform,
  type MultiAgentPlatformOptions,
} from "../src/core/platform.js";
import type {
  AccessMode,
  AgentDefinition,
  ReviewVerdict,
  RuntimeAvailability,
  StoredPlatformEvent,
} from "../src/core/types.js";
import type {
  AgentRuntime,
  ReviewAssignment,
  RuntimeRequest,
  RuntimeResult,
} from "../src/runtime/runtime.js";

const available: RuntimeAvailability = { available: true, label: "test" };

test("routes one user message to two peer Agents without a boss", async () => {
  const calls: string[] = [];
  const platform = createPlatform(
    [agent("pi"), agent("codex")],
    new Map([
      ["pi", runtime("pi", async (request) => recordOutput(request, calls))],
      ["codex", runtime("codex", async (request) => recordOutput(request, calls))],
    ]),
  );

  const result = await platform.postUserMessage({
    content: "请 @pi 和 @codex 独立判断这个方案",
  });
  const events = await platform.getEvents();
  const messages = await platform.getThreadMessages(result.threadId);

  assert.deepEqual(calls.sort(), ["codex", "pi"]);
  assert.equal(countEvents(events, "run.completed"), 2);
  assert.deepEqual(messages[0]?.mentions.sort(), ["codex", "pi"]);
  assert.ok(result.chainId.startsWith("chain_"));
});

test("uses the default Agent and then the most recent successful responder", async () => {
  const platform = createPlatform(
    [agent("pi"), agent("codex")],
    new Map([
      ["pi", runtime("pi", echo)],
      ["codex", runtime("codex", echo)],
    ]),
    "codex",
  );

  const first = await platform.postUserMessage({ content: "没有显式 mention" });
  await platform.postUserMessage({ content: "@pi 接手", threadId: first.threadId });
  await platform.postUserMessage({ content: "继续", threadId: first.threadId });
  const queued = (await platform.getEvents()).filter(
    (event): event is Extract<StoredPlatformEvent, { type: "run.queued" }> =>
      event.type === "run.queued",
  );
  assert.deepEqual(queued.map((event) => event.run.agentId), ["codex", "pi", "pi"]);
});

test("only structured post_message wakes another Agent", async () => {
  const platform = createPlatform(
    [agent("pi"), agent("codex")],
    new Map([
      [
        "pi",
        runtime("pi", async (request) => {
          await request.postMessage({
            content: "@codex\n请独立审查。",
            intent: "review",
            idempotencyKey: "review-once",
          });
          return emitOutput(request, "普通最终输出也写 @codex，但它不能再次触发。");
        }),
      ],
      ["codex", runtime("codex", echo)],
    ]),
  );

  const { threadId } = await platform.postUserMessage({ content: "@pi 开始" });
  const events = await platform.getEvents();
  const messages = await platform.getThreadMessages(threadId);
  assert.equal(countEvents(events, "run.completed"), 2);
  assert.equal(countEvents(events, "routing.accepted"), 1);
  const handoff = messages.find((message) => message.kind === "collaboration");
  assert.deepEqual(handoff?.mentions, ["codex"]);
});

test("does not parse ordinary final output mentions", async () => {
  const platform = createPlatform(
    [agent("pi"), agent("codex")],
    new Map([
      ["pi", runtime("pi", (request) => emitOutput(request, "@codex this is inert"))],
      ["codex", runtime("codex", echo)],
    ]),
  );
  await platform.postUserMessage({ content: "@pi only" });
  assert.equal(countEvents(await platform.getEvents(), "run.completed"), 1);
});

test("rejects duplicate structured posts within one run", async () => {
  const results: boolean[] = [];
  const platform = createPlatform(
    [agent("pi"), agent("codex")],
    new Map([
      [
        "pi",
        runtime("pi", async (request) => {
          const message = {
            content: "@codex review once",
            intent: "review",
            idempotencyKey: "same-key",
          };
          results.push((await request.postMessage(message)).accepted);
          results.push((await request.postMessage(message)).accepted);
          return emitOutput(request, "done");
        }),
      ],
      ["codex", runtime("codex", echo)],
    ]),
  );
  await platform.postUserMessage({ content: "@pi deduplicate" });
  assert.deepEqual(results, [true, false]);
  assert.equal(countEvents(await platform.getEvents(), "routing.accepted"), 1);
});

test("runs read-only peers concurrently", async () => {
  let active = 0;
  let maximum = 0;
  const handler = async (request: RuntimeRequest): Promise<RuntimeResult> => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(35);
    active--;
    return emitOutput(request, request.agent.id);
  };
  const platform = createPlatform(
    [agent("pi", "read-only"), agent("codex", "read-only")],
    new Map([
      ["pi", runtime("pi", handler)],
      ["codex", runtime("codex", handler)],
    ]),
  );
  await platform.postUserMessage({ content: "@pi @codex research" });
  assert.equal(maximum, 2);
});

test("serializes writers in the same workspace", async () => {
  let active = 0;
  let maximum = 0;
  const handler = async (request: RuntimeRequest): Promise<RuntimeResult> => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(25);
    active--;
    return emitOutput(request, request.agent.id);
  };
  const platform = createPlatform(
    [agent("pi", "full"), agent("codex", "workspace-write")],
    new Map([
      ["pi", runtime("pi", handler)],
      ["codex", runtime("codex", handler)],
    ]),
  );
  await platform.postUserMessage({
    content: "@pi @codex implement",
    workingDirectory: "/tmp/shared-workspace",
  });
  assert.equal(maximum, 1);
});

test("allows different Agents to write concurrently in different workspaces", async () => {
  let active = 0;
  let maximum = 0;
  const handler = async (request: RuntimeRequest): Promise<RuntimeResult> => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(40);
    active--;
    return emitOutput(request, request.agent.id);
  };
  const platform = createPlatform(
    [agent("pi", "full"), agent("codex", "workspace-write")],
    new Map([
      ["pi", runtime("pi", handler)],
      ["codex", runtime("codex", handler)],
    ]),
  );
  const first = await platform.startUserMessage({
    content: "@pi write",
    workingDirectory: "/tmp/workspace-a",
  });
  const second = await platform.startUserMessage({
    content: "@codex write",
    workingDirectory: "/tmp/workspace-b",
  });
  await Promise.all([first.completion, second.completion]);
  assert.equal(maximum, 2);
});

test("cancels every active and queued run in a chain", async () => {
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const platform = createPlatform(
    [agent("pi", "read-only"), agent("codex", "read-only")],
    new Map([
      ["pi", runtime("pi", async (request) => {
        notifyStarted?.();
        await abortableDelay(5_000, request.signal);
        return { output: "late" };
      })],
      ["codex", runtime("codex", async (request) => {
        await abortableDelay(5_000, request.signal);
        return { output: "late" };
      })],
    ]),
  );
  const chain = await platform.startUserMessage({ content: "@pi @codex stop" });
  await started;
  await platform.cancelGroup(chain.chainId);
  await chain.completion;
  const events = await platform.getEvents();
  assert.equal(countEvents(events, "run.completed"), 0);
  assert.equal(countEvents(events, "run.cancelled"), 2);
});

test("keeps the thread workspace on every later invocation", async () => {
  const directories: Array<string | undefined> = [];
  const capture = runtime("pi", async (request) => {
    directories.push(request.workingDirectory);
    return emitOutput(request, "done");
  });
  const platform = createPlatform([agent("pi")], new Map([["pi", capture]]), "pi");
  const first = await platform.postUserMessage({
    content: "@pi start",
    workingDirectory: "/tmp/example-project",
  });
  await platform.postUserMessage({ content: "continue", threadId: first.threadId });
  assert.deepEqual(directories, ["/tmp/example-project", "/tmp/example-project"]);
});

test("unknown, disabled, and offline targets fail explicitly without orphan threads", async () => {
  const disabled = { ...agent("pi"), enabled: false };
  const offlineRuntime: AgentRuntime = {
    ...runtime("research", echo),
    availability: { available: false, label: "offline", detail: "fixture unavailable" },
  };
  const platform = createPlatform(
    [agent("codex"), disabled, agent("research")],
    new Map([
      ["codex", runtime("codex", echo)],
      ["pi", runtime("pi", echo)],
      ["research", offlineRuntime],
    ]),
    "codex",
  );
  await assert.rejects(platform.startUserMessage({ content: "@missing hello" }), /Unknown Agent/);
  await assert.rejects(platform.startUserMessage({ content: "@pi hello" }), /disabled/);
  await assert.rejects(platform.startUserMessage({ content: "@research hello" }), /unavailable.*fixture unavailable/);
  assert.equal((await platform.getEvents()).filter((event) => event.type === "thread.created").length, 0);
});

test("serializes the same Agent session even across different workspaces", async () => {
  let active = 0;
  let maximum = 0;
  const handler = async (request: RuntimeRequest): Promise<RuntimeResult> => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(25);
    active--;
    return emitOutput(request, "done");
  };
  const platform = createPlatform([agent("pi", "read-only")], new Map([["pi", runtime("pi", handler)]]), "pi");
  const first = await platform.startUserMessage({ content: "@pi one", workingDirectory: "/tmp/one" });
  const second = await platform.startUserMessage({ content: "@pi two", workingDirectory: "/tmp/two" });
  await Promise.all([first.completion, second.completion]);
  assert.equal(maximum, 1);
});

test("rejects a fifth consecutive ping-pong between the same Agent pair", async () => {
  const results: boolean[] = [];
  const handler = async (request: RuntimeRequest): Promise<RuntimeResult> => {
    const target = request.agent.id === "pi" ? "codex" : "pi";
    results.push((await request.postMessage({
      content: `@${target} continue`,
      idempotencyKey: "next-hop",
    })).accepted);
    return emitOutput(request, "done");
  };
  const peers = [agent("pi"), agent("codex")];
  const platform = new MultiAgentPlatform({
    agents: peers,
    defaultAgentId: "codex",
    runtimes: new Map([
      ["pi", runtime("pi", handler)],
      ["codex", runtime("codex", handler)],
    ]),
    eventStore: new InMemoryEventStore(),
    contextCompiler: new RecentContextCompiler(),
    maxA2ADepth: 10,
    maxPingPongHops: 4,
    reviewMode: "off",
  });
  await platform.postUserMessage({ content: "@pi start" });
  assert.deepEqual(results, [true, true, true, true, false]);
  const events = await platform.getEvents();
  assert.equal(countEvents(events, "run.queued"), 5);
  assert.match(events.find((event) => event.type === "routing.rejected")?.type === "routing.rejected" ? events.find((event) => event.type === "routing.rejected")!.reason : "", /Ping-pong limit/);
});

test("rejects configuration changes to an Agent with a live run", async () => {
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
  const definition = agent("pi");
  const platform = createPlatform([definition], new Map([["pi", runtime("pi", async (request) => {
    notifyStarted?.();
    await abortableDelay(5_000, request.signal);
    return { output: "late" };
  })]]), "pi");
  const chain = await platform.startUserMessage({ content: "@pi long task" });
  await started;
  assert.throws(() => platform.beginRosterUpdate([{ ...definition, systemPrompt: "changed" }]), /active or queued run/);
  await platform.cancelGroup(chain.chainId);
  await chain.completion;
});

test("observability runtime events are projected onto the shared event log", async () => {
  const platform = createPlatform([agent("pi")], new Map([["pi", runtime("pi", async (request) => {
    await request.emit({ type: "thinking_delta", text: "weighing options" });
    await request.emit({ type: "text_delta", text: "draft" });
    await request.emit({ type: "output_reset", reason: "retry" });
    await request.emit({ type: "lifecycle", phase: "retry_start", detail: "overloaded" });
    await request.emit({ type: "tool_start", toolName: "bash", toolCallId: "call-1", args: '{"command":"ls"}' });
    await request.emit({ type: "tool_end", toolName: "bash", toolCallId: "call-1", isError: false, resultSummary: "README.md" });
    await request.emit({ type: "diagnostic", source: "extension", message: "hooks.ts failed" });
    await request.emit({
      type: "usage",
      inputTokens: 120,
      outputTokens: 40,
      cacheReadTokens: 8,
      cacheWriteTokens: 0,
      totalTokens: 168,
      costUsd: 0.0123,
      contextTokens: 900,
      contextWindow: 200_000,
    });
    return { output: "final" };
  })]]), "pi");
  await platform.postUserMessage({ content: "@pi go" });
  const events = await platform.getEvents();

  const thinking = events.find((event) => event.type === "run.thinking");
  assert.equal(thinking?.type === "run.thinking" ? thinking.text : "", "weighing options");
  assert.equal(countEvents(events, "run.reset"), 1);

  const lifecycle = events.find((event) => event.type === "run.lifecycle");
  assert.equal(lifecycle?.type === "run.lifecycle" ? lifecycle.phase : "", "retry_start");
  assert.equal(lifecycle?.type === "run.lifecycle" ? lifecycle.detail : "", "overloaded");

  // The existing phase/toolName/isError shape is preserved; the new call id,
  // arguments, and result summary ride alongside as optional fields.
  const toolStart = events.find((event) => event.type === "run.tool" && event.phase === "start");
  assert.equal(toolStart?.type === "run.tool" ? toolStart.args : undefined, '{"command":"ls"}');
  assert.equal(toolStart?.type === "run.tool" ? toolStart.toolCallId : undefined, "call-1");
  const toolEnd = events.find((event) => event.type === "run.tool" && event.phase === "end");
  assert.equal(toolEnd?.type === "run.tool" ? toolEnd.resultSummary : undefined, "README.md");
  assert.equal(toolEnd?.type === "run.tool" ? toolEnd.isError : undefined, false);

  const diagnostic = events.find((event) => event.type === "run.diagnostic");
  assert.equal(diagnostic?.type === "run.diagnostic" ? diagnostic.source : "", "extension");

  const usage = events.find((event) => event.type === "run.usage");
  assert.equal(usage?.type === "run.usage" ? usage.totalTokens : 0, 168);
  assert.equal(usage?.type === "run.usage" ? usage.contextWindow : 0, 200_000);
  // The usage payload must not smuggle a second `type` field into the log.
  assert.equal(usage?.type, "run.usage");

  // Reset does not rewrite history; the completed output is authoritative.
  const completed = events.find((event) => event.type === "run.completed");
  assert.equal(completed?.type === "run.completed" ? completed.output : "", "final");
});

test("a steerable runtime takes a human message mid-run instead of queueing", async () => {
  const steered: Array<{ runId: string; text: string }> = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started: (() => void) | undefined;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const base = runtime("pi", async (request) => {
    started?.();
    await held;
    return { output: "done" };
  });
  const steerable: AgentRuntime = {
    ...base,
    execute: base.execute.bind(base),
    cancel: base.cancel.bind(base),
    steer: async (runId, text) => { steered.push({ runId, text }); return true; },
  };
  const platform = createPlatform([agent("pi")], new Map([["pi", steerable]]), "pi");
  const first = await platform.startUserMessage({ content: "@pi start" });
  await running;

  const second = await platform.startUserMessage({ content: "@pi also check the logs", threadId: first.threadId, steer: true });
  assert.deepEqual(second.steered, ["pi"]);
  // A steered message resolves immediately: it joins the in-flight run rather
  // than starting a chain of its own.
  await second.completion;
  assert.equal(steered.length, 1);
  assert.match(steered[0]?.text ?? "", /also check the logs/);

  release?.();
  await first.completion;

  const events = await platform.getEvents();
  // Exactly one run: the second message never queued behind the first.
  assert.equal(countEvents(events, "run.queued"), 1);
  assert.equal(countEvents(events, "run.steered"), 1);
  // Both human messages are still recorded in the shared thread, so the
  // transcript shows what was said mid-run.
  const humanMessages = events.filter((event) => event.type === "message.created" && event.message.sender.type === "human");
  assert.equal(humanMessages.length, 2);
});

test("steering falls back to a queued run when the runtime cannot take it", async () => {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let started: (() => void) | undefined;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let first = true;
  const platform = createPlatform([agent("pi")], new Map([["pi", runtime("pi", async () => {
    if (first) { first = false; started?.(); await held; }
    return { output: "done" };
  })]]), "pi");
  const initial = await platform.startUserMessage({ content: "@pi start" });
  await running;
  const followUp = await platform.startUserMessage({ content: "@pi more", threadId: initial.threadId, steer: true });
  assert.deepEqual(followUp.steered, []);
  release?.();
  await initial.completion;
  await followUp.completion;
  const events = await platform.getEvents();
  assert.equal(countEvents(events, "run.queued"), 2);
  assert.equal(countEvents(events, "run.steered"), 0);
});

test("image attachments reach the runtime as bytes and stay off the event log", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-attachments-"));
  try {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const path = join(directory, "shot.png");
    await writeFile(path, png);
    let seen: RuntimeRequest | undefined;
    const platform = createPlatform([agent("pi")], new Map([["pi", runtime("pi", async (request) => {
      seen = request;
      return { output: "looked" };
    })]]), "pi");
    await platform.postUserMessage({
      content: "@pi what is this",
      attachments: [{ id: "att_1", mediaType: "image/png", path, byteSize: png.length }],
    });
    assert.equal(seen?.images?.length, 1);
    assert.equal(seen?.images?.[0]?.mediaType, "image/png");
    assert.equal(seen?.images?.[0]?.data, png.toString("base64"));
    assert.equal(seen?.attachments?.[0]?.path, path);

    const events = await platform.getEvents();
    const message = events.find((event) => event.type === "message.created");
    // The log keeps the reference, never the bytes.
    assert.equal(message?.type === "message.created" ? message.message.attachments?.[0]?.id : "", "att_1");
    assert.ok(!JSON.stringify(events).includes(png.toString("base64")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing attachment file is skipped instead of failing the run", async () => {
  let seen: RuntimeRequest | undefined;
  const platform = createPlatform([agent("pi")], new Map([["pi", runtime("pi", async (request) => {
    seen = request;
    return { output: "ok" };
  })]]), "pi");
  await platform.postUserMessage({
    content: "@pi look",
    attachments: [{ id: "att_gone", mediaType: "image/png", path: join(tmpdir(), "mao-missing-attachment.png"), byteSize: 4 }],
  });
  assert.equal(seen?.images, undefined);
  const events = await platform.getEvents();
  assert.equal(countEvents(events, "run.completed"), 1);
});

// ---------------------------------------------------------------------------
// The smart gate. "required" reviews every user task, which made a greeting
// cost a full review round-trip. "smart" reviews what a run actually produced:
// what its Agent declared, or what it quietly wrote to the workspace.
// ---------------------------------------------------------------------------

test("smart gate leaves plain conversation unreviewed", async () => {
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => emitOutput(request, "你好，有什么可以帮你的？"),
  });

  await platform.postUserMessage({ content: "@codex 你好" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.requested"), 0);
  assert.equal(countEvents(events, "review.resolved"), 0);
  assert.equal(countEvents(events, "run.queued"), 1);
  assert.equal(single(events, "run.completed").output, "你好，有什么可以帮你的？");
});

test("material clarification stops before deliverable declaration and peer review", async () => {
  let declarationRefusal: string | undefined;
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      const clarification = await request.requestClarification({
        questions: ["经验最终是给人阅读，还是给自动化系统消费？"],
      });
      assert.equal(clarification.accepted, true);
      const declaration = await request.declareDeliverable({
        kind: "plan",
        summary: "带着未决问题的临时方案",
      });
      declarationRefusal = declaration.reason;
      return emitOutput(request, "请先确认：经验最终给人阅读，还是给自动化系统消费？");
    },
  });

  await platform.postUserMessage({ content: "@codex 设计经验提取算法" });
  const events = await platform.getEvents();

  assert.match(declarationRefusal ?? "", /requested human clarification/);
  assert.deepEqual(single(events, "clarification.requested").questions, [
    "经验最终是给人阅读，还是给自动化系统消费？",
  ]);
  assert.equal(countEvents(events, "deliverable.declared"), 0);
  assert.equal(countEvents(events, "review.requested"), 0);
  assert.equal(countEvents(events, "plan.awaiting-approval"), 0);
  assert.equal(countEvents(events, "run.queued"), 1);
});

test("declaring a completion opens a verify review carrying the evidence", async () => {
  const order: string[] = [];
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      order.push("codex");
      await request.declareDeliverable({
        kind: "completion",
        summary: "修好了解析器",
        evidence: ["src/parser.ts", "pnpm test"],
      });
      return emitOutput(request, "已修复");
    },
    pi: approving(order),
  });

  await platform.postUserMessage({ content: "@codex 修一下解析器" });
  const events = await platform.getEvents();

  assert.deepEqual(order, ["codex", "pi"]);
  const declared = single(events, "deliverable.declared");
  assert.equal(declared.kind, "completion");
  assert.deepEqual(declared.evidence, ["src/parser.ts", "pnpm test"]);
  const requested = single(events, "review.requested");
  assert.equal(requested.reviewType, "verify");
  assert.equal(requested.reviewerAgentId, "pi");
  // The reviewer is handed the claim and the evidence, not just the output.
  const brief = (await platform.getThreadMessages(requested.threadId)).find(
    (message) => message.id === requested.messageId,
  );
  assert.match(brief?.content ?? "", /修好了解析器/);
  assert.match(brief?.content ?? "", /src\/parser\.ts/);
  assert.match(brief?.content ?? "", /they prove nothing by themselves/);
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("declaring a plan opens a critique review instead of a verification", async () => {
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "分三步重构" });
      return emitOutput(request, "方案如上");
    },
    pi: approving([]),
  });

  await platform.postUserMessage({ content: "@codex 给个重构方案" });
  const events = await platform.getEvents();

  const requested = single(events, "review.requested");
  assert.equal(requested.reviewType, "critique");
  const brief = (await platform.getThreadMessages(requested.threadId)).find(
    (message) => message.id === requested.messageId,
  );
  assert.match(brief?.content ?? "", /This is a plan, not finished work/);
  assert.equal(single(events, "review.resolved").reviewType, "critique");
});

test("a critique that requests changes reworks the plan as a critique round", async () => {
  const verdicts: ReviewVerdict[] = ["changes-requested", "approved"];
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "分三步重构" });
      return emitOutput(request, "方案");
    },
    pi: async (request) => {
      await request.submitReview?.({
        verdict: verdicts.shift() ?? "approved",
        summary: "第二步风险没交代",
        findings: ["补上回滚方案"],
        checks: ["逐条对照了原始任务与方案步骤"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 给个重构方案" });
  const events = await platform.getEvents();

  const requests = events.filter((event) => event.type === "review.requested");
  assert.equal(requests.length, 2);
  // The rework round keeps critiquing a plan rather than switching to verify.
  assert.deepEqual(
    requests.map((event) => (event.type === "review.requested" ? event.reviewType : undefined)),
    ["critique", "critique"],
  );
  const feedback = (await platform.getThreadMessages(requests[0]!.threadId)).find(
    (message) => message.kind === "review-feedback",
  );
  assert.match(feedback?.content ?? "", /Revise your plan/);
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("writing files without declaring anything is still reviewed", async () => {
  const platform = createSmartPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      await request.emit({ type: "tool_start", toolName: "edit", toolCallId: "call-1" });
      await request.emit({ type: "tool_end", toolName: "edit", toolCallId: "call-1", isError: false });
      return emitOutput(request, "顺手改了两行");
    },
    pi: approving([]),
  });

  await platform.postUserMessage({ content: "@codex 看一下这个文件" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "deliverable.declared"), 0);
  assert.equal(single(events, "review.requested").reviewType, "verify");
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("reading with shell tools does not arm the gate", async () => {
  const platform = createSmartPlatform([agent("codex", "workspace-write"), agent("pi")], {
    codex: async (request) => {
      await request.emit({ type: "tool_start", toolName: "bash", toolCallId: "call-1", args: "ls" });
      await request.emit({ type: "tool_end", toolName: "bash", toolCallId: "call-1", isError: false });
      return emitOutput(request, "目录里有三个文件");
    },
  });

  await platform.postUserMessage({ content: "@codex 这个目录里有什么" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.requested"), 0);
});

test("a read-only run cannot arm the write-effect backstop", async () => {
  const platform = createSmartPlatform([agent("codex", "read-only"), agent("pi")], {
    codex: async (request) => {
      await request.emit({ type: "tool_start", toolName: "edit", toolCallId: "call-1" });
      return emitOutput(request, "我没有写权限");
    },
  });

  await platform.postUserMessage({ content: "@codex 看看代码" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.requested"), 0);
});

test("a reviewer cannot declare a deliverable of its own", async () => {
  const results: Array<{ accepted: boolean; reason?: string }> = [];
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "completion", summary: "做完了" });
      return emitOutput(request, "成品");
    },
    pi: async (request) => {
      results.push(await request.declareDeliverable({ kind: "completion", summary: "我也交付" }));
      await request.submitReview?.({ verdict: "approved", summary: "没问题", checks: ["读过改动"] });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@codex 干活" });
  const events = await platform.getEvents();

  assert.equal(results.length, 1);
  assert.equal(results[0]?.accepted, false);
  assert.match(results[0]?.reason ?? "", /does not declare one/);
  // Only the author's declaration is on the log; the review round is unchanged.
  assert.equal(countEvents(events, "deliverable.declared"), 1);
  assert.equal(single(events, "review.requested").reviewType, "verify");
});

test("a declaration cannot switch kind once the run has made one", async () => {
  const results: Array<{ accepted: boolean; reason?: string }> = [];
  const platform = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      results.push(await request.declareDeliverable({ kind: "completion", summary: "做完了" }));
      results.push(await request.declareDeliverable({ kind: "plan", summary: "其实是个方案" }));
      results.push(await request.declareDeliverable({ kind: "completion", summary: "改口径" }));
      return emitOutput(request, "成品");
    },
    pi: approving([]),
  });

  await platform.postUserMessage({ content: "@codex 干活" });
  const events = await platform.getEvents();

  assert.deepEqual(results.map((result) => result.accepted), [true, false, true]);
  assert.match(results[1]?.reason ?? "", /already declared a completion/);
  assert.equal(single(events, "review.requested").reviewType, "verify");
});

test("required mode still reviews a task that declares nothing", async () => {
  const platform = createReviewPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => emitOutput(request, "你好"),
    pi: approving([]),
  });

  await platform.postUserMessage({ content: "@codex 你好" });
  const events = await platform.getEvents();

  assert.equal(single(events, "review.requested").reviewType, "verify");
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("an explicit clarification bypasses even the required review gate", async () => {
  const platform = createReviewPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.requestClarification({ questions: ["请选择必须兼容的测试框架。"] });
      return emitOutput(request, "你需要兼容哪个测试框架？");
    },
  });

  await platform.postUserMessage({ content: "@codex 设计解析器" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "clarification.requested"), 1);
  assert.equal(countEvents(events, "review.requested"), 0);
  assert.equal(countEvents(events, "run.queued"), 1);
});

test("a smart-gate event log replays its declarations and review types", async () => {
  const store = new InMemoryEventStore();
  const first = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => {
      await request.declareDeliverable({ kind: "plan", summary: "分三步重构" });
      return emitOutput(request, "方案");
    },
    pi: approving([]),
  }, { eventStore: store });
  await first.postUserMessage({ content: "@codex 给个方案" });

  const replayed = createSmartPlatform([agent("codex"), agent("pi")], {
    codex: async (request) => emitOutput(request, "不该再跑"),
  }, { eventStore: store });
  await replayed.initialize();
  const events = await replayed.getEvents();

  assert.equal(countEvents(events, "review.requested"), 1);
  assert.equal(single(events, "review.requested").reviewType, "critique");
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("streamed deltas are coalesced without losing text or reordering events", async () => {
  const platform = createPlatform([agent("pi")], new Map([["pi", runtime("pi", async (request) => {
    for (const piece of ["一", "二", "三", "四", "五"]) {
      await request.emit({ type: "text_delta", text: piece });
    }
    await request.emit({ type: "tool_start", toolName: "read", toolCallId: "call-1" });
    for (const piece of ["六", "七"]) {
      await request.emit({ type: "text_delta", text: piece });
    }
    return { output: "一二三四五六七" };
  })]]), "pi");

  await platform.postUserMessage({ content: "@pi 数数" });
  const events = await platform.getEvents();

  const deltas = events.filter((event) => event.type === "run.delta");
  // Seven tokens, but the log holds one event per flush boundary, not per token.
  assert.ok(deltas.length < 7, `expected coalesced deltas, got ${deltas.length}`);
  assert.equal(
    deltas.map((event) => (event.type === "run.delta" ? event.text : "")).join(""),
    "一二三四五六七",
  );
  // The tool call must not overtake the text that preceded it.
  const toolIndex = events.findIndex((event) => event.type === "run.tool");
  const firstDeltaIndex = events.findIndex((event) => event.type === "run.delta");
  const lastDeltaIndex = events.map((event) => event.type).lastIndexOf("run.delta");
  assert.ok(firstDeltaIndex < toolIndex, "text before the tool call must be flushed first");
  assert.ok(lastDeltaIndex > toolIndex, "text after the tool call must follow it");
});

function createPlatform(
  agents: AgentDefinition[],
  runtimes: Map<string, AgentRuntime>,
  defaultAgentId = agents[0]?.id ?? "codex",
  options: Partial<MultiAgentPlatformOptions> = {},
): MultiAgentPlatform {
  return new MultiAgentPlatform({
    agents,
    defaultAgentId,
    runtimes,
    eventStore: new InMemoryEventStore(),
    contextCompiler: new RecentContextCompiler(),
    // These tests exercise peer routing, which is orthogonal to the review
    // gate. Review behaviour has its own tests, which opt back in.
    reviewMode: "off",
    ...options,
  });
}

function agent(id: string, accessMode: AccessMode = "read-only"): AgentDefinition {
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
      await request.emit({ type: "prompt_accepted" });
      return handler(request);
    },
    async cancel() {},
  };
}

async function echo(request: RuntimeRequest): Promise<RuntimeResult> {
  return emitOutput(request, `${request.agent.id}: ${request.incoming.content}`);
}

async function recordOutput(
  request: RuntimeRequest,
  calls: string[],
): Promise<RuntimeResult> {
  calls.push(request.agent.id);
  return emitOutput(request, request.agent.id);
}

async function emitOutput(
  request: RuntimeRequest,
  output: string,
): Promise<RuntimeResult> {
  await request.emit({ type: "text_delta", text: output });
  return { output };
}

function countEvents(events: StoredPlatformEvent[], type: StoredPlatformEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    }, { once: true });
  });
}

function abortError(reason: unknown): Error {
  const error = new Error(String(reason ?? "Aborted"));
  error.name = "AbortError";
  return error;
}

// ---------------------------------------------------------------------------
// Mandatory peer-review gate
// ---------------------------------------------------------------------------

test("a user task is not delivered until a different Agent reviews it", async () => {
  const order: string[] = [];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => {
      order.push("pi");
      return emitOutput(request, "实现完成");
    },
    codex: approving(order),
  });

  const result = await platform.postUserMessage({ content: "@pi 请实现一个功能" });
  const events = await platform.getEvents();

  // The chain must not resolve before the reviewer has run.
  assert.deepEqual(order, ["pi", "codex"]);
  const requested = single(events, "review.requested");
  assert.equal(requested.authorAgentId, "pi");
  assert.equal(requested.reviewerAgentId, "codex");
  assert.equal(requested.round, 1);
  assert.equal(single(events, "review.submitted").verdict, "approved");
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "approved");
  assert.equal(resolved.rounds, 1);
  assert.equal(resolved.taskRunId, requested.taskRunId);

  const messages = await platform.getThreadMessages(result.threadId);
  const submitted = messages.find((message) => message.kind === "review-request");
  assert.equal(submitted?.sender.type === "agent" && submitted.sender.id, "pi");
  assert.deepEqual(submitted?.mentions, ["codex"]);
  assert.match(submitted?.content ?? "", /实现完成/);
});

test("the configured reviewerAgentId wins over roster order", async () => {
  const seen: string[] = [];
  const author = { ...agent("pi"), reviewerAgentId: "research" };
  const platform = createReviewPlatform([author, agent("codex"), agent("research")], {
    pi: async (request) => emitOutput(request, "草稿"),
    codex: approving(seen),
    research: approving(seen),
  });

  await platform.postUserMessage({ content: "@pi 起草" });
  const events = await platform.getEvents();

  assert.equal(single(events, "review.requested").reviewerAgentId, "research");
  assert.deepEqual(seen, ["research"]);
});

test("an offline configured reviewer falls back to another routable peer", async () => {
  const author = { ...agent("pi"), reviewerAgentId: "research" };
  const platform = createReviewPlatform([author, agent("codex"), agent("research")], {
    pi: async (request) => emitOutput(request, "草稿"),
    codex: approving([]),
    research: approving([]),
  }, { offline: ["research"] });

  await platform.postUserMessage({ content: "@pi 起草" });
  const events = await platform.getEvents();

  assert.equal(single(events, "review.requested").reviewerAgentId, "codex");
});

test("a peer that co-authored this chain loses the review to an uninvolved peer", async () => {
  const author = { ...agent("pi"), reviewerAgentId: "codex" };
  const seen: string[] = [];
  const platform = createReviewPlatform([author, agent("codex"), agent("research")], {
    pi: async (request) => {
      await request.postMessage({
        content: "@codex 帮我把解析那段写了",
        idempotencyKey: "handoff-1",
      });
      return emitOutput(request, "交付");
    },
    codex: async (request) => emitOutput(request, "解析写好了"),
    research: approving(seen),
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  // codex is the configured reviewer, but it produced part of this very work.
  assert.equal(single(events, "review.requested").reviewerAgentId, "research");
  assert.deepEqual(seen, ["research"]);
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("the last remaining reviewer is used even after co-authoring, and told it is not neutral", async () => {
  let assignment: ReviewAssignment | undefined;
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => {
      await request.postMessage({
        content: "@codex 你先写一版",
        idempotencyKey: "handoff-1",
      });
      return emitOutput(request, "交付");
    },
    codex: async (request) => {
      if (!request.reviewOf) return emitOutput(request, "写好了");
      assignment = request.reviewOf;
      await request.submitReview?.({
        verdict: "approved",
        summary: "连我自己那段一起核对过",
        checks: ["重新读了一遍改动"],
      });
      return emitOutput(request, "审毕");
    },
  });

  const result = await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  // A compromised reviewer still beats nobody looking at the work at all.
  assert.equal(single(events, "review.requested").reviewerAgentId, "codex");
  assert.equal(assignment?.independent, false);
  const messages = await platform.getThreadMessages(result.threadId);
  const brief = messages.find((message) => message.kind === "review-request");
  assert.match(brief?.content ?? "", /not a neutral party/);
});

test("the review brief tells the reviewer to disbelieve the claim and check for itself", async () => {
  let assignment: ReviewAssignment | undefined;
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      assignment = request.reviewOf;
      await request.submitReview?.({
        verdict: "approved",
        summary: "核对过了",
        checks: ["自己跑了测试"],
      });
      return emitOutput(request, "审毕");
    },
  });

  const result = await platform.postUserMessage({ content: "@pi 实现" });
  const messages = await platform.getThreadMessages(result.threadId);
  const brief = messages.find((message) => message.kind === "review-request");

  assert.equal(assignment?.independent, true);
  assert.match(brief?.content ?? "", /default position is not-approved/);
  assert.match(brief?.content ?? "", /primary sources/);
  assert.doesNotMatch(brief?.content ?? "", /not a neutral party/);
});

test("approved without a check the reviewer ran itself is rejected", async () => {
  const attempts: Array<{ accepted: boolean; reason?: string }> = [];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      attempts.push(await request.submitReview!({ verdict: "approved", summary: "看着没问题" }));
      attempts.push(
        await request.submitReview!({ verdict: "approved", summary: "看着没问题", checks: ["   "] }),
      );
      attempts.push(
        await request.submitReview!({
          verdict: "approved",
          summary: "核对过了",
          checks: ["自己跑了一遍解析用例"],
        }),
      );
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  // Repeating the author's word is not a review, so it cannot close the gate.
  assert.deepEqual(attempts.map((attempt) => attempt.accepted), [false, false, true]);
  assert.match(attempts[0]?.reason ?? "", /check/i);
  const submitted = single(events, "review.submitted");
  assert.deepEqual(submitted.checks, ["自己跑了一遍解析用例"]);
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("changes-requested needs no check, so doubt is never harder than approval", async () => {
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      await request.submitReview?.({
        verdict: "changes-requested",
        summary: "证据对不上",
        findings: ["声称改了的文件里没有这段代码"],
      });
      return emitOutput(request, "审毕");
    },
  }, { maxReviewRounds: 1 });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  assert.equal(single(events, "review.submitted").verdict, "changes-requested");
  assert.equal(single(events, "review.submitted").checks, undefined);
  assert.equal(single(events, "review.resolved").escalation, "max-rounds");
});

test("a task with no eligible reviewer escalates instead of passing", async () => {
  const platform = createReviewPlatform([agent("pi")], {
    pi: async (request) => emitOutput(request, "只有我一个人"),
  });

  await platform.postUserMessage({ content: "@pi 干活" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.requested"), 0);
  assert.equal(countEvents(events, "review.submitted"), 0);
  assert.equal(countEvents(events, "run.queued"), 1);
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "escalated");
  assert.equal(resolved.escalation, "no-reviewer");
});

test("changes-requested hands feedback back to the author and re-reviews the rework", async () => {
  const order: string[] = [];
  const verdicts: ReviewVerdict[] = ["changes-requested", "approved"];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => {
      order.push("pi");
      return emitOutput(request, `第 ${order.filter((id) => id === "pi").length} 版`);
    },
    codex: async (request) => {
      order.push("codex");
      await request.submitReview?.({
        verdict: verdicts.shift() ?? "approved",
        summary: "缺少错误处理",
        findings: ["为解析失败补一个分支"],
        checks: ["自己读了改动文件的解析分支"],
      });
      return emitOutput(request, "审毕");
    },
  });

  const result = await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  assert.deepEqual(order, ["pi", "codex", "pi", "codex"]);
  assert.equal(countEvents(events, "review.requested"), 2);
  const rework = single(events, "review.rework");
  assert.equal(rework.authorAgentId, "pi");
  assert.equal(rework.round, 1);

  const messages = await platform.getThreadMessages(result.threadId);
  const feedback = messages.find((message) => message.kind === "review-feedback");
  assert.equal(feedback?.sender.type === "agent" && feedback.sender.id, "codex");
  assert.deepEqual(feedback?.mentions, ["pi"]);
  assert.match(feedback?.content ?? "", /缺少错误处理/);
  assert.match(feedback?.content ?? "", /为解析失败补一个分支/);

  // Exactly one terminal marker, and it is the approval of round 2.
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "approved");
  assert.equal(resolved.rounds, 2);
});

test("escalates to the human instead of looping past maxReviewRounds", async () => {
  const order: string[] = [];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => {
      order.push("pi");
      return emitOutput(request, "又一版");
    },
    codex: async (request) => {
      order.push("codex");
      await request.submitReview?.({
        verdict: "changes-requested",
        summary: "还是不行",
        findings: ["同上"],
      });
      return emitOutput(request, "审毕");
    },
  }, { maxReviewRounds: 2 });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  assert.deepEqual(order, ["pi", "codex", "pi", "codex"]);
  assert.equal(countEvents(events, "review.rework"), 1);
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "escalated");
  assert.equal(resolved.escalation, "max-rounds");
  assert.equal(resolved.rounds, 2);
});

test("a review run that ends without submit_review is escalated, never approved", async () => {
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => emitOutput(request, "看起来不错"),
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.submitted"), 0);
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "escalated");
  assert.equal(resolved.escalation, "inconclusive");
});

test("a failed reviewer run escalates instead of approving", async () => {
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async () => {
      throw new Error("reviewer exploded");
    },
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "run.failed"), 1);
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "escalated");
  assert.equal(resolved.escalation, "review-failed");
});

test("a failed author run is never reviewed", async () => {
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async () => {
      throw new Error("author exploded");
    },
    codex: approving([]),
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "review.requested"), 0);
  assert.equal(countEvents(events, "review.resolved"), 0);
  assert.equal(countEvents(events, "run.failed"), 1);
});

test("submit_review is refused outside a review run", async () => {
  let taskResult: { accepted: boolean; reason?: string } | undefined;
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => {
      taskResult = await request.submitReview?.({ verdict: "approved", summary: "自我批准" });
      return emitOutput(request, "交付");
    },
    codex: approving([]),
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  // The task run gets no assignment at all, so the tool has nothing to call.
  assert.equal(taskResult, undefined);
  assert.equal(countEvents(events, "review.submitted"), 1);
  assert.equal(single(events, "review.submitted").reviewerAgentId, "codex");
});

test("changes-requested without concrete findings is rejected", async () => {
  const attempts: Array<{ accepted: boolean; reason?: string }> = [];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      attempts.push(await request.submitReview!({ verdict: "changes-requested", summary: "不行" }));
      attempts.push(await request.submitReview!({ verdict: "changes-requested", summary: "", findings: ["x"] }));
      attempts.push(
        await request.submitReview!({
          verdict: "changes-requested",
          summary: "不行",
          findings: ["把边界条件补上"],
        }),
      );
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@pi 实现" });

  // Round 2 re-runs the same handler after the rework, so only judge round 1.
  assert.deepEqual(attempts.slice(0, 3).map((attempt) => attempt.accepted), [false, false, true]);
  assert.match(attempts[0]?.reason ?? "", /finding/i);
  assert.match(attempts[1]?.reason ?? "", /summary/i);
});

test("cancelling a chain mid-review cancels the review and requests no rework", async () => {
  let releaseReviewer: (() => void) | undefined;
  const reviewerStarted = new Promise<void>((resolve) => {
    releaseReviewer = resolve;
  });
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      releaseReviewer?.();
      await new Promise<void>((resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(abortError("cancelled")), { once: true });
      });
      return emitOutput(request, "unreachable");
    },
  });

  const started = await platform.startUserMessage({ content: "@pi 实现" });
  await reviewerStarted;
  await platform.cancelGroup(started.chainId, "operator");
  await started.completion;
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "run.cancelled"), 1);
  assert.equal(countEvents(events, "review.rework"), 0);
  const resolved = single(events, "review.resolved");
  // An operator cancel is not a quality signal, so it must not read as an escalation.
  assert.equal(resolved.outcome, "cancelled");
  assert.equal(resolved.escalation, undefined);
});

test("review and rework runs do not consume the per-chain run budget", async () => {
  const verdicts: ReviewVerdict[] = ["changes-requested", "approved"];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      await request.submitReview?.({
        verdict: verdicts.shift() ?? "approved",
        summary: "补一下",
        findings: ["补一下"],
        checks: ["自己跑了一遍验证命令"],
      });
      return emitOutput(request, "审毕");
    },
  }, { maxAgentRunsPerChain: 1 });

  await platform.postUserMessage({ content: "@pi 实现" });
  const events = await platform.getEvents();

  // 1 task + 2 reviews + 1 rework, none of them blocked by a budget meant for
  // Agent-initiated fan-out.
  assert.equal(countEvents(events, "run.queued"), 4);
  assert.equal(countEvents(events, "routing.rejected"), 0);
  assert.equal(single(events, "review.resolved").outcome, "approved");
});

test("review and rework runs keep the author's causal depth", async () => {
  const verdicts: ReviewVerdict[] = ["changes-requested", "approved"];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: async (request) => {
      await request.submitReview?.({
        verdict: verdicts.shift() ?? "approved",
        summary: "补一下",
        findings: ["补一下"],
        checks: ["自己跑了一遍验证命令"],
      });
      return emitOutput(request, "审毕");
    },
  });

  await platform.postUserMessage({ content: "@pi 实现" });
  const queued = (await platform.getEvents()).filter(
    (event): event is Extract<StoredPlatformEvent, { type: "run.queued" }> =>
      event.type === "run.queued",
  );

  // Spending A2A depth on the gate would leave a reworking Agent unable to
  // collaborate at all.
  assert.deepEqual(queued.map((event) => event.run.causal.depth), [0, 0, 0, 0]);
  assert.deepEqual(queued.map((event) => event.run.purpose), ["task", "review", "task", "review"]);
  const taskRunId = queued[0]!.run.id;
  assert.deepEqual(
    queued.slice(1).map((event) => event.run.taskRunId),
    [taskRunId, taskRunId, taskRunId],
  );
});

test("a completed review run does not become the thread's fallback responder", async () => {
  const order: string[] = [];
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => {
      order.push("pi");
      return emitOutput(request, "交付");
    },
    codex: approving(order),
  }, { defaultAgentId: "codex" });

  const first = await platform.postUserMessage({ content: "@pi 实现" });
  order.length = 0;
  await platform.postUserMessage({ content: "继续", threadId: first.threadId });

  // Without the guard the reviewer would silently inherit the thread.
  assert.equal(order[0], "pi");
});

test("an interrupted review escalates on restart instead of being retried", async () => {
  const store = new InMemoryEventStore();
  let holdReviewer = true;
  const peers = [agent("pi"), agent("codex")];
  const runtimes = new Map([
    ["pi", runtime("pi", async (request) => emitOutput(request, "交付"))],
    [
      "codex",
      runtime("codex", async (request) => {
        if (holdReviewer) {
          await new Promise<void>(() => {});
        }
        return emitOutput(request, "审毕");
      }),
    ],
  ]);
  const first = new MultiAgentPlatform({
    agents: peers,
    defaultAgentId: "pi",
    runtimes,
    eventStore: store,
    contextCompiler: new RecentContextCompiler(),
    reviewMode: "required",
  });
  const started = await first.startUserMessage({ content: "@pi 实现" });
  await waitFor(async () =>
    (await first.getEvents()).some(
      (event) => event.type === "run.started" && event.agentId === "codex",
    ),
  );

  // A fresh process replays the same log.
  holdReviewer = false;
  const restarted = new MultiAgentPlatform({
    agents: peers,
    defaultAgentId: "pi",
    runtimes,
    eventStore: store,
    contextCompiler: new RecentContextCompiler(),
    reviewMode: "required",
  });
  await restarted.initialize();
  const events = await restarted.getEvents();

  assert.equal(countEvents(events, "run.interrupted"), 1);
  const resolved = single(events, "review.resolved");
  assert.equal(resolved.outcome, "escalated");
  assert.equal(resolved.escalation, "review-failed");
  assert.equal(countEvents(events, "review.submitted"), 0);
  void started;
});

test("a pre-review event log replays without retro-requesting reviews", async () => {
  const store = new InMemoryEventStore();
  const platform = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: approving([]),
  }, { eventStore: store, reviewMode: "off" });
  await platform.postUserMessage({ content: "@pi 老任务" });

  // Same log, now with the gate on: historical completed runs must stay closed.
  const upgraded = createReviewPlatform([agent("pi"), agent("codex")], {
    pi: async (request) => emitOutput(request, "交付"),
    codex: approving([]),
  }, { eventStore: store });
  await upgraded.initialize();
  const events = await upgraded.getEvents();

  assert.equal(events.filter((event) => event.type.startsWith("review.")).length, 0);
  const queued = events.filter(
    (event): event is Extract<StoredPlatformEvent, { type: "run.queued" }> =>
      event.type === "run.queued",
  );
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.run.purpose, "task");
});

interface ReviewPlatformOptions extends Partial<MultiAgentPlatformOptions> {
  offline?: string[];
  defaultAgentId?: string;
}

/** A platform with the review gate on and one handler per Agent. */
function createReviewPlatform(
  agents: AgentDefinition[],
  handlers: Record<string, (request: RuntimeRequest) => Promise<RuntimeResult>>,
  options: ReviewPlatformOptions = {},
): MultiAgentPlatform {
  const { offline = [], defaultAgentId, ...platformOptions } = options;
  const runtimes = new Map(
    agents.map((definition) => {
      const base = runtime(definition.id, handlers[definition.id] ?? echo);
      return [
        definition.id,
        offline.includes(definition.id)
          ? { ...base, availability: { available: false, label: "offline" } }
          : base,
      ] as const;
    }),
  );
  return new MultiAgentPlatform({
    agents,
    defaultAgentId: defaultAgentId ?? agents[0]!.id,
    runtimes: new Map(runtimes),
    eventStore: new InMemoryEventStore(),
    contextCompiler: new RecentContextCompiler(),
    reviewMode: "required",
    ...platformOptions,
  });
}

/** A platform with the smart gate on: review follows what a run produced. */
function createSmartPlatform(
  agents: AgentDefinition[],
  handlers: Record<string, (request: RuntimeRequest) => Promise<RuntimeResult>>,
  options: ReviewPlatformOptions = {},
): MultiAgentPlatform {
  return createReviewPlatform(agents, handlers, { ...options, reviewMode: "smart" });
}

/** A reviewer that always approves, recording the order it ran in. */
function approving(order: string[]): (request: RuntimeRequest) => Promise<RuntimeResult> {
  return async (request) => {
    order.push(request.agent.id);
    await request.submitReview?.({
      verdict: "approved",
      summary: "看过了，可以交付",
      checks: ["自己读了产出的文件"],
    });
    return emitOutput(request, "审毕");
  };
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

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met in time");
}
