import assert from "node:assert/strict";
import { test } from "node:test";
import { createMvpAgents } from "../src/config/agents.js";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import { InMemoryEventStore } from "../src/core/event-store.js";
import { MultiAgentPlatform } from "../src/core/platform.js";
import type { StoredPlatformEvent } from "../src/core/types.js";
import { DeterministicRuntime } from "../src/runtime/deterministic-runtime.js";
import type {
  AgentRuntime,
  RuntimeRequest,
  RuntimeResult,
} from "../src/runtime/runtime.js";

test("runs architect -> reviewer -> architect without parsing output mentions", async () => {
  const store = new InMemoryEventStore();
  const runtime = new DeterministicRuntime({ stepDelayMs: 0 });
  const platform = createPlatform(runtime, store);

  const result = await platform.postUserMessage({
    content: "@architect Build a safe collaboration MVP",
  });
  const events = await platform.getEvents();
  const messages = await platform.getThreadMessages(result.threadId);

  assert.equal(countEvents(events, "run.completed"), 3);
  assert.equal(countEvents(events, "routing.accepted"), 2);
  assert.equal(countEvents(events, "routing.rejected"), 0);
  assert.deepEqual(
    messages
      .filter((message) => message.sender.type === "agent")
      .map((message) => message.sender.id),
    ["architect", "architect", "reviewer", "reviewer", "architect"],
  );
});

test("enforces the A2A depth limit", async () => {
  const store = new InMemoryEventStore();
  const runtime = new DeterministicRuntime({ stepDelayMs: 0 });
  const platform = createPlatform(runtime, store, { maxA2ADepth: 1 });

  await platform.postUserMessage({ content: "@architect Test the depth guard" });
  const events = await platform.getEvents();
  const rejection = events.find((event) => event.type === "routing.rejected");

  assert.equal(countEvents(events, "run.completed"), 2);
  assert.ok(rejection && rejection.type === "routing.rejected");
  assert.match(rejection.reason, /depth limit/i);
});

test("rejects duplicate structured A2A messages", async () => {
  const store = new InMemoryEventStore();
  const runtime = new DuplicateSendRuntime();
  const platform = createPlatform(runtime, store);

  await platform.postUserMessage({ content: "@architect Test deduplication" });
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "routing.accepted"), 1);
  assert.equal(countEvents(events, "routing.rejected"), 1);
  const rejection = events.find((event) => event.type === "routing.rejected");
  assert.ok(rejection && rejection.type === "routing.rejected");
  assert.match(rejection.reason, /duplicate/i);
});

test("replays thread messages from the append-only event store", async () => {
  const store = new InMemoryEventStore();
  const firstRuntime = new DeterministicRuntime({ stepDelayMs: 0 });
  const firstPlatform = createPlatform(firstRuntime, store);
  const { threadId } = await firstPlatform.postUserMessage({
    content: "@architect Persist this thread",
  });
  const original = await firstPlatform.getThreadMessages(threadId);

  const secondRuntime = new DeterministicRuntime({ stepDelayMs: 0 });
  const restoredPlatform = createPlatform(secondRuntime, store);
  const restored = await restoredPlatform.getThreadMessages(threadId);

  assert.deepEqual(restored, original);
});

test("cancels an active causal chain", async () => {
  const store = new InMemoryEventStore();
  const runtime = new DeterministicRuntime({ stepDelayMs: 500 });
  const platform = createPlatform(runtime, store);
  let rootRunId = "";
  let notifyQueued: (() => void) | undefined;
  const queued = new Promise<void>((resolve) => {
    notifyQueued = resolve;
  });
  platform.subscribe((event) => {
    if (event.type === "run.queued" && event.run.causal.depth === 0) {
      rootRunId = event.run.causal.rootRunId;
      notifyQueued?.();
    }
  });

  const posting = platform.postUserMessage({
    content: "@architect This should be cancelled",
  });
  await queued;
  await platform.cancelGroup(rootRunId);
  await posting;
  const events = await platform.getEvents();

  assert.equal(countEvents(events, "run.cancelled"), 1);
  assert.equal(countEvents(events, "run.completed"), 0);
});

function createPlatform(
  runtime: AgentRuntime,
  eventStore: InMemoryEventStore,
  policy: { maxA2ADepth?: number } = {},
): MultiAgentPlatform {
  return new MultiAgentPlatform({
    agents: createMvpAgents(runtime.id),
    runtimes: [runtime],
    eventStore,
    contextCompiler: new RecentContextCompiler(),
    maxA2ADepth: policy.maxA2ADepth ?? 4,
    maxAgentRunsPerChain: 8,
  });
}

function countEvents(
  events: StoredPlatformEvent[],
  type: StoredPlatformEvent["type"],
): number {
  return events.filter((event) => event.type === type).length;
}

class DuplicateSendRuntime implements AgentRuntime {
  public readonly id = "duplicate-send";

  public async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.agent.id === "architect") {
      const message = {
        to: "reviewer",
        content: "Review this once",
        intent: "review",
        idempotencyKey: "same-logical-message",
      };
      await request.sendMessage(message);
      await request.sendMessage(message);
    }
    return { output: "done" };
  }

  public async cancel(): Promise<void> {}
}
