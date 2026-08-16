import { randomBytes } from "node:crypto";
import type {
  PostAgentMessageInput,
  PostAgentMessageResult,
} from "./runtime.js";

interface CallbackBinding {
  runId: string;
  threadId: string;
  agentId: string;
  postMessage(input: PostAgentMessageInput): Promise<PostAgentMessageResult>;
}

export interface CallbackRequest extends PostAgentMessageInput {
  runId: string;
  threadId: string;
  agentId: string;
}

export class RunCallbackRegistry {
  private readonly bindings = new Map<string, CallbackBinding>();

  public issue(binding: CallbackBinding): string {
    const token = randomBytes(32).toString("base64url");
    this.bindings.set(token, binding);
    return token;
  }

  public revoke(token: string): void {
    this.bindings.delete(token);
  }

  public async invoke(
    token: string,
    request: CallbackRequest,
  ): Promise<PostAgentMessageResult> {
    const binding = this.bindings.get(token);
    if (!binding) throw new Error("Callback token is invalid or expired");
    if (
      request.runId !== binding.runId ||
      request.threadId !== binding.threadId ||
      request.agentId !== binding.agentId
    ) {
      throw new Error("Callback identity does not match the active Agent run");
    }
    return binding.postMessage({
      content: request.content,
      idempotencyKey: request.idempotencyKey,
      ...(request.intent ? { intent: request.intent } : {}),
    });
  }
}
