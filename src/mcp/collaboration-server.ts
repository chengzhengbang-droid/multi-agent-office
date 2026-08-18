#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type {
  PostAgentMessageResult,
  SubmitReviewResult,
} from "../runtime/runtime.js";

const callbackUrl = requiredEnv("MAO_CALLBACK_URL");
const reviewCallbackUrl = requiredEnv("MAO_REVIEW_CALLBACK_URL");
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
      "Record your verdict on work you were asked to review. Only available while reviewing another Agent's deliverable. Call it exactly once.",
    inputSchema: {
      verdict: z
        .enum(["approved", "changes-requested"])
        .describe("approved when the work can ship as is"),
      summary: z
        .string()
        .min(1)
        .max(20_000)
        .describe("Justification handed back to the author verbatim"),
      findings: z
        .array(z.string())
        .optional()
        .describe("Concrete, actionable changes. Required for changes-requested."),
    },
  },
  async ({ verdict, summary, findings }) => {
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

await server.connect(new StdioServerTransport());

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
