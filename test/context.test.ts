import assert from "node:assert/strict";
import { test } from "node:test";
import { RecentContextCompiler } from "../src/core/context-compiler.js";
import type { AgentDefinition, ThreadMessage } from "../src/core/types.js";

test("new Agent entry receives only the recent bounded shared context", async () => {
  const compiler = new RecentContextCompiler({ maxMessages: 2, maxCharacters: 100 });
  const messages = [message("m1", "human", "one"), message("m2", "agent", "two", "codex"), message("m3", "human", "three"), message("m4", "human", "incoming")];
  const context = await compiler.compile({ agent: peer("pi"), incoming: messages[3]!, threadMessages: messages });
  assert.deepEqual(context.recentMessages.map((item) => item.id), ["m2", "m3"]);
  assert.equal(context.deliveryCursor, "m4");
  assert.equal(context.truncated, true);
});

test("continued Agent sessions receive unseen peer messages but not their own persisted output", async () => {
  const compiler = new RecentContextCompiler();
  const messages = [
    message("m1", "human", "first"),
    message("m2", "agent", "own answer", "pi"),
    message("m3", "agent", "peer update", "codex"),
    message("m4", "human", "continue"),
  ];
  const context = await compiler.compile({ agent: peer("pi"), incoming: messages[3]!, threadMessages: messages, lastDeliveredMessageId: "m1" });
  assert.deepEqual(context.recentMessages.map((item) => item.id), ["m3"]);
});

test("context compiler emits a visible truncation flag for its character budget", async () => {
  const compiler = new RecentContextCompiler({ maxMessages: 20, maxCharacters: 5 });
  const messages = [message("m1", "human", "123456"), message("m2", "human", "ok"), message("m3", "human", "incoming")];
  const context = await compiler.compile({ agent: peer("pi"), incoming: messages[2]!, threadMessages: messages });
  assert.deepEqual(context.recentMessages.map((item) => item.id), ["m2"]);
  assert.equal(context.truncated, true);
});

function peer(id: string): AgentDefinition {
  return { id, displayName: id, description: "peer", systemPrompt: "peer", capabilities: [], enabled: true, accessMode: "read-only", runtime: { kind: "pi", provider: "fixture", model: "fixture", thinkingLevel: "off" } };
}

function message(id: string, senderType: "human" | "agent", content: string, senderId = "operator"): ThreadMessage {
  return { id, threadId: "thread", sender: { type: senderType, id: senderId }, kind: "chat", mentions: [], content, createdAt: "2026-01-01T00:00:00.000Z" };
}
