import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  AccessMode,
  CodexRuntimeSpec,
  RuntimeAvailability,
} from "../core/types.js";
import { buildSystemPrompt, buildUserPrompt } from "./pi-runtime.js";
import type { RunCallbackRegistry } from "./callback-registry.js";
import type {
  AgentRuntime,
  RuntimeRequest,
  RuntimeResult,
} from "./runtime.js";
import type { RuntimeSessionStore } from "./session-store.js";

export interface CodexRuntimeAdapterOptions {
  id: string;
  cwd: string;
  spec: CodexRuntimeSpec;
  accessMode: AccessMode;
  fingerprint: string;
  sessionStore: RuntimeSessionStore;
  callbackRegistry: RunCallbackRegistry;
  callbackUrl: string;
  mcpCommand: string;
  mcpArgs: string[];
  availability?: RuntimeAvailability;
}

export class CodexRuntimeAdapter implements AgentRuntime {
  public readonly id: string;
  public readonly availability: RuntimeAvailability;
  private readonly activeProcesses = new Map<string, ChildProcessWithoutNullStreams>();

  public constructor(private readonly options: CodexRuntimeAdapterOptions) {
    this.id = options.id;
    this.availability = options.availability ?? resolveCodexAvailability(options.spec);
  }

  public async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const cwd = request.workingDirectory ?? this.options.cwd;
    const binding = await this.options.sessionStore.get(request.threadId, request.agent.id);
    const resumeSessionId =
      binding?.runtimeKind === "codex" && binding.fingerprint === this.options.fingerprint
        ? binding.locator
        : undefined;
    const callbackToken = this.options.callbackRegistry.issue({
      runId: request.runId,
      threadId: request.threadId,
      agentId: request.agent.id,
      postMessage: request.postMessage,
    });
    const args = this.buildArgs(cwd, resumeSessionId);
    const environment = codexEnvironment({
      callbackUrl: this.options.callbackUrl,
      callbackToken,
      runId: request.runId,
      threadId: request.threadId,
      agentId: request.agent.id,
    });
    const child = spawn(this.options.spec.command, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const exitPromise = waitForExit(child);
    this.activeProcesses.set(request.runId, child);

    let sessionId = resumeSessionId;
    let stderr = "";
    const outputParts: string[] = [];
    const completedItems = new Set<string>();
    let emissionQueue = Promise.resolve();
    const forward = (event: Parameters<RuntimeRequest["emit"]>[0]): void => {
      emissionQueue = emissionQueue.then(() => request.emit(event));
    };
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const projection = projectCodexJsonlEvent(event);
      if (!projection) return;
      if (projection.type === "session") {
        sessionId = projection.sessionId;
      } else if (projection.type === "text") {
        if (projection.itemId && completedItems.has(projection.itemId)) return;
        if (projection.itemId) completedItems.add(projection.itemId);
        outputParts.push(projection.text);
        forward({ type: "text_delta", text: projection.text });
      } else if (projection.type === "tool_start") {
        forward({ type: "tool_start", toolName: projection.toolName });
      } else if (projection.type === "tool_end") {
        if (projection.itemId && completedItems.has(projection.itemId)) return;
        if (projection.itemId) completedItems.add(projection.itemId);
        forward({
          type: "tool_end",
          toolName: projection.toolName,
          isError: projection.isError,
        });
      } else {
        stderr += `${projection.message}\n`;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8");
    });

    const onAbort = () => terminate(child);
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (request.signal.aborted) {
        terminate(child);
        throw abortError(request.signal.reason);
      }
      const prompt = [
        "<agent-system-instructions>",
        buildSystemPrompt(request),
        "</agent-system-instructions>",
        "",
        buildUserPrompt(request),
      ].join("\n");
      child.stdin.end(prompt, "utf8");
      await request.emit({ type: "session", runtimeKind: "codex", resumed: Boolean(resumeSessionId) });
      await request.emit({ type: "prompt_accepted" });
      const exit = await exitPromise;
      await emissionQueue;
      if (request.signal.aborted) throw abortError(request.signal.reason);
      if (sessionId) {
        await this.options.sessionStore.set({
          threadId: request.threadId,
          agentId: request.agent.id,
          runtimeKind: "codex",
          fingerprint: this.options.fingerprint,
          locator: sessionId,
          updatedAt: new Date().toISOString(),
        });
      }
      if (exit.code !== 0) {
        throw new Error(
          `Codex CLI exited with ${exit.code ?? exit.signal ?? "unknown status"}: ${stderr.trim().slice(-2_000) || "no diagnostic output"}`,
        );
      }
      return {
        output: outputParts.join("\n\n").trim() || "(Codex returned no text output)",
      };
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      stdout.close();
      this.options.callbackRegistry.revoke(callbackToken);
      this.activeProcesses.delete(request.runId);
    }
  }

  public async cancel(runId: string): Promise<void> {
    const child = this.activeProcesses.get(runId);
    if (child) terminate(child);
  }

  private buildArgs(cwd: string, resumeSessionId?: string): string[] {
    const config = [
      "-c",
      `approval_policy=${tomlString("never")}`,
      "-c",
      `sandbox_mode=${tomlString(accessSandbox(this.options.accessMode))}`,
      "-c",
      `mcp_servers.multi_agent.command=${tomlString(this.options.mcpCommand)}`,
      "-c",
      `mcp_servers.multi_agent.args=${JSON.stringify(this.options.mcpArgs)}`,
    ];
    if (this.options.spec.reasoningEffort) {
      config.push("-c", `model_reasoning_effort=${tomlString(this.options.spec.reasoningEffort)}`);
    }
    const model = this.options.spec.model ? ["--model", this.options.spec.model] : [];
    if (resumeSessionId) {
      return [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        ...config,
        ...model,
        resumeSessionId,
        "-",
      ];
    }
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--cd",
      cwd,
      ...config,
      ...model,
      ...(this.options.spec.profile ? ["--profile", this.options.spec.profile] : []),
      "-",
    ];
  }
}

