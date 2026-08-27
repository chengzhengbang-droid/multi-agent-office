import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../src/core/types.js";
import {
  CodexRuntimeAdapter,
  projectCodexAppServerEvent,
} from "../src/runtime/codex-runtime.js";
import type {
  RuntimeEvent,
  RuntimeRequest,
  SubmitReviewInput,
} from "../src/runtime/runtime.js";
import {
  buildSystemPrompt,
  piExcludedTools,
  resolvePiAvailability,
  summarizeToolPayload,
} from "../src/runtime/pi-runtime.js";
import {
  FileRuntimeSessionStore,
  InMemoryRuntimeSessionStore,
} from "../src/runtime/session-store.js";

test("Codex app-server projection separates messages, native tools, usage, and failures", () => {
  assert.deepEqual(projectCodexAppServerEvent({ method: "item/completed", params: { item: { id: "m1", type: "agentMessage", text: "hello" } } }), { type: "text", text: "hello", itemId: "m1" });
  assert.deepEqual(projectCodexAppServerEvent({ method: "item/started", params: { item: { id: "c1", type: "dynamicToolCall", tool: "submit_review", arguments: { verdict: "approved" } } } }), { type: "tool_start", toolName: "submit_review", itemId: "c1", args: '{"verdict":"approved"}' });
  assert.deepEqual(projectCodexAppServerEvent({ method: "item/completed", params: { item: { id: "c1", type: "dynamicToolCall", tool: "submit_review", status: "failed", success: false } } }), { type: "tool_end", toolName: "submit_review", itemId: "c1", isError: true });
  assert.deepEqual(projectCodexAppServerEvent({ method: "turn/completed", params: { turn: { id: "turn-1", status: "failed", error: { message: "bad turn" } } } }), { type: "turn_completed", turn: { id: "turn-1", status: "failed", error: { message: "bad turn" } } });
});

test("Pi access modes deny capabilities instead of allow-listing them", () => {
  // A denylist keeps extension-registered tools reachable; an allowlist would
  // silently drop every tool an extension contributes.
  assert.deepEqual(piExcludedTools("read-only"), ["bash", "edit", "write"]);
  assert.deepEqual(piExcludedTools("workspace-write"), ["bash"]);
  assert.deepEqual(piExcludedTools("full"), []);
});

test("tool payload summaries are bounded so the event log stays small", () => {
  assert.equal(summarizeToolPayload(undefined), undefined);
  assert.equal(summarizeToolPayload({ command: "ls" }), '{"command":"ls"}');
  const long = summarizeToolPayload("x".repeat(5_000));
  assert.ok(long);
  assert.ok(long.length < 2_100);
  assert.ok(long.endsWith("（已截断）"));
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(summarizeToolPayload(cyclic), undefined);
});

test("the collaboration prompt makes human clarification a pre-review gate", () => {
  const prompt = buildSystemPrompt(request("run-prompt", []));
  assert.match(prompt, /Before drafting a plan or starting execution/);
  assert.match(prompt, /call request_clarification/);
  assert.match(prompt, /Do not create or submit a provisional deliverable/);
  assert.match(prompt, /only then submit the deliverable for peer review/);
});

test("peer review prompts make later rounds a discussion instead of reviewer commands", () => {
  const authorPrompt = buildSystemPrompt(request("author-discussion", []));
  assert.match(authorPrompt, /Review findings are arguments, not commands/);
  assert.match(authorPrompt, /no separate accept\/reject ceremony/);
  assert.match(authorPrompt, /Do not comply merely to satisfy the reviewer/);

  const reviewRequest: RuntimeRequest = {
    ...request("review-discussion", []),
    reviewOf: {
      taskRunId: "task-1",
      authorAgentId: "pi",
      round: 2,
      maxRounds: 2,
      reviewType: "verify",
      independent: true,
    },
    submitReview: async () => ({ accepted: true }),
  };
  const reviewerPrompt = buildSystemPrompt(reviewRequest);
  assert.match(reviewerPrompt, /continued discussion, not a compliance inspection/);
  assert.match(reviewerPrompt, /rebut.*earlier suggestion/i);
  assert.match(reviewerPrompt, /Either peer is allowed to change their mind/);
  assert.match(reviewerPrompt, /human decides/);
});

