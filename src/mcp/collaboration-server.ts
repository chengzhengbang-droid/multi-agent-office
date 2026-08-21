#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type {
  DeclareDeliverableResult,
  PostAgentMessageResult,
  SubmitReviewResult,
} from "../runtime/runtime.js";

const callbackUrl = requiredEnv("MAO_CALLBACK_URL");
const reviewCallbackUrl = requiredEnv("MAO_REVIEW_CALLBACK_URL");
const deliverableCallbackUrl = requiredEnv("MAO_DELIVERABLE_CALLBACK_URL");
const callbackToken = requiredEnv("MAO_CALLBACK_TOKEN");
const runId = requiredEnv("MAO_CALLBACK_RUN_ID");
const threadId = requiredEnv("MAO_CALLBACK_THREAD_ID");
const agentId = requiredEnv("MAO_CALLBACK_AGENT_ID");

const server = new McpServer({ name: "multi-agent-office", version: "0.2.0" });
server.registerTool(
  "post_message",
  {
    description:
      "Post a visible message to the shared multi-Agent thread. Put a teammate's @handle at the start of a line to wake them.",
    inputSchema: {
      content: z.string().min(1).max(20_000).describe("Visible shared-thread message"),
      intent: z.string().optional().describe("Short collaboration intent"),
      idempotencyKey: z.string().min(1).describe("Unique key for this logical post"),
    },
  },
  async ({ content, intent, idempotencyKey }) => {
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${callbackToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runId,
        threadId,
        agentId,
        content,
        idempotencyKey,
        ...(intent ? { intent } : {}),
      }),
    });
    const result = (await response.json()) as PostAgentMessageResult & { error?: string };
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: result.error ?? "Collaboration callback failed" }],
      };
    }
    return {
      isError: !result.accepted,
      content: [
        {
          type: "text",
          text: result.accepted
            ? result.targets.length > 0
              ? `Visible message routed to ${result.targets.map((id) => `@${id}`).join(", ")}.`
              : "Visible message posted without waking another Agent."
            : `Message routing rejected: ${result.reason ?? "unknown reason"}`,
        },
      ],
      structuredContent: { ...result },
    };
  },
);

// Declared on every run so a resumed Codex session sees a stable tool surface.
// The platform refuses any verdict from a run that is not reviewing someone
// else's work, so declaring it here cannot let an Agent approve itself.
server.registerTool(
  "submit_review",
  {
    description:
      "Record your verdict on work you were asked to review. Only available while reviewing another Agent's deliverable. Call it exactly once. You are an independent skeptic: approve only what you checked yourself.",
    inputSchema: {
      verdict: z
        .enum(["approved", "changes-requested"])
        .describe("approved only when your own checks show the work can ship as is"),
      summary: z
        .string()
        .min(1)
        .max(20_000)
        .describe("Justification handed back to the author verbatim"),
      findings: z
        .array(z.string())
        .optional()
        .describe("Concrete, actionable changes. Required for changes-requested."),
      checks: z
        .array(z.string())
        .optional()
        .describe(
          "What you verified yourself: files read, commands run, output observed. Required for approved — the author's own evidence does not count.",
        ),
    },
  },
  async ({ verdict, summary, findings, checks }) => {
    const response = await fetch(reviewCallbackUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${callbackToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runId,
        threadId,
        agentId,
        verdict,
        summary,
        ...(findings ? { findings } : {}),
        ...(checks ? { checks } : {}),
      }),
    });
    const result = (await response.json()) as SubmitReviewResult & { error?: string };
    if (!response.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: result.error ?? "Review callback failed" }],
      };
    }
    return {
      isError: !result.accepted,
      content: [
        {
          type: "text",
          text: result.accepted
            ? `Verdict recorded: ${verdict}.`
            : `Verdict rejected: ${result.reason ?? "unknown reason"}`,
        },
      ],
      structuredContent: { ...result },
    };
  },
);

// An Agent decides for itself whether its output is a deliverable. Declaring
// one is what opens the review gate; the platform rejects declarations that do
// not belong to a live task run, so this cannot be used to self-approve.
for (const tool of [
  {
    name: "complete_task",
    kind: "completion" as const,
    description:
      "Call when you have FINISHED work a human asked for and produced a real deliverable. Include evidence a reviewer can check: files you changed, commands you ran, how to verify it. This submits your work to a peer for verification — your own word that it is done is not enough. Do not call it for conversation, questions, or explanations.",
    summaryHint: "What you delivered, in your own words",
    evidenceHint:
      "How a reviewer can check the claim: files changed, commands run, tests to execute.",
    accepted: "Completed work submitted for peer verification.",
  },
  {
    name: "submit_plan",
    kind: "plan" as const,
    description:
      "Call when your output is a plan, design, or proposal that should be pressure-tested by a peer before anyone executes it. A teammate will critique it and you get one revision round. Do not call it for conversation or for work already finished — use complete_task for that.",
    summaryHint: "The plan you are proposing, in your own words",
    evidenceHint: "Assumptions, constraints, or open questions a reviewer should weigh.",
    accepted: "Plan submitted for peer critique.",
  },
]) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: {
        summary: z.string().min(1).max(20_000).describe(tool.summaryHint),
        evidence: z.array(z.string()).optional().describe(tool.evidenceHint),
      },
    },
    async ({ summary, evidence }) => {
      const response = await fetch(deliverableCallbackUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${callbackToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId,
          threadId,
          agentId,
          kind: tool.kind,
          summary,
          ...(evidence ? { evidence } : {}),
        }),
      });
      const result = (await response.json()) as DeclareDeliverableResult & { error?: string };
      if (!response.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: result.error ?? "Deliverable callback failed" }],
        };
      }
      return {
        isError: !result.accepted,
        content: [
          {
            type: "text",
            text: result.accepted
              ? tool.accepted
              : `Declaration rejected: ${result.reason ?? "unknown reason"}`,
          },
        ],
        structuredContent: { ...result },
      };
    },
  );
}

await server.connect(new StdioServerTransport());

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
