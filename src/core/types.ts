export type Id = string;

export interface AgentDefinition {
  id: Id;
  displayName: string;
  runtimeId: string;
  systemPrompt: string;
}

export type MessageSender =
  | { type: "human"; id: string }
  | { type: "agent"; id: Id };

export interface CausalMetadata {
  rootRunId: Id;
  parentRunId?: Id;
  depth: number;
  abortGroupId: Id;
}

export interface ThreadMessage {
  id: Id;
  threadId: Id;
  sender: MessageSender;
  recipientAgentId?: Id;
  content: string;
  intent?: string;
  createdAt: string;
  causal?: CausalMetadata;
}

export interface Thread {
  id: Id;
  title: string;
  createdAt: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRun {
  id: Id;
  threadId: Id;
  agentId: Id;
  incomingMessageId: Id;
  status: RunStatus;
  causal: CausalMetadata;
  createdAt: string;
}

export type PlatformEventPayload =
  | { type: "thread.created"; thread: Thread }
  | { type: "message.created"; message: ThreadMessage }
  | { type: "run.queued"; run: AgentRun }
  | { type: "run.started"; runId: Id; threadId: Id; agentId: Id }
  | { type: "run.delta"; runId: Id; threadId: Id; text: string }
  | {
      type: "run.tool";
      runId: Id;
      threadId: Id;
      phase: "start" | "end";
      toolName: string;
      isError?: boolean;
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
      type: "routing.accepted";
      runId: Id;
      targetAgentId: Id;
      idempotencyKey: string;
    }
  | {
      type: "routing.rejected";
      runId: Id;
      targetAgentId: Id;
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
}
