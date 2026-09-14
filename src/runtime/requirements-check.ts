import type { RuntimeRequest, RuntimeResult, RequestClarificationInput, RuntimeEvent } from "./runtime.js";

export const REQUIREMENTS_CHECK_BRIEF = `This turn is REQUIREMENTS CHECK ONLY, not execution or delivery.
Inspect the original task, conversation and previous answers for missing information that would change the result. This includes everyday advice, travel, clothing, writing and planning, not only code or architecture.
If such information is missing and cannot be resolved from evidence or explicit delegated authority, call request_clarification now and stop. Do not draft an answer for several assumed scenarios, add disclaimers, or postpone questions until after the answer.
Use 2–3 concrete options for choices; mark exactly one justified recommendation with recommended: true. Never recommend an invented personal fact such as the user's departure date. Facts may use options without a recommendation or a free-text input. Each question collects one fact or decision.
For example: October Xinjiang clothing advice without departure dates needs a date question before the packing list; knowing early versus late October changes the answer.
If the task is already clear, or remaining details do not affect the result, call confirm_requirements with the evidence or existing authorization that makes it ready, then stop. Do not ask already answered questions. Greetings and fully specified factual questions can proceed without asking.
You must call one of these tools successfully. A prose answer is not a completed check. The platform will start a separate execution turn only after confirmation.`;

/** Every real invocation checks again; no approval survives cancellation/restart
 * as an in-memory exemption. Accepted questions use the existing durable gate. */
export async function checkRequirements(
  request: RuntimeRequest,
  execute: (request: RuntimeRequest) => Promise<RuntimeResult>,
): Promise<RuntimeResult> {
  let ready = false;
  let checkUsage: Extract<RuntimeEvent, { type: "usage" }> | undefined;
  let clarification: RequestClarificationInput | undefined;
  const blocked = async () => ({ accepted: false, reason: "Requirements check only: ask the human or confirm_requirements, then stop." });
  // One corrective turn handles model protocol omissions, not network/runtime
  // errors. The budget never grants permission: only an accepted tool does.
  for (let attempt = 0; attempt < 2 && !ready && !clarification; attempt++) {
    if (request.signal.aborted) throw new Error("Requirements check cancelled");
    const previousUsage = checkUsage;
    await execute({
      ...request,
      requirementsChecked: true,
      ...(attempt > 0 ? {
        requirementsCheckFeedback: "The previous check ended without a successful tool decision. Correct that now: call confirm_requirements with evidence from the task and existing answers, or request_clarification for genuinely missing information. A prose answer or a rejected call does not count. Do not execute or repeat an already answered question.",
      } : {}),
      agent: { ...request.agent, accessMode: "read-only" },
      confirmRequirements: async (reason) => {
        if (request.signal.aborted) return { accepted: false, reason: "Requirements check cancelled" };
        if (clarification || ready) return { accepted: false, reason: "The check already has a decision. Stop." };
        if (!reason.trim()) return { accepted: false, reason: "Explain why no result-changing user information is missing." };
        await request.emit({ type: "diagnostic", source: "runtime", message: `Requirements checked: ${reason.trim()}` });
        ready = true;
        return { accepted: true };
      },
      requestClarification: async (input) => {
        if (request.signal.aborted) return { accepted: false, reason: "Requirements check cancelled" };
        if (ready || clarification) return { accepted: false, reason: "The check already has a decision. Stop." };
        const result = await request.requestClarification(input);
        if (result.accepted) clarification = input;
        return result;
      },
      postMessage: async () => ({ ...await blocked(), targets: [] }),
      holdBall: blocked,
      declareDeliverable: blocked,
      recordPriorArt: blocked,
      // Suppress speculative prose from this phase, including retry resets.
      // Tool events and usage remain visible and are persisted by the platform.
      emit: async (event) => {
        if (event.type === "usage") {
          event = combineUsage(event, previousUsage, request.agent.runtime.kind === "codex");
          checkUsage = event;
        }
        if (!["text_delta", "thinking_delta", "output_reset"].includes(event.type)) await request.emit(event);
      },
    });
    if (request.signal.aborted) throw new Error("Requirements check cancelled");
    if (!ready && !clarification && attempt === 0) {
      await request.emit({
        type: "diagnostic", source: "runtime",
        message: "需求检查未收到成功的工具决策，正在自动纠正重试（1/1）；尚未进入执行。",
      });
    }
  }
  if (request.signal.aborted) throw new Error("Requirements check cancelled");
  if (clarification) return {
    output: "需要先确认以下信息，请在提问卡中作答后继续：\n\n" + clarification.questions.map((q) => typeof q === "string" ? q : q.question).join("\n\n"),
  };
  if (!ready) throw new Error("需求检查未完成：自动纠正重试后仍未成功调用提问或确认工具，已停止执行，请重试。");
  return execute({
    ...request,
    requirementsChecked: true,
    emit: async (event) => {
      // Pi already reports cumulative session usage; Codex reports this turn.
      await request.emit(event.type === "usage"
        ? combineUsage(event, checkUsage, request.agent.runtime.kind === "codex")
        : event);
    },
  });
}

/** Codex reports cumulative values within a turn; Pi reports the whole session.
 * Add only completed earlier turns, never successive updates of the same turn. */
function combineUsage(
  current: Extract<RuntimeEvent, { type: "usage" }>,
  previous: Extract<RuntimeEvent, { type: "usage" }> | undefined,
  perTurn: boolean,
): Extract<RuntimeEvent, { type: "usage" }> {
  if (!perTurn || !previous) return current;
  const combined = { ...current };
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens", "costUsd"] as const) {
    combined[key] += previous[key];
  }
  return combined;
}
