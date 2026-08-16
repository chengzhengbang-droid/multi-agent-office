import type {
  AgentDefinition,
  CompiledContext,
  Id,
  RuntimeAvailability,
  ThreadMessage,
} from "../core/types.js";

export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; toolName: string }
  | { type: "tool_end"; toolName: string; isError: boolean }
  | { type: "session"; runtimeKind: "pi" | "codex"; resumed: boolean }
  | { type: "prompt_accepted" };

export interface PostAgentMessageInput {
  content: string;
  intent?: string;
  idempotencyKey: string;
}

export interface PostAgentMessageResult {
  accepted: boolean;
  messageId?: Id;
  targets: Id[];
  reason?: string;
}

export interface RuntimeRequest {
  runId: Id;
  threadId: Id;
  workingDirectory?: string;
  agent: AgentDefinition;
  roster: AgentDefinition[];
  incoming: ThreadMessage;
  context: CompiledContext;
  signal: AbortSignal;
  emit(event: RuntimeEvent): Promise<void>;
  postMessage(input: PostAgentMessageInput): Promise<PostAgentMessageResult>;
}

export interface RuntimeResult {
  output: string;
}

export interface AgentRuntime {
  readonly id: string;
  readonly availability: RuntimeAvailability;
  execute(request: RuntimeRequest): Promise<RuntimeResult>;
  cancel(runId: Id): Promise<void>;
  dispose?(): Promise<void>;
}
