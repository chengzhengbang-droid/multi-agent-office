import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import { InMemoryEventStore, JsonlEventStore } from "../src/core/event-store.js";
import { MultiAgentPlatform } from "../src/core/platform.js";
import type { AgentDefinition, StoredPlatformEvent } from "../src/core/types.js";
import { DeterministicRuntime } from "../src/runtime/deterministic-runtime.js";

test("legacy recipientAgentId and rootRunId fields normalize on replay", async () => {
  const store = new InMemoryEventStore();
  const recordedAt = "2026-01-01T00:00:00.000Z";
  for (const event of [
    { type: "thread.created", thread: { id: "thread-old", title: "old", createdAt: recordedAt }, eventId: "event-1", recordedAt },
    { type: "message.created", message: { id: "message-old", threadId: "thread-old", sender: { type: "human", id: "operator" }, recipientAgentId: "architect", content: "@architect old", createdAt: recordedAt, causal: { rootRunId: "run-old", abortGroupId: "run-old", depth: 0 } }, eventId: "event-2", recordedAt },
    { type: "run.queued", run: { id: "run-old", threadId: "thread-old", agentId: "architect", incomingMessageId: "message-old", status: "queued", causal: { rootRunId: "run-old", abortGroupId: "run-old", depth: 0 }, createdAt: recordedAt }, eventId: "event-3", recordedAt },
    { type: "run.completed", runId: "run-old", threadId: "thread-old", agentId: "architect", output: "done", eventId: "event-4", recordedAt },
  ]) await store.append(event as unknown as StoredPlatformEvent);
  const platform = createPlatform(store, ["architect"]);
  await platform.initialize();
  const events = await platform.getEvents();
  const message = events.find((event) => event.type === "message.created");
  const run = events.find((event) => event.type === "run.queued");
  assert.equal(message?.type, "message.created");
  if (message?.type === "message.created") {
    assert.equal(message.message.kind, "chat");
    assert.deepEqual(message.message.mentions, ["architect"]);
    assert.equal(message.message.causal?.chainId, "run-old");
  }
  assert.equal(run?.type, "run.queued");
  if (run?.type === "run.queued") {
    assert.equal(run.run.causal.chainId, "run-old");
    assert.equal(run.run.accessMode, "read-only");
  }
});

test("the existing event log replays without rewriting the source", async (context) => {
  const source = resolve(".data", "events.jsonl");
  if (!existsSync(source)) {
    context.skip("workspace history is not present in this checkout");
    return;
  }
  const before = await readFile(source, "utf8");
  const lines = before.split("\n").filter(Boolean);
  const rawEvents = lines.map((line) => JSON.parse(line) as StoredPlatformEvent);
  const ids = historicalAgentIds(rawEvents);
  const directory = await mkdtemp(join(tmpdir(), "mao-history-"));
  const copy = join(directory, "events.jsonl");
  try {
    await copyFile(source, copy);
    const platform = createPlatform(new JsonlEventStore(copy), ids);
    await platform.initialize();
    const replayed = await platform.getEvents();
    assert.ok(replayed.length >= rawEvents.length);
    assert.ok(lines.length > 0);
    for (const event of replayed) {
      if (event.type === "message.created") {
        assert.ok(event.message.kind === "chat" || event.message.kind === "collaboration");
        assert.ok(Array.isArray(event.message.mentions));
      }
      if (event.type === "run.queued") {
        assert.ok(event.run.causal.chainId);
        assert.ok(event.run.accessMode);
      }
    }
    assert.equal(await readFile(source, "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart resumes queued work but marks a previously running call interrupted", async () => {
  const queuedStore = await recoveryStore(false);
  const queuedPlatform = createPlatform(queuedStore, ["codex"]);
  await queuedPlatform.initialize();
  await waitFor(async () => (await queuedPlatform.getEvents()).some((event) => event.type === "run.completed"));
  assert.equal((await queuedPlatform.getEvents()).filter((event) => event.type === "run.completed").length, 1);

  const runningStore = await recoveryStore(true);
  const runningPlatform = createPlatform(runningStore, ["codex"]);
  await runningPlatform.initialize();
  const runningEvents = await runningPlatform.getEvents();
  assert.equal(runningEvents.filter((event) => event.type === "run.interrupted").length, 1);
  assert.equal(runningEvents.filter((event) => event.type === "run.completed").length, 0);
});

function createPlatform(eventStore: InMemoryEventStore | JsonlEventStore, ids: string[]): MultiAgentPlatform {
  const safeIds = ids.length > 0 ? ids : ["codex"];
  const agents = safeIds.map(agent);
  return new MultiAgentPlatform({
    agents,
    defaultAgentId: agents[0]!.id,
    runtimes: new Map(agents.map((definition) => [definition.id, new DeterministicRuntime({ id: definition.id, stepDelayMs: 0 })])),
    eventStore,
    contextCompiler: new RecentContextCompiler(),
  });
}

function historicalAgentIds(events: StoredPlatformEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "run.queued") ids.add(event.run.agentId);
    else if ("agentId" in event && typeof event.agentId === "string") ids.add(event.agentId);
    else if (event.type === "message.created" && event.message.sender.type === "agent") ids.add(event.message.sender.id);
  }
  return [...ids];
}

function agent(id: string): AgentDefinition {
  return {
    id,
    displayName: id,
    description: "historical peer",
    systemPrompt: "peer",
    capabilities: [],
    enabled: true,
    accessMode: "read-only",
    runtime: { kind: "pi", provider: "fixture", model: "fixture", thinkingLevel: "off" },
  };
}

async function recoveryStore(started: boolean): Promise<InMemoryEventStore> {
  const store = new InMemoryEventStore();
  const recordedAt = "2026-01-01T00:00:00.000Z";
  const events = [
    { type: "thread.created", thread: { id: "thread-recovery", title: "recover", createdAt: recordedAt }, eventId: "recovery-1", recordedAt },
    { type: "message.created", message: { id: "message-recovery", threadId: "thread-recovery", sender: { type: "human", id: "operator" }, kind: "chat", mentions: ["codex"], content: "recover", createdAt: recordedAt, causal: { chainId: "chain-recovery", depth: 0 } }, eventId: "recovery-2", recordedAt },
    { type: "run.queued", run: { id: "run-recovery", threadId: "thread-recovery", agentId: "codex", incomingMessageId: "message-recovery", status: "queued", accessMode: "read-only", causal: { chainId: "chain-recovery", depth: 0 }, createdAt: recordedAt }, eventId: "recovery-3", recordedAt },
    ...(started ? [{ type: "run.started", runId: "run-recovery", threadId: "thread-recovery", agentId: "codex", eventId: "recovery-4", recordedAt }] : []),
  ];
  for (const event of events) await store.append(event as StoredPlatformEvent);
  return store;
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for recovered run");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
