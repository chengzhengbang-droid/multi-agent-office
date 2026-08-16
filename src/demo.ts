import { resolve } from "node:path";
import { createDemoAgents } from "./config/agents.js";
import { RecentContextCompiler } from "./core/context-compiler.js";
import { JsonlEventStore } from "./core/event-store.js";
import { MultiAgentPlatform } from "./core/platform.js";
import type { StoredPlatformEvent } from "./core/types.js";
import { DeterministicRuntime } from "./runtime/deterministic-runtime.js";

const prompt = process.argv.slice(2).join(" ").trim() ||
  "@pi @codex Independently assess the safest peer multi-Agent MVP.";
const agents = createDemoAgents();
const runtimes = new Map([
  ["pi", new DeterministicRuntime({ id: "pi" })],
  ["codex", new DeterministicRuntime({ id: "codex" })],
]);
const platform = new MultiAgentPlatform({
  agents,
  defaultAgentId: "codex",
  runtimes,
  eventStore: new JsonlEventStore(resolve(process.cwd(), ".data", "events.jsonl")),
  contextCompiler: new RecentContextCompiler(),
});

platform.subscribe(renderEvent);
console.log(`Input: ${prompt}\n`);
const result = await platform.postUserMessage({ content: prompt });
const messages = await platform.getThreadMessages(result.threadId);

console.log("\nFinal transcript");
console.log("----------------");
for (const message of messages) {
  const sender = message.sender.type === "human"
    ? `human:${message.sender.id}`
    : `agent:${message.sender.id}`;
  const mentions = message.mentions.length > 0
    ? ` → ${message.mentions.map((id) => `@${id}`).join(", ")}`
    : "";
  console.log(`\n[${sender}${mentions}; ${message.kind}]\n${message.content}`);
}

function renderEvent(event: StoredPlatformEvent): void {
  switch (event.type) {
    case "run.started":
      process.stdout.write(`\n▶ @${event.agentId}: `);
      break;
    case "run.delta":
      process.stdout.write(event.text);
      break;
    case "routing.accepted":
      process.stdout.write(`\n  routed → @${event.targetAgentId}\n`);
      break;
    case "routing.rejected":
      process.stdout.write(`\n  rejected: ${event.reason}\n`);
      break;
    case "run.completed":
      process.stdout.write("\n✓ completed\n");
      break;
    case "run.failed":
      process.stdout.write(`\n✗ failed: ${event.error}\n`);
      break;
    case "run.cancelled":
      process.stdout.write(`\n■ cancelled: ${event.reason}\n`);
      break;
    default:
      break;
  }
}
