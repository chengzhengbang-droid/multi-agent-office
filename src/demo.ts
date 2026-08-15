import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { createMvpAgents } from "./config/agents.js";
import { RecentContextCompiler } from "./core/context-compiler.js";
import { JsonlEventStore } from "./core/event-store.js";
import { MultiAgentPlatform } from "./core/platform.js";
import type { StoredPlatformEvent } from "./core/types.js";
import { DeterministicRuntime } from "./runtime/deterministic-runtime.js";
import { PiRuntimeAdapter } from "./runtime/pi-runtime.js";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  loadEnvFile(envPath);
}

const args = process.argv.slice(2);
const usePi = args.includes("--runtime=pi");
const allowPiWrite = args.includes("--pi-write");
const provider =
  readOption(args, "provider") ??
  process.env.MAO_PI_PROVIDER ??
  (usePi ? "zai-coding-cn" : undefined);
const model =
  readOption(args, "model") ??
  process.env.MAO_PI_MODEL ??
  (usePi ? "glm-5.2" : undefined);
const thinkingLevel = parseThinkingLevel(
  readOption(args, "thinking") ??
    process.env.MAO_PI_THINKING ??
    (usePi ? "medium" : undefined),
);
const prompt = args
  .filter((arg) => !arg.startsWith("--"))
  .join(" ")
  .trim() || "@architect Design the first safe multi-agent MVP.";

const runtime = usePi
  ? new PiRuntimeAdapter({
      cwd: process.cwd(),
      allowWriteTools: allowPiWrite,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
    })
  : new DeterministicRuntime();
const eventStore = new JsonlEventStore(
  resolve(process.cwd(), ".data", "events.jsonl"),
);
const platform = new MultiAgentPlatform({
  agents: createMvpAgents(runtime.id),
  runtimes: [runtime],
  eventStore,
  contextCompiler: new RecentContextCompiler(),
  maxA2ADepth: 4,
  maxAgentRunsPerChain: 8,
});

platform.subscribe(renderEvent);

console.log(`Runtime: ${runtime.id}`);
if (usePi && provider && model) {
  console.log(`Model: ${provider}/${model}${thinkingLevel ? `:${thinkingLevel}` : ""}`);
}
console.log(`Input: ${prompt}\n`);
const result = await platform.postUserMessage({ content: prompt });
const messages = await platform.getThreadMessages(result.threadId);

console.log("\nFinal transcript");
console.log("----------------");
for (const message of messages) {
  const sender =
    message.sender.type === "human"
      ? `human:${message.sender.id}`
      : `agent:${message.sender.id}`;
  const recipient = message.recipientAgentId
    ? ` -> @${message.recipientAgentId}`
    : "";
  console.log(`\n[${sender}${recipient}]\n${message.content}`);
}
console.log(`\nEvent log: ${resolve(process.cwd(), ".data", "events.jsonl")}`);

function renderEvent(event: StoredPlatformEvent): void {
  switch (event.type) {
    case "run.started":
      process.stdout.write(`\n▶ @${event.agentId}: `);
      break;
    case "run.delta":
      process.stdout.write(event.text);
      break;
    case "run.tool":
      if (event.phase === "start") {
        process.stdout.write(`\n  [tool:${event.toolName}] `);
      }
      break;
    case "routing.accepted":
      process.stdout.write(`queued → @${event.targetAgentId}\n`);
      break;
    case "routing.rejected":
      process.stdout.write(`rejected → @${event.targetAgentId}: ${event.reason}\n`);
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

function readOption(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function parseThinkingLevel(
  value: string | undefined,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!value) {
    return undefined;
  }
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (!levels.has(value)) {
    throw new Error(`Invalid MAO_PI_THINKING value: ${value}`);
  }
  return value as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
