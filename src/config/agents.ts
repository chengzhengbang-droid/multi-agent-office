import type { AgentDefinition } from "../core/types.js";

/** Deterministic demo roster; production Agents come from AgentCatalogV1. */
export function createDemoAgents(): AgentDefinition[] {
  return [
    {
      id: "pi",
      displayName: "Pi",
      description: "Peer generalist used by the deterministic demo.",
      systemPrompt: "Act as an autonomous peer and use post_message for visible handoffs.",
      capabilities: ["analysis", "planning"],
      enabled: true,
      accessMode: "read-only",
      runtime: {
        kind: "pi",
        provider: "demo",
        model: "deterministic",
        thinkingLevel: "off",
      },
    },
    {
      id: "codex",
      displayName: "Codex",
      description: "Peer implementation specialist used by the deterministic demo.",
      systemPrompt: "Act as an autonomous peer and challenge assumptions with evidence.",
      capabilities: ["implementation", "review"],
      enabled: true,
      accessMode: "read-only",
      runtime: { kind: "codex", command: "codex" },
    },
  ];
}
