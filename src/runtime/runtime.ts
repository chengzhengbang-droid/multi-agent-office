import type {
  AgentDefinition,
  CompiledContext,
  DeliverableDeclaration,
  Id,
  MessageAttachment,
  ReviewSubmission,
  ReviewType,
  RuntimeAvailability,
  ThreadMessage,
} from "../core/types.js";
import type {
  A2ARoutingMode,
  A2ARoutingProjection,
  CollaborationIntent,
  WaitSourceRef,
} from "../core/collaboration.js";

export type RuntimeLifecyclePhase =
  | "retry_start"
  | "retry_end"
  | "compaction_start"
  | "compaction_end";

export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** Discard whatever has been streamed for this run so far (auto-retry re-streams). */
  | { type: "output_reset"; reason: "retry" }
  | { type: "tool_start"; toolName: string; toolCallId?: string; args?: string }
  | {
      type: "tool_end";
      toolName: string;
      isError: boolean;
      toolCallId?: string;
      resultSummary?: string;
    }
  | { type: "session"; runtimeKind: "pi" | "codex"; resumed: boolean }
  | { type: "prompt_accepted" }
  | { type: "lifecycle"; phase: RuntimeLifecyclePhase; detail?: string }
  | { type: "diagnostic"; source: "extension" | "runtime"; message: string }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      costUsd: number;
      contextTokens?: number;
      contextWindow?: number;
    };

export interface PostAgentMessageInput {
  content: string;
  intent?: string;
  /** Defaults to handoff when one or more peers are named. */
  collaborationIntent?: CollaborationIntent;
  /** Inline/tool multi-target dispatches are serial unless explicitly parallel. */
  routingMode?: A2ARoutingMode;
  idempotencyKey: string;
}

export interface PostAgentMessageResult {
  accepted: boolean;
  messageId?: Id;
  targets: Id[];
  reason?: string;
}

export interface HoldBallInput {
  /** Delay before the holder is re-invoked to check the external condition. */
  wakeAfterMs: number;
  /** Grounding is mandatory: the platform will not persist a vague "wait". */
  waitSourceRef: WaitSourceRef;
}

export interface HoldBallResult {
  accepted: boolean;
  holdId?: Id;
  wakeAt?: string;
  reason?: string;
}

export type SubmitReviewInput = ReviewSubmission;

export interface SubmitReviewResult {
  accepted: boolean;
  reason?: string;
}

export type DeclareDeliverableInput = DeliverableDeclaration;

export interface DeclareDeliverableResult {
  accepted: boolean;
  reason?: string;
}

export interface RequestClarificationInput {
  /** The smallest set of human answers needed before work or planning can continue. */
  questions: Array<string | ClarificationQuestion>;
}

export interface ClarificationQuestion {
  question: string;
  options?: Array<{ label: string; value?: string; recommended?: boolean }>;
}

export interface RequestClarificationResult {
  accepted: boolean;
  reason?: string;
}

/** What a review run is reviewing. Present only on review runs. */
export interface ReviewAssignment {
  taskRunId: Id;
  authorAgentId: Id;
  /** This review round, 1-based. */
  round: number;
  maxRounds: number;
  /** Verifying a completion claim, or critiquing a plan. */
  reviewType: ReviewType;
  /**
   * False when the reviewer already produced work in this collaboration chain,
   * so its judgment is not neutral. The platform still runs the review — a
   * compromised reviewer beats none — but says so in the brief.
   */
  independent: boolean;
  /** The author's own claim, for a reviewer to check rather than trust. */
  declaration?: DeliverableDeclaration;
}

/** An image attachment already read off disk, ready to hand to a model. */
export interface RuntimeImage {
  mediaType: string;
  /** Base64-encoded image bytes. */
  data: string;
}

export interface RuntimeRequest {
  runId: Id;
  threadId: Id;
  workingDirectory?: string;
  agent: AgentDefinition;
  roster: AgentDefinition[];
  incoming: ThreadMessage;
  context: CompiledContext;
  /** Attachments on the incoming message, resolved to bytes. */
  images?: RuntimeImage[];
  attachments?: MessageAttachment[];
  signal: AbortSignal;
  /**
   * The human asked for a plan, not the work. The Agent's access is already
   * narrowed to read-only on the definition above; this tells the runtime to
   * say so in the brief, because a model that knows why its tools are missing
   * writes a plan instead of fighting the sandbox.
   */
  planMode?: boolean;
  /**
   * Set only on review runs. Runtimes keep a stable submit_review tool surface
   * for resumable sessions, but the platform supplies authority to accept a
   * verdict only when this assignment and submitReview are present.
   */
  reviewOf?: ReviewAssignment;
  /** Structured scheduling mode for this run; prose never changes it. */
  routing?: A2ARoutingProjection;
  emit(event: RuntimeEvent): Promise<void>;
  postMessage(input: PostAgentMessageInput): Promise<PostAgentMessageResult>;
  /** Keep the ball while waiting on a named external condition, then wake up. */
  holdBall(input: HoldBallInput): Promise<HoldBallResult>;
  /**
   * Pause before producing a deliverable when missing human input would
   * materially change the goal, plan, acceptance criteria, or implementation.
   */
  requestClarification(input: RequestClarificationInput): Promise<RequestClarificationResult>;
  /** Present only alongside reviewOf. */
  submitReview?(input: SubmitReviewInput): Promise<SubmitReviewResult>;
  /**
   * The Agent's own judgment that this run produced something reviewable. What
   * opens the review gate in "smart" mode — casual conversation declares
   * nothing and is reviewed by nobody.
   */
  declareDeliverable(input: DeclareDeliverableInput): Promise<DeclareDeliverableResult>;
}

export interface RuntimeResult {
  output: string;
}

export interface RuntimeSessionStats {
  sessionId: string;
  sessionFile?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalTokens: number;
  costUsd: number;
  contextTokens?: number;
  contextWindow?: number;
}

export type RuntimeSessionExportFormat = "html" | "jsonl";

export interface AgentRuntime {
  readonly id: string;
  readonly availability: RuntimeAvailability;
  execute(request: RuntimeRequest): Promise<RuntimeResult>;
  cancel(runId: Id): Promise<void>;
  /**
   * Deliver a message into a run that is already in flight. Returns false when
   * the runtime cannot steer, so the caller can fall back to queueing a run.
   */
  steer?(runId: Id, text: string): Promise<boolean>;
  /** Statistics for this Agent's private session in a thread, if it has one. */
  sessionStats?(threadId: Id): Promise<RuntimeSessionStats | undefined>;
  /** Summarize the session's older history to reclaim context window. */
  compactSession?(threadId: Id): Promise<{ compacted: boolean; detail: string }>;
  /** Write the session transcript to a file and return its path. */
  exportSession?(threadId: Id, format: RuntimeSessionExportFormat): Promise<string>;
  dispose?(): Promise<void>;
}
