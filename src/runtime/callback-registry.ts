import { randomBytes } from "node:crypto";
import type {
  PostAgentMessageInput,
  PostAgentMessageResult,
  SubmitReviewInput,
  SubmitReviewResult,
} from "./runtime.js";

interface CallbackBinding {
  runId: string;
  threadId: string;
  agentId: string;
  postMessage(input: PostAgentMessageInput): Promise<PostAgentMessageResult>;
  /** Present only when the bound run is reviewing another Agent's work. */
  submitReview?(input: SubmitReviewInput): Promise<SubmitReviewResult>;
}

export interface CallbackRequest extends PostAgentMessageInput {
  runId: string;
  threadId: string;
  agentId: string;
}

export interface ReviewCallbackRequest extends SubmitReviewInput {
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
    const binding = this.resolve(token, request);
    return binding.postMessage({
      content: request.content,
      idempotencyKey: request.idempotencyKey,
      ...(request.intent ? { intent: request.intent } : {}),
    });
  }

  public async invokeReview(
    token: string,
    request: ReviewCallbackRequest,
  ): Promise<SubmitReviewResult> {
    const binding = this.resolve(token, request);
    if (!binding.submitReview) {
      return {
        accepted: false,
        reason: "submit_review is only available while reviewing another Agent's work",
      };
    }
    return binding.submitReview({
      verdict: request.verdict,
      summary: request.summary,
      ...(request.findings ? { findings: request.findings } : {}),
    });
  }

  private resolve(
    token: string,
    request: { runId: string; threadId: string; agentId: string },
  ): CallbackBinding {
    const binding = this.bindings.get(token);
    if (!binding) throw new Error("Callback token is invalid or expired");
    if (
      request.runId !== binding.runId ||
      request.threadId !== binding.threadId ||
      request.agentId !== binding.agentId
    ) {
      throw new Error("Callback identity does not match the active Agent run");
    }
    return binding;
  }
}