test("DeepSeek runtime requires and recognizes its API key", () => {
  const spec = {
    kind: "pi" as const,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinkingLevel: "medium" as const,
  };
  assert.deepEqual(resolvePiAvailability(spec, {}), {
    available: false,
    label: "deepseek/deepseek-v4-flash",
    detail: "Missing credential: DEEPSEEK_API_KEY",
  });
  assert.deepEqual(resolvePiAvailability(spec, { DEEPSEEK_API_KEY: "sk-example" }), {
    available: true,
    label: "deepseek/deepseek-v4-flash",
  });
});

test("Pi credentials stored in auth.json count as configured", () => {
  const configured = { hasConfiguredAuth: (provider: string) => provider === "anthropic" };
  const anthropic = {
    kind: "pi" as const,
    provider: "anthropic",
    model: "claude-sonnet-5",
    thinkingLevel: "medium" as const,
  };
  // An OAuth or auth.json login sets no environment variable, yet the Agent
  // must still be routable.
  assert.equal(resolvePiAvailability(anthropic, {}, configured).available, true);
  assert.equal(
    resolvePiAvailability({ ...anthropic, provider: "openai", model: "gpt-5.5" }, {}, configured)
      .available,
    false,
  );
  // Environment variables still work when the credential store knows nothing.
  assert.equal(
    resolvePiAvailability(
      { ...anthropic, provider: "deepseek", model: "deepseek-v4-flash" },
      { DEEPSEEK_API_KEY: "sk-example" },
      configured,
    ).available,
    true,
  );
});

test("providers outside the preset table are not blocked without a probe", () => {
  // The preset table covers the providers this app can store a key for; a
  // provider declared straight in pi's own models.json is not in it, and
  // judging it offline from the table would block a valid setup.
  const declaredInPi = {
    kind: "pi" as const,
    provider: "corp-gateway",
    model: "house-model",
    thinkingLevel: "medium" as const,
  };
  assert.equal(resolvePiAvailability(declaredInPi, {}).available, true);
  assert.equal(
    resolvePiAvailability(declaredInPi, {}, { hasConfiguredAuth: () => false }).available,
    false,
  );
});

test("a preset added since the first release is judged by its own key", () => {
  const kimi = {
    kind: "pi" as const,
    provider: "moonshotai-cn",
    model: "kimi-k3",
    thinkingLevel: "medium" as const,
  };
  assert.equal(resolvePiAvailability(kimi, {}).available, false);
  assert.equal(
    resolvePiAvailability(kimi, { MOONSHOT_API_KEY: "sk-example" }).available,
    true,
  );
});

