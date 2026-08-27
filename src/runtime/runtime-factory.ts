import { resolve } from "node:path";
import { runtimeFingerprint } from "../config/agent-catalog.js";
import type { AgentDefinition, Id } from "../core/types.js";
import { CODEX_SESSION_PROTOCOL, CodexRuntimeAdapter } from "./codex-runtime.js";
import { PiRuntimeAdapter, resolvePiAvailability } from "./pi-runtime.js";
import { PiSharedRuntime } from "./pi-shared.js";
import type { AgentRuntime } from "./runtime.js";
import type { RuntimeSessionStore } from "./session-store.js";

export interface RuntimeFactoryOptions {
  projectRoot: string;
  sessionRoot?: string;
  sessionStore: RuntimeSessionStore;
  /** Shared Pi state; created on demand so each caller may supply its own. */
  piShared?: PiSharedRuntime;
}

export async function createAgentRuntimes(
  agents: AgentDefinition[],
  options: RuntimeFactoryOptions,
): Promise<Map<Id, AgentRuntime>> {
  const runtimes = new Map<Id, AgentRuntime>();
  const shared = options.piShared ?? new PiSharedRuntime();
  // Pi credentials live in auth.json as well as the environment, and reading
  // them needs the async ModelRuntime, so availability is resolved here rather
  // than in each adapter's constructor.
  const authProbe = agents.some((agent) => agent.runtime.kind === "pi")
    ? await shared.modelRuntime().catch(() => undefined)
    : undefined;
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
          shared,
          availability: resolvePiAvailability(agent.runtime, process.env, authProbe),
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
          fingerprint: `${fingerprint}:${CODEX_SESSION_PROTOCOL}`,
          sessionStore: options.sessionStore,
        }),
      );
    }
  }
  return runtimes;
}
