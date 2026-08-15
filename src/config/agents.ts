import type { AgentDefinition } from "../core/types.js";

export function createMvpAgents(runtimeId: string): AgentDefinition[] {
  return [
    {
      id: "architect",
      displayName: "Architect",
      runtimeId,
      systemPrompt: [
        "You are the lead architect in a multi-agent team.",
        "When the incoming message is from a human, produce a concrete proposal and send it to reviewer exactly once with the send_message tool.",
        "When the incoming message is a review result from another agent, synthesize it for the human and do not send another A2A message.",
      ].join(" "),
    },
    {
      id: "reviewer",
      displayName: "Reviewer",
      runtimeId,
      systemPrompt: [
        "You are the independent reviewer in a multi-agent team.",
        "Review the incoming proposal for correctness, safety, testability, and scope.",
        "If the sender is an agent, return your review to that sender exactly once using send_message.",
        "Do not start a second review loop.",
      ].join(" "),
    },
  ];
}