test("Codex adapter uses native dynamic tools and resumes its app-server thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-codex-fixture-"));
  const fixture = join(directory, "app-server");
  const logPath = join(directory, "args.jsonl");
  const previousLog = process.env.FAKE_CODEX_LOG;
  const previousTool = process.env.FAKE_CODEX_TOOL;
  process.env.FAKE_CODEX_LOG = logPath;
  try {
    await writeFile(fixture, `const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const log = (value) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(value) + "\\n");
log({ kind: "args", value: ["app-server", ...process.argv.slice(2)] });
let currentTurn = "turn-1";
let toolCall;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  log({ kind: "rpc", value: message });
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fixture" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "codex-session-123" } } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  } else if (message.method === "turn/start") {
    currentTurn = process.env.FAKE_CODEX_TOOL === "submit_review"
      ? "turn-2"
      : process.env.FAKE_CODEX_TOOL === "request_clarification"
        ? "turn-3"
        : "turn-1";
    send({ id: message.id, result: { turn: { id: currentTurn, status: "inProgress", items: [] } } });
    toolCall = process.env.FAKE_CODEX_TOOL;
    const args = toolCall === "submit_review"
      ? { verdict: "changes-requested", summary: "needs revision", findings: ["define the input schema"], checks: ["read implementation", "ran tests"] }
      : toolCall === "request_clarification"
        ? { questions: ["Which target framework must be supported?"] }
        : { summary: "implemented feature", evidence: ["test passed"] };
    send({ method: "item/started", params: { turnId: currentTurn, item: { id: "tool-" + currentTurn, type: "dynamicToolCall", tool: toolCall, arguments: args, status: "inProgress" } } });
    send({ id: 900, method: "item/tool/call", params: { turnId: currentTurn, callId: "tool-" + currentTurn, tool: toolCall, arguments: args } });
  } else if (message.id === 900) {
    send({ method: "item/completed", params: { turnId: currentTurn, item: { id: "tool-" + currentTurn, type: "dynamicToolCall", tool: toolCall, status: message.result.success ? "completed" : "failed", success: message.result.success, contentItems: message.result.contentItems } } });
    const text = toolCall === "submit_review"
      ? "resumed answer"
      : toolCall === "request_clarification"
        ? "clarification answer"
        : "first answer";
    send({ method: "item/completed", params: { turnId: currentTurn, item: { id: "message-" + currentTurn, type: "agentMessage", text } } });
    send({ method: "thread/tokenUsage/updated", params: { turnId: currentTurn, tokenUsage: { last: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, cacheWriteInputTokens: 0, totalTokens: 12 }, total: { totalTokens: 12 }, modelContextWindow: 1000 } } });
    send({ method: "turn/completed", params: { turn: { id: currentTurn, status: "completed", items: [] } } });
  }
});
process.on("SIGTERM", () => process.exit(0));
`, "utf8");

    const sessions = new InMemoryRuntimeSessionStore();
    const adapter = new CodexRuntimeAdapter({
      id: "codex",
      cwd: directory,
      spec: { kind: "codex", command: process.execPath },
      accessMode: "workspace-write",
      fingerprint: "fingerprint-1",
      sessionStore: sessions,
      availability: { available: true, label: "fixture" },
    });
    process.env.FAKE_CODEX_TOOL = "complete_task";
    let declaredKind: string | undefined;
    const firstEvents: RuntimeEvent[] = [];
    const firstRequest = request("run-1", firstEvents);
    firstRequest.declareDeliverable = async (input) => {
      declaredKind = input.kind;
      return { accepted: true };
    };
    const first = await adapter.execute(firstRequest);
    assert.equal(first.output, "first answer");
    assert.equal(declaredKind, "completion");
    assert.deepEqual(firstEvents.filter((event) => event.type === "tool_start" || event.type === "tool_end").map((event) => event.type), ["tool_start", "tool_end"]);
    assert.equal(firstEvents.find((event) => event.type === "tool_start")?.toolName, "complete_task");
    assert.equal((await sessions.get("thread-1", "codex"))?.locator, "codex-session-123");

    process.env.FAKE_CODEX_TOOL = "submit_review";
    let review: SubmitReviewInput | undefined;
    const secondEvents: RuntimeEvent[] = [];
    const secondRequest = request("run-2", secondEvents);
    secondRequest.reviewOf = {
      taskRunId: "run-1",
      authorAgentId: "pi",
      round: 1,
      maxRounds: 2,
      reviewType: "verify",
      independent: true,
    };
    secondRequest.submitReview = async (input) => {
      review = input;
      return { accepted: true };
    };
    const second = await adapter.execute(secondRequest);
    assert.equal(second.output, "resumed answer");
    assert.equal(review?.verdict, "changes-requested");
    assert.deepEqual(review?.findings, ["define the input schema"]);
    assert.deepEqual(review?.checks, ["read implementation", "ran tests"]);
    assert.equal(secondEvents.find((event) => event.type === "tool_start")?.toolName, "submit_review");

    process.env.FAKE_CODEX_TOOL = "request_clarification";
    let clarificationQuestions: Array<string | { question: string; options?: Array<{ label: string; value?: string; recommended?: boolean }> }> | undefined;
    const thirdEvents: RuntimeEvent[] = [];
    const thirdRequest = request("run-3", thirdEvents);
    thirdRequest.requestClarification = async (input) => {
      clarificationQuestions = input.questions;
      return { accepted: true };
    };
    const third = await adapter.execute(thirdRequest);
    assert.equal(third.output, "clarification answer");
    assert.deepEqual(clarificationQuestions, ["Which target framework must be supported?"]);
    assert.equal(thirdEvents.find((event) => event.type === "tool_start")?.toolName, "request_clarification");

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { kind: string; value: Record<string, unknown> | string[] });
    const invocations = records.filter((record) => record.kind === "args");
    assert.deepEqual(invocations[0]?.value, ["app-server", "--stdio"]);
    assert.deepEqual(invocations[1]?.value, ["app-server", "--stdio"]);
    assert.deepEqual(invocations[2]?.value, ["app-server", "--stdio"]);
    const rpc = records.filter((record) => record.kind === "rpc").map((record) => record.value as Record<string, unknown>);
    const started = rpc.find((message) => message.method === "thread/start");
    const startParams = started?.params as { dynamicTools?: Array<{ name: string }> };
    assert.deepEqual(startParams.dynamicTools?.map((tool) => tool.name), ["post_message", "hold_ball", "submit_review", "request_clarification", "complete_task", "submit_plan"]);
    assert.equal(JSON.stringify(started).includes("mcp_servers"), false);
    assert.equal(rpc.some((message) => message.method === "thread/resume" && (message.params as { threadId?: string }).threadId === "codex-session-123"), true);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = previousLog;
    if (previousTool === undefined) delete process.env.FAKE_CODEX_TOOL;
    else process.env.FAKE_CODEX_TOOL = previousTool;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex adapter reports nonzero exits and cancels the child process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-codex-control-"));
  const fixture = join(directory, "app-server");
  const previousMode = process.env.FAKE_CODEX_MODE;
  try {
    await writeFile(fixture, `
if (process.env.FAKE_CODEX_MODE === "fail") {
  console.error("fixture failure");
  process.exit(7);
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`, "utf8");
    const adapter = new CodexRuntimeAdapter({
      id: "codex",
      cwd: directory,
      spec: { kind: "codex", command: process.execPath },
      accessMode: "read-only",
      fingerprint: "control",
      sessionStore: new InMemoryRuntimeSessionStore(),
      availability: { available: true, label: "fixture" },
    });
    process.env.FAKE_CODEX_MODE = "fail";
    await assert.rejects(adapter.execute(request("run-fail", [])), /exited with 7.*fixture failure/s);

    process.env.FAKE_CODEX_MODE = "hang";
    const controller = new AbortController();
    const execution = adapter.execute(request("run-cancel", [], controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort("fixture cancellation");
    await assert.rejects(execution, (error: unknown) => error instanceof Error && error.name === "AbortError" && /fixture cancellation/.test(error.message));
  } finally {
    if (previousMode === undefined) delete process.env.FAKE_CODEX_MODE;
    else process.env.FAKE_CODEX_MODE = previousMode;
    await rm(directory, { recursive: true, force: true });
  }
});

