import type {
  AgentDefinition,
  CompiledContext,
  Id,
  ThreadMessage,
} from "../core/types.js";

export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | {
      type: "tool_start";
      toolName: string;
    }
  | {
      type: "tool_end";
      toolName: string;
      isError: boolean;
    };

export interface SendAgentMessageInput {
  to: Id;
  content: string;
  intent?: string;
  idempotencyKey: string;
}

export interface RuntimeRequest {
  runId: Id;
  threadId: Id;
  agent: AgentDefinition;
  incoming: ThreadMessage;
  context: CompiledContext;
  signal: AbortSignal;
  emit(event: RuntimeEvent): Promise<void>;
  sendMessage(input: SendAgentMessageInput): Promise<{ accepted: boolean; reason?: string }>;
}

export interface RuntimeResult {
  output: string;
}

export interface AgentRuntime {
  readonly id: string;
  execute(request: RuntimeRequest): Promise<RuntimeResult>;
  cancel(runId: Id): Promise<void>;
}
