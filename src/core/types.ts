export type Id = string;

export type AccessMode = "read-only" | "workspace-write" | "full";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface PiRuntimeSpec {
  kind: "pi";
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface CodexRuntimeSpec {
  kind: "codex";
  command: string;
  model?: string;
  profile?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export type RuntimeSpec = PiRuntimeSpec | CodexRuntimeSpec;

export interface AgentDefinition {
  id: Id;
  displayName: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  enabled: boolean;
  accessMode: AccessMode;
  runtime: RuntimeSpec;
}

export interface AgentCatalogV1 {
  version: 1;
  revision: number;
  defaultAgentId: Id;
  agents: AgentDefinition[];
}

export interface RuntimeAvailability {
  available: boolean;
  label: string;
  detail?: string;
}

export interface AgentSummary extends AgentDefinition {
  isDefault: boolean;
  availability: RuntimeAvailability;
}

export type MessageSender =
  | { type: "human"; id: string }
  | { type: "agent"; id: Id };

export interface CausalMetadata {
  chainId: Id;
  parentRunId?: Id;
  depth: number;
}

export type ThreadMessageKind = "chat" | "collaboration";

export interface ThreadMessage {
  id: Id;
  threadId: Id;
  sender: MessageSender;
  kind: ThreadMessageKind;
  mentions: Id[];
  content: string;
  intent?: string;
  createdAt: string;
  causal?: CausalMetadata;
  /** Legacy field accepted while replaying pre-catalog event logs. */
  recipientAgentId?: Id;
}

export interface Thread {
  id: Id;
  title: string;
  createdAt: string;
  workingDirectory?: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentRun {
  id: Id;
  threadId: Id;
  agentId: Id;
  incomingMessageId: Id;
  status: RunStatus;
  accessMode: AccessMode;
  causal: CausalMetadata;
  createdAt: string;
}

export type PlatformEventPayload =
  | { type: "thread.created"; thread: Thread }
  | { type: "message.created"; message: ThreadMessage }
  | { type: "run.queued"; run: AgentRun }
  | { type: "run.started"; runId: Id; threadId: Id; agentId: Id }
  | { type: "run.delta"; runId: Id; threadId: Id; agentId: Id; text: string }
  | {
      type: "run.tool";
      runId: Id;
      threadId: Id;
      agentId: Id;
      phase: "start" | "end";
      toolName: string;
      isError?: boolean;
    }
  | {
      type: "run.session";
      runId: Id;
      threadId: Id;
      agentId: Id;
      runtimeKind: RuntimeSpec["kind"];
      resumed: boolean;
    }
  | {
      type: "context.delivered";
      runId: Id;
      threadId: Id;
      agentId: Id;
      messageId: Id;
      truncated: boolean;
    }
  | {
      type: "run.completed";
      runId: Id;
      threadId: Id;
      agentId: Id;
      output: string;
    }
  | {
      type: "run.failed";
      runId: Id;
      threadId: Id;
      agentId: Id;
      error: string;
    }
  | {
      type: "run.cancelled";
      runId: Id;
      threadId: Id;
      agentId: Id;
      reason: string;
    }
  | {
      type: "run.interrupted";
      runId: Id;
      threadId: Id;
      agentId: Id;
      reason: string;
    }
  | {
      type: "routing.accepted";
      runId: Id;
      threadId: Id;
      messageId: Id;
      targetAgentId: Id;
      idempotencyKey: string;
    }
  | {
      type: "routing.rejected";
      runId: Id;
      threadId: Id;
      targetAgentId?: Id;
      reason: string;
      idempotencyKey?: string;
    };

export type StoredPlatformEvent = PlatformEventPayload & {
  eventId: Id;
  recordedAt: string;
};

export interface CompiledContext {
  incoming: ThreadMessage;
  recentMessages: ThreadMessage[];
  deliveryCursor: Id;
  truncated: boolean;
}
