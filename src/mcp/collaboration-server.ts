#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import type { PostAgentMessageResult } from "../runtime/runtime.js";

const callbackUrl = requiredEnv("MAO_CALLBACK_URL");
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

await server.connect(new StdioServerTransport());

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