export function resolveCodexAvailability(spec: CodexRuntimeSpec): RuntimeAvailability {
  const result = spawnSync(spec.command, ["login", "status"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error) {
    return { available: false, label: "Codex CLI", detail: result.error.message };
  }
  if (result.status !== 0) {
    if (process.env.OPENAI_API_KEY) {
      return {
        available: true,
        label: spec.model ? `Codex/${spec.model}` : "Codex/API key",
      };
    }
    return {
      available: false,
      label: "Codex CLI",
      detail: (result.stderr || result.stdout || "Codex is not logged in").trim(),
    };
  }
  return {
    available: true,
    label: spec.model ? `Codex/${spec.model}` : "Codex/default model",
  };
}

export type CodexJsonlProjection =
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string; itemId?: string }
  | { type: "tool_start"; toolName: string; itemId?: string }
  | { type: "tool_end"; toolName: string; itemId?: string; isError: boolean }
  | { type: "error"; message: string };

/** Pure JSONL projection used by the adapter and fixture tests. */
export function projectCodexJsonlEvent(value: unknown): CodexJsonlProjection | undefined {
  const record = asRecord(value);
  if (!record || typeof record.type !== "string") return undefined;
  if (record.type === "thread.started" && typeof record.thread_id === "string") {
    return { type: "session", sessionId: record.thread_id };
  }
  if (record.type === "turn.failed") {
    const error = asRecord(record.error);
    if (typeof error?.message === "string") return { type: "error", message: error.message };
    return { type: "error", message: "Codex turn failed" };
  }
  if (record.type === "error" && typeof record.message === "string") {
    return { type: "error", message: record.message };
  }
  const item = asRecord(record.item);
  const itemType = typeof item?.type === "string" ? item.type : undefined;
  if (!item || !itemType) return undefined;
  const itemId = typeof item.id === "string" ? item.id : undefined;
  if (record.type === "item.completed" && itemType === "agent_message" && typeof item.text === "string") {
    return { type: "text", text: item.text, ...(itemId ? { itemId } : {}) };
  }
  if (!isToolItem(itemType)) return undefined;
  const name = toolName(itemType, item);
  if (record.type === "item.started") {
    return { type: "tool_start", toolName: name, ...(itemId ? { itemId } : {}) };
  }
  if (record.type === "item.completed") {
    return {
      type: "tool_end",
      toolName: name,
      ...(itemId ? { itemId } : {}),
      isError:
        item.status === "failed" ||
        (typeof item.exit_code === "number" && item.exit_code !== 0) ||
        Boolean(item.error),
    };
  }
  return undefined;
}

function accessSandbox(accessMode: AccessMode): "read-only" | "workspace-write" {
  return accessMode === "read-only" ? "read-only" : "workspace-write";
}

function codexEnvironment(input: {
  callbackUrl: string;
  callbackToken: string;
  runId: string;
  threadId: string;
  agentId: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The packaged desktop app uses Electron's executable as a Node.js runtime
    // for the local MCP child process started by Codex.
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    MAO_CALLBACK_URL: input.callbackUrl,
    MAO_CALLBACK_TOKEN: input.callbackToken,
    MAO_CALLBACK_RUN_ID: input.runId,
    MAO_CALLBACK_THREAD_ID: input.threadId,
    MAO_CALLBACK_AGENT_ID: input.agentId,
  };
}

function toolName(itemType: string, item: Record<string, unknown>): string {
  if (itemType === "command_execution") return "command_execution";
  if (itemType === "file_change") return "file_change";
  if (itemType === "mcp_tool_call") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    return `mcp:${tool}`;
  }
  return itemType;
}

function isToolItem(itemType: string): boolean {
  return ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(itemType);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function terminate(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 2_000);
  timer.unref();
}

function abortError(reason: unknown): Error {
  const error = new Error(String(reason ?? "Aborted"));
  error.name = "AbortError";
  return error;
}
