import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import { InMemoryEventStore } from "../src/core/event-store.js";
import { MultiAgentPlatform } from "../src/core/platform.js";
import type {
  AccessMode,
  AgentDefinition,
  RuntimeAvailability,
  StoredPlatformEvent,
} from "../src/core/types.js";
import type {
  AgentRuntime,
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

function createPlatform(
  agents: AgentDefinition[],
  runtimes: Map<string, AgentRuntime>,
  defaultAgentId = agents[0]?.id ?? "codex",
): MultiAgentPlatform {
  return new MultiAgentPlatform({
    agents,
    defaultAgentId,
    runtimes,
    eventStore: new InMemoryEventStore(),
    contextCompiler: new RecentContextCompiler(),
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
