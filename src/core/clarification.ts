/** Shared by both runtimes and the platform's live submission gate. */
export const CLARIFICATION_QUESTION_BRIEF =
  "Each questions entry must ask for exactly one independently answerable fact or decision. Never combine multiple questions in one entry. Give each choice question its own options; use a separate free-text question for facts without known choices. Write one interrogative sentence per entry; put alternatives in options, not separate interrogative sentences. If a request is rejected, correct it and call the tool again before stopping.";

export function hasMultipleQuestionSentences(question: string): boolean {
  // This is a syntax guard, not a semantic splitter: assigning existing options
  // to guessed fragments could silently answer the wrong question. Consecutive
  // question marks are emphasis; a question followed by explanation is valid.
  return (question.match(/[?？]+/gu)?.length ?? 0) > 1;
}

export const SPLIT_QUESTION_REASON =
  "Each entry must contain one question only. Split independent facts or decisions into separate entries with their own options (or no options for free text). Rephrase alternatives as one question with options. Retry the tool with the corrected questions; do not stop yet.";
