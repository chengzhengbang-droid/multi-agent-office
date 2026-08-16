import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentDefinition } from "../src/core/types.js";
import { RunCallbackRegistry } from "../src/runtime/callback-registry.js";
import {
  CodexRuntimeAdapter,
  projectCodexJsonlEvent,
} from "../src/runtime/codex-runtime.js";
import type { RuntimeEvent, RuntimeRequest } from "../src/runtime/runtime.js";
import {
  piToolsForAccess,
  resolvePiAvailability,
} from "../src/runtime/pi-runtime.js";
import {
  FileRuntimeSessionStore,
  InMemoryRuntimeSessionStore,
} from "../src/runtime/session-store.js";

test("Codex JSONL projection separates messages, tools, errors, and sessions", () => {
  assert.deepEqual(projectCodexJsonlEvent({ type: "thread.started", thread_id: "thread-1" }), { type: "session", sessionId: "thread-1" });
  assert.deepEqual(projectCodexJsonlEvent({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "hello" } }), { type: "text", text: "hello", itemId: "m1" });
  assert.deepEqual(projectCodexJsonlEvent({ type: "item.started", item: { id: "c1", type: "command_execution" } }), { type: "tool_start", toolName: "command_execution", itemId: "c1" });
  assert.deepEqual(projectCodexJsonlEvent({ type: "item.completed", item: { id: "c1", type: "command_execution", exit_code: 1 } }), { type: "tool_end", toolName: "command_execution", itemId: "c1", isError: true });
  assert.equal(projectCodexJsonlEvent({ type: "item.completed", item: { id: "r1", type: "reasoning", text: "hidden" } }), undefined);
  assert.deepEqual(projectCodexJsonlEvent({ type: "turn.failed", error: { message: "bad turn" } }), { type: "error", message: "bad turn" });
});

test("Pi access modes expose the intended Bash/edit/write capabilities", () => {
  assert.deepEqual(piToolsForAccess("read-only"), ["read", "grep", "find", "ls", "post_message"]);
  assert.equal(piToolsForAccess("workspace-write").includes("bash"), false);
  assert.equal(piToolsForAccess("workspace-write").includes("edit"), true);
  assert.equal(piToolsForAccess("full").includes("bash"), true);
  assert.equal(piToolsForAccess("full").includes("write"), true);
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

test("run callback tokens are scoped to one run identity and expire", async () => {
  const registry = new RunCallbackRegistry();
  const seen: string[] = [];
  const token = registry.issue({
    runId: "run-1",
    threadId: "thread-1",
    agentId: "codex",
    postMessage: async (input) => {
      seen.push(input.content);
      return { accepted: true, targets: ["pi"], messageId: "message-1" };
    },
  });
  const request = {
    runId: "run-1",
    threadId: "thread-1",
    agentId: "codex",
    content: "@pi review",
    idempotencyKey: "once",
  };
  assert.deepEqual(await registry.invoke(token, request), { accepted: true, targets: ["pi"], messageId: "message-1" });
  assert.deepEqual(seen, ["@pi review"]);
  await assert.rejects(registry.invoke(token, { ...request, agentId: "pi" }), /identity does not match/);
  registry.revoke(token);
  await assert.rejects(registry.invoke(token, request), /invalid or expired/);
});

test("Codex adapter starts with exec JSONL and resumes the saved CLI thread", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-codex-fixture-"));
  const command = join(directory, "fake-codex.mjs");
  const logPath = join(directory, "args.jsonl");
  const previousLog = process.env.FAKE_CODEX_LOG;
  process.env.FAKE_CODEX_LOG = logPath;
  try {
    await writeFile(command, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\\n");
const resumed = args.includes("resume");
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-123" }));
console.log(JSON.stringify({ type: "item.completed", item: { id: "reason", type: "reasoning", text: "hidden" } }));
if (!resumed) {
  console.log(JSON.stringify({ type: "item.started", item: { id: "tool", type: "command_execution" } }));
  console.log(JSON.stringify({ type: "item.completed", item: { id: "tool", type: "command_execution", exit_code: 0 } }));
}
console.log(JSON.stringify({ type: "item.completed", item: { id: resumed ? "m2" : "m1", type: "agent_message", text: resumed ? "resumed answer" : "first answer" } }));
`, "utf8");
    await chmod(command, 0o755);

    const sessions = new InMemoryRuntimeSessionStore();
    const callbacks = new RunCallbackRegistry();
    const adapter = new CodexRuntimeAdapter({
      id: "codex",
      cwd: directory,
      spec: { kind: "codex", command },
      accessMode: "workspace-write",
      fingerprint: "fingerprint-1",
      sessionStore: sessions,
      callbackRegistry: callbacks,
      callbackUrl: "http://127.0.0.1:9/internal/agent-message",
      mcpCommand: process.execPath,
      mcpArgs: ["fake-mcp.js"],
      availability: { available: true, label: "fixture" },
    });
    const firstEvents: RuntimeEvent[] = [];
    const first = await adapter.execute(request("run-1", firstEvents));
    assert.equal(first.output, "first answer");
    assert.deepEqual(firstEvents.filter((event) => event.type === "tool_start" || event.type === "tool_end").map((event) => event.type), ["tool_start", "tool_end"]);
    assert.equal((await sessions.get("thread-1", "codex"))?.locator, "codex-session-123");

    const secondEvents: RuntimeEvent[] = [];
    const second = await adapter.execute(request("run-2", secondEvents));
    assert.equal(second.output, "resumed answer");
    assert.equal(secondEvents.find((event) => event.type === "session")?.type, "session");
    const invocations = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    assert.deepEqual(invocations[0]?.slice(0, 2), ["exec", "--json"]);
    assert.equal(invocations[0]?.includes("sandbox_mode=\"workspace-write\""), true);
    assert.deepEqual(invocations[1]?.slice(0, 2), ["exec", "resume"]);
    assert.equal(invocations[1]?.includes("codex-session-123"), true);
  } finally {
    if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
    else process.env.FAKE_CODEX_LOG = previousLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex adapter reports nonzero exits and cancels the child process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-codex-control-"));
  const command = join(directory, "controlled-codex.mjs");
  const previousMode = process.env.FAKE_CODEX_MODE;
  try {
    await writeFile(command, `#!/usr/bin/env node
if (process.env.FAKE_CODEX_MODE === "fail") {
  console.error("fixture failure");
  process.exit(7);
}
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`, "utf8");
    await chmod(command, 0o755);
    const adapter = new CodexRuntimeAdapter({
      id: "codex",
      cwd: directory,
      spec: { kind: "codex", command },
      accessMode: "read-only",
      fingerprint: "control",
      sessionStore: new InMemoryRuntimeSessionStore(),
      callbackRegistry: new RunCallbackRegistry(),
      callbackUrl: "http://127.0.0.1:9/internal/agent-message",
      mcpCommand: process.execPath,
      mcpArgs: ["fake-mcp.js"],
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
  };
}
