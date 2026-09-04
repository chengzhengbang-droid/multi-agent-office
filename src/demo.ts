import { resolve } from "node:path";
import { createDemoAgents } from "./config/agents.js";
import { RecentContextCompiler } from "./core/context-compiler.js";
import { JsonlEventStore } from "./core/event-store.js";
import { MultiAgentPlatform } from "./core/platform.js";
import type { StoredPlatformEvent } from "./core/types.js";
import { DeterministicRuntime } from "./runtime/deterministic-runtime.js";

const argv = process.argv.slice(2);
// --plan runs the demo through the plan gate, and answers it the way a human
// would, so the whole pipeline is visible in one command.
const planMode = argv.includes("--plan");
const planDecision = argv.includes("--reject") ? "rejected" : "approved";
const prompt = argv.filter((value) => !value.startsWith("--")).join(" ").trim() ||
  (planMode
    ? "@codex Plan the safest peer multi-Agent MVP."
    : "@pi @codex Independently assess the safest peer multi-Agent MVP.");
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
  reviewMode:
    process.env.MAO_REVIEW_GATE === "off"
      ? "off"
      : process.env.MAO_REVIEW_GATE === "on" || process.env.MAO_REVIEW_GATE === "required"
        ? "required"
        : "smart",
  maxReviewRounds: Number(process.env.MAO_MAX_REVIEW_ROUNDS ?? 4),
  maxStalledRounds: Number(process.env.MAO_REVIEW_STALL_ROUNDS ?? 2),
});

platform.subscribe(renderEvent);
console.log(`Input: ${prompt}\n`);
const result = await platform.postUserMessage({ content: prompt, ...(planMode ? { planMode: true } : {}) });
for (const approval of await platform.getPendingPlanApprovals(result.threadId)) {
  process.stdout.write(`\n  answering the plan gate as the human: ${planDecision}\n`);
  await platform.decidePlan({
    taskRunId: approval.taskRunId,
    decision: planDecision,
    ...(planDecision === "rejected" ? { note: "Demo rejection: say how this rolls back." } : {}),
  });
}
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
    case "review.requested":
      process.stdout.write(`\n  review round ${event.round} → @${event.reviewerAgentId}\n`);
      break;
    case "review.submitted":
      process.stdout.write(`\n  verdict from @${event.reviewerAgentId}: ${event.verdict}\n`);
      break;
    case "review.rework":
      process.stdout.write(`\n  sent back to @${event.authorAgentId} for rework\n`);
      break;
    case "review.resolved":
      process.stdout.write(`\n★ review ${event.outcome}${event.escalation ? ` (${event.escalation})` : ""} after ${event.rounds} round(s)\n`);
      break;
    case "plan.awaiting-approval":
      process.stdout.write(`\n⏸ plan from @${event.authorAgentId} awaits the human (peer: ${event.peerOutcome})\n`);
      break;
    case "plan.decided":
      process.stdout.write(`\n★ human ${event.decision} the plan\n`);
      break;
    default:
      break;
  }
}
