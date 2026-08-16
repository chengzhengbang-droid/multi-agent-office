import { resolve } from "node:path";
import { runtimeFingerprint } from "../config/agent-catalog.js";
import type { AgentDefinition, Id } from "../core/types.js";
import { CodexRuntimeAdapter } from "./codex-runtime.js";
import type { RunCallbackRegistry } from "./callback-registry.js";
import { PiRuntimeAdapter } from "./pi-runtime.js";
import type { AgentRuntime } from "./runtime.js";
import type { RuntimeSessionStore } from "./session-store.js";

export interface RuntimeFactoryOptions {
  projectRoot: string;
  sessionRoot?: string;
  sessionStore: RuntimeSessionStore;
  callbackRegistry: RunCallbackRegistry;
  callbackUrl: string;
  mcpCommand: string;
  mcpArgs: string[];
}

export function createAgentRuntimes(
  agents: AgentDefinition[],
  options: RuntimeFactoryOptions,
): Map<Id, AgentRuntime> {
  const runtimes = new Map<Id, AgentRuntime>();
  for (const agent of agents) {
    const fingerprint = runtimeFingerprint(agent);
    if (agent.runtime.kind === "pi") {
      runtimes.set(
        agent.id,
        new PiRuntimeAdapter({
          id: agent.id,
          cwd: options.projectRoot,
          spec: agent.runtime,
          fingerprint,
          sessionRoot:
            options.sessionRoot ?? resolve(options.projectRoot, ".data", "runtime-sessions"),
          sessionStore: options.sessionStore,
        }),
      );
    } else {
      runtimes.set(
        agent.id,
        new CodexRuntimeAdapter({
          id: agent.id,
          cwd: options.projectRoot,
          spec: agent.runtime,
          accessMode: agent.accessMode,
          fingerprint,
          sessionStore: options.sessionStore,
          callbackRegistry: options.callbackRegistry,
          callbackUrl: options.callbackUrl,
          mcpCommand: options.mcpCommand,
          mcpArgs: options.mcpArgs,
        }),
      );
    }
  }
  return runtimes;
}
