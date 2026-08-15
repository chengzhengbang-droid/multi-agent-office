import type {
  AgentRuntime,
  RuntimeRequest,
  RuntimeResult,
} from "./runtime.js";

export interface DeterministicRuntimeOptions {
  stepDelayMs?: number;
}

export class DeterministicRuntime implements AgentRuntime {
  public readonly id = "deterministic";
  private readonly controllers = new Map<string, AbortController>();
  private readonly stepDelayMs: number;

  public constructor(options: DeterministicRuntimeOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 10;
  }

  public async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    const controller = new AbortController();
    const abortFromParent = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abortFromParent, { once: true });
    this.controllers.set(request.runId, controller);

    try {
      await abortableDelay(this.stepDelayMs, controller.signal);

      if (request.agent.id === "architect") {
        return request.incoming.sender.type === "human"
          ? this.runArchitectInitial(request, controller.signal)
          : this.runArchitectFollowUp(request, controller.signal);
      }

      if (request.agent.id === "reviewer") {
        return this.runReviewer(request, controller.signal);
      }

      const output = `${request.agent.displayName} received: ${request.incoming.content}`;
      await request.emit({ type: "text_delta", text: output });
      return { output };
    } finally {
      request.signal.removeEventListener("abort", abortFromParent);
      this.controllers.delete(request.runId);
    }
  }

  public async cancel(runId: string): Promise<void> {
    this.controllers.get(runId)?.abort("Cancelled by platform");
  }

  private async runArchitectInitial(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const proposal = [
      "MVP proposal:",
      "1. Platform-owned thread and event log.",
      "2. Runtime adapters behind one contract.",
      "3. Structured A2A messages with cancellation and deduplication.",
    ].join("\n");

    await request.emit({ type: "text_delta", text: proposal });
    await abortableDelay(this.stepDelayMs, signal);
    await request.emit({ type: "tool_start", toolName: "send_message" });
    const routed = await request.sendMessage({
      to: "reviewer",
      intent: "review",
      content: `Please review this proposal:\n\n${proposal}`,
      idempotencyKey: `${request.runId}:review-request`,
    });
    await request.emit({
      type: "tool_end",
      toolName: "send_message",
      isError: !routed.accepted,
    });

    const output = routed.accepted
      ? `${proposal}\n\nThe proposal has been routed to @reviewer.`
      : `${proposal}\n\nReview routing was rejected: ${routed.reason ?? "unknown reason"}`;
    return { output };
  }

  private async runReviewer(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    const review = [
      "Review: approved for MVP.",
      "Required guardrail: agent output text must never be parsed as a second A2A trigger.",
      "Required proof: replay, deduplication, depth-limit, and cancellation tests.",
    ].join("\n");
    await request.emit({ type: "text_delta", text: review });
    await abortableDelay(this.stepDelayMs, signal);

    if (request.incoming.sender.type === "agent") {
      await request.emit({ type: "tool_start", toolName: "send_message" });
      const routed = await request.sendMessage({
        to: request.incoming.sender.id,
        intent: "review-result",
        content: review,
        idempotencyKey: `${request.runId}:review-response`,
      });
      await request.emit({
        type: "tool_end",
        toolName: "send_message",
        isError: !routed.accepted,
      });
    }

    return { output: review };
  }

  private async runArchitectFollowUp(
    request: RuntimeRequest,
    signal: AbortSignal,
  ): Promise<RuntimeResult> {
    await abortableDelay(this.stepDelayMs, signal);
    const output = `Review received from @${request.incoming.sender.id}. The MVP can proceed with the requested guardrails.`;
    await request.emit({ type: "text_delta", text: output });
    return { output };
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
