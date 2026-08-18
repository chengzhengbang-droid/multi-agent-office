import type { RuntimeAvailability } from "../core/types.js";
import type {
  AgentRuntime,
  RuntimeRequest,
  RuntimeResult,
} from "./runtime.js";

export interface DeterministicRuntimeOptions {
  id: string;
  stepDelayMs?: number;
  handoffTo?: string;
}

export class DeterministicRuntime implements AgentRuntime {
  public readonly id: string;
  public readonly availability: RuntimeAvailability = {
    available: true,
    label: "Deterministic test runtime",
  };
  private readonly controllers = new Map<string, AbortController>();
  private readonly stepDelayMs: number;
  private readonly handoffTo: string | undefined;

  public constructor(options: DeterministicRuntimeOptions) {
    this.id = options.id;
    this.stepDelayMs = options.stepDelayMs ?? 10;
    this.handoffTo = options.handoffTo;
  }

  public async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abortFromParent, { once: true });
    this.controllers.set(request.runId, controller);
    try {
      await request.emit({ type: "session", runtimeKind: "pi", resumed: false });
      await request.emit({ type: "prompt_accepted" });
      await abortableDelay(this.stepDelayMs, controller.signal);
      const output = `${request.agent.displayName} received: ${request.incoming.content}`;
      await request.emit({ type: "text_delta", text: output });
      if (request.submitReview && request.reviewOf) {
        await request.emit({ type: "tool_start", toolName: "submit_review" });
        const review = await request.submitReview({
          verdict: "approved",
          summary: `Deterministic review of @${request.reviewOf.authorAgentId}'s work.`,
        });
        await request.emit({
          type: "tool_end",
          toolName: "submit_review",
          isError: !review.accepted,
        });
        return { output };
      }
      if (this.handoffTo && request.incoming.sender.type === "human") {
        await request.emit({ type: "tool_start", toolName: "post_message" });
        const result = await request.postMessage({
          content: `@${this.handoffTo} Please continue independently from this visible handoff.`,
          intent: "handoff",
          idempotencyKey: "deterministic-handoff",
        });
        await request.emit({
          type: "tool_end",
          toolName: "post_message",
          isError: !result.accepted,
        });
      }
      return { output };
    } finally {
      request.signal.removeEventListener("abort", abortFromParent);
      this.controllers.delete(request.runId);
    }
  }

  public async cancel(runId: string): Promise<void> {
    this.controllers.get(runId)?.abort("Cancelled by platform");
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(reason: unknown): Error {
  const error = new Error(String(reason ?? "Aborted"));
  error.name = "AbortError";
  return error;
}