test("file session bindings stay isolated by thread and Agent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-sessions-"));
  try {
    const store = new FileRuntimeSessionStore(join(directory, "index.json"));
    const bindings = [
      { threadId: "thread-a", agentId: "pi", locator: "pi-a" },
      { threadId: "thread-a", agentId: "codex", locator: "codex-a" },
      { threadId: "thread-b", agentId: "pi", locator: "pi-b" },
    ] as const;
    await Promise.all(bindings.map((binding) => store.set({ ...binding, runtimeKind: binding.agentId === "pi" ? "pi" : "codex", fingerprint: "f1", updatedAt: new Date().toISOString() })));
    assert.equal((await store.get("thread-a", "pi"))?.locator, "pi-a");
    assert.equal((await store.get("thread-a", "codex"))?.locator, "codex-a");
    assert.equal((await store.get("thread-b", "pi"))?.locator, "pi-b");
    await store.set({ threadId: "thread-a", agentId: "pi", runtimeKind: "pi", fingerprint: "f2", locator: "pi-a-new", updatedAt: new Date().toISOString() });
    assert.deepEqual(await store.get("thread-a", "pi"), {
      threadId: "thread-a",
      agentId: "pi",
      runtimeKind: "pi",
      fingerprint: "f2",
      locator: "pi-a-new",
      updatedAt: (await store.get("thread-a", "pi"))?.updatedAt,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function request(runId: string, events: RuntimeEvent[], signal = new AbortController().signal): RuntimeRequest {
  const agent: AgentDefinition = {
    id: "codex",
    displayName: "Codex",
    description: "peer",
    systemPrompt: "Act as a peer.",
    capabilities: ["code"],
    enabled: true,
    accessMode: "workspace-write",
    runtime: { kind: "codex", command: "fake" },
  };
  return {
    runId,
    threadId: "thread-1",
    agent,
    roster: [agent],
    incoming: {
      id: `message-${runId}`,
      threadId: "thread-1",
      sender: { type: "human", id: "operator" },
      kind: "chat",
      mentions: ["codex"],
      content: "answer briefly",
      createdAt: new Date().toISOString(),
      causal: { chainId: `chain-${runId}`, depth: 0 },
    },
    context: {
      incoming: {
        id: `message-${runId}`,
        threadId: "thread-1",
        sender: { type: "human", id: "operator" },
        kind: "chat",
        mentions: ["codex"],
        content: "answer briefly",
        createdAt: new Date().toISOString(),
      },
      recentMessages: [],
      deliveryCursor: `message-${runId}`,
      truncated: false,
    },
    signal,
    emit: async (event) => { events.push(event); },
    postMessage: async () => ({ accepted: true, targets: [] }),
    holdBall: async () => ({ accepted: true, holdId: "hold-test" }),
    requestClarification: async () => ({ accepted: true }),
    declareDeliverable: async () => ({ accepted: true }),
  };
}
