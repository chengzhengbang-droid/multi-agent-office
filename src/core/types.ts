import type {
  A2ARoutingMode,
  A2ARoutingProjection,
  CollaborationIntent,
  PendingBallHold,
} from "./collaboration.js";
import type { ReviewerDegradeReason } from "./reviewer-routing.js";
import type { PriorArtEntry, PriorArtLedger } from "./prior-art.js";

export type Id = string;

export type AccessMode = "read-only" | "workspace-write" | "full";

export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface PiRuntimeSpec {
  kind: "pi";
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export interface CodexRuntimeSpec {
  kind: "codex";
  command: string;
  model?: string;
  profile?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
}

export type RuntimeSpec = PiRuntimeSpec | CodexRuntimeSpec;

export interface AgentDefinition {
  id: Id;
  displayName: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  enabled: boolean;
  accessMode: AccessMode;
  runtime: RuntimeSpec;
  /**
   * Preferred peer to review this Agent's work. Never this Agent itself. When
   * absent or unavailable the platform falls back to any other routable Agent.
   */
  reviewerAgentId?: Id;
}

export interface AgentCatalogV1 {
  version: 1;
  revision: number;
  defaultAgentId: Id;
  agents: AgentDefinition[];
}

export interface RuntimeAvailability {
  available: boolean;
  label: string;
  detail?: string;
}

export interface AgentSummary extends AgentDefinition {
  isDefault: boolean;
  availability: RuntimeAvailability;
}

export type MessageSender =
  | { type: "human"; id: string }
  | { type: "agent"; id: Id };

export interface CausalMetadata {
  chainId: Id;
  parentRunId?: Id;
  depth: number;
}

export type ThreadMessageKind =
  | "chat"
  | "collaboration"
  /** A managed ball hold woke the same Agent with fresh external context. */
  | "wake"
  /** A declared deliverable submitted to a peer for verification or critique. */
  | "review-request"
  /** A reviewer's verdict handed back to the Agent that produced the work. */
  | "review-feedback";

/** An image the human attached to a message, stored outside the event log. */
export interface MessageAttachment {
  id: Id;
  mediaType: string;
  /** Absolute path under the data directory. */
  path: string;
  byteSize: number;
}

export interface ThreadMessage {
  id: Id;
  threadId: Id;
  sender: MessageSender;
  kind: ThreadMessageKind;
  mentions: Id[];
  content: string;
  intent?: string;
  /** Structured semantics for Agent-to-Agent messages; never inferred from prose. */
  collaborationIntent?: CollaborationIntent;
  /** Structured scheduling contract for a multi-Agent dispatch. */
  routingMode?: A2ARoutingMode;
  createdAt: string;
  causal?: CausalMetadata;
  attachments?: MessageAttachment[];
  /** Legacy field accepted while replaying pre-catalog event logs. */
  recipientAgentId?: Id;
}

export interface Thread {
  id: Id;
  title: string;
  createdAt: string;
  workingDirectory?: string;
}

/** Why a run exists: original/rework work, or the review of such work. */
export type RunPurpose = "task" | "review";

/**
 * How a run is allowed to work. "plan" is the human asking for a proposal
 * instead of an edit: the run is read-only, its deliverable is a plan, and the
 * plan is critiqued by a peer and then put to the human before anything is
 * built. Absent in pre-plan-mode event logs, where every run was "normal".
 */
export type RunMode = "normal" | "plan";

/**
 * What a review round is for. "verify" checks a completion claim against the
 * artifacts it claims to have produced; "critique" pressure-tests a plan before
 * anyone executes it. Absent in pre-smart-gate event logs, where every review
 * was a completion check — replay treats a missing value as "verify".
 */
export type ReviewType = "verify" | "critique";

/** What an Agent declared it produced, which is what arms the review gate. */
export type DeliverableKind = "completion" | "plan";

/**
 * An Agent's own claim that its run produced something worth reviewing. The
 * claim is not trusted on its own: it opens the gate, and a peer checks it.
 */
export interface DeliverableDeclaration {
  kind: DeliverableKind;
  summary: string;
  /** How a reviewer can check the claim: files touched, commands to run. */
  evidence?: string[];
}

/**
 * What the reviewer routing settled on, kept in the log so a replayed review
 * round pins the same reviewer and repeats the same brief. A degraded match is
 * recorded rather than hidden: an approval from a peer that is not neutral, or
 * that shares the author's model family, is worth less and has to say so.
 */
export interface ReviewerMatchRecord {
  independent: boolean;
  crossFamily: boolean;
  degraded: boolean;
  degradeReasons: ReviewerDegradeReason[];
}

export type ReviewVerdict = "approved" | "changes-requested";

/**
 * How much weight one objection carries, modelled on clowder-ai's P1/P2/P3
 * triage (`cat-cafe-skills/receive-review`). Severity, not the verdict, is what
 * holds a task back: a reviewer with nothing but "minor" left has finished
 * reviewing and is now commenting, and commentary is not a reason to keep a
 * human waiting.
 */
export type ReviewFindingSeverity =
  /** Must not ship. Blocks on its own. */
  | "blocking"
  /** Wrong or missing enough that the author has to answer it. Blocks. */
  | "major"
  /** A nit, a preference, a follow-up idea. Recorded, never blocking. */
  | "minor";

/**
 * What kind of thing an objection is. "defect" is settled between the two
 * peers; "question" cannot be — it names something the human never decided, so
 * another discussion round would only produce a better-argued guess.
 */
export type ReviewFindingKind = "defect" | "question";

export interface ReviewFinding {
  detail: string;
  severity: ReviewFindingSeverity;
  /** Defaults to "defect" when a reviewer does not say. */
  kind?: ReviewFindingKind;
}

/**
 * Findings on the wire. Pre-severity event logs recorded bare strings, and
 * those replay as blocking-weight objections because that is what they were
 * when they were written — see `normalizeFindings`.
 */
export type ReviewFindingInput = string | ReviewFinding;

/** "cancelled" is an operator action, not a quality signal — it needs no human follow-up. */
export type ReviewOutcome = "approved" | "escalated" | "cancelled";

/** Why a task stopped short of an approval and now needs a human. */
export type ReviewEscalation =
  /** No enabled, available Agent other than the author could review. */
  | "no-reviewer"
  /** The review run ended without calling submit_review. Never an approval. */
  | "inconclusive"
  /** The review run failed, was cancelled, or its reviewer became unavailable. */
  | "review-failed"
  /**
   * The same blocking objection survived several rounds unchanged. The peers
   * are not converging, so more rounds would only restate the same wall.
   */
  | "deadlock"
  /** maxReviewRounds rounds of peer discussion ended with blocking objections still open. */
  | "max-rounds"
  /** The author stopped discussion because a material human decision is missing. */
  | "clarification-needed";

export interface ReviewSubmission {
  verdict: ReviewVerdict;
  summary: string;
  /**
   * The reviewer's objections and comments. A `changes-requested` verdict only
   * holds the task if at least one of them is blocking or major; a submission
   * carrying nothing but minor findings is consensus with comments attached.
   */
  findings?: ReviewFindingInput[];
  /**
   * What the reviewer checked for itself, and how — the files it read, the
   * commands it ran, the outputs it saw. Required to approve: an approval that
   * cannot name an independent check is the author's word repeated back.
   * Absent in pre-skeptical-review event logs, which replay unchanged.
   */
  checks?: string[];
}

/**
 * How far the peer critique got before a plan reached the human. "skipped" is
 * a plan produced with the review gate off: nobody critiqued it, and saying so
 * is what stops the approval card implying a review that never happened.
 */
export type PlanPeerOutcome = "approved" | "escalated" | "skipped";

/** The human's answer on a plan. Only a human can record one. */
export type PlanDecision = "approved" | "rejected";

/**
 * A finalized plan parked in front of the human. Peers have already critiqued
 * it; nothing is built until the human answers, and the answer is what turns
 * the plan into either an execution run or another planning round.
 */
export interface PlanApproval {
  threadId: Id;
  /** The plan task run this approval belongs to. */
  taskRunId: Id;
  /** The run that produced the plan text below — the last revision round. */
  planRunId: Id;
  authorAgentId: Id;
  /** The plan as the author last wrote it. */
  plan: string;
  /** The author's own submit_plan claim, when it made one. */
  declaration?: DeliverableDeclaration;
  peerOutcome: PlanPeerOutcome;
  /** Critique rounds spent. 0 when no peer reviewed the plan. */
  rounds: number;
  reviewerAgentId?: Id;
  /** The reviewer's closing words, approving or not. */
  peerSummary?: string;
  /** Why the critique stopped short of an approval, when it did. */
  escalation?: ReviewEscalation;
  /**
   * The precedents the author examined before proposing this, if any. Absent
   * when the author recorded nothing — which the card says out loud rather
   * than leaving the section empty and ambiguous.
   */
  priorArt?: PriorArtLedger;
  requestedAt: string;
}

export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface AgentRun {
  id: Id;
  threadId: Id;
  agentId: Id;
  incomingMessageId: Id;
  status: RunStatus;
  accessMode: AccessMode;
  causal: CausalMetadata;
  createdAt: string;
  /** Absent in pre-review event logs, where every run was a task run. */
  purpose?: RunPurpose;
  /**
   * The originating depth-0 task run this run serves. Set on review runs and on
   * rework runs; absent on the originating run itself, whose own id is the key.
   * Rework spawns a new run each round, so this is what stays stable.
   */
  taskRunId?: Id;
  /** Review runs: this round (1-based). Task runs: rework rounds done (0 = first attempt). */
  reviewRound?: number;
  /** What this review round judges. Set on review runs and on rework runs. */
  reviewType?: ReviewType;
  /** Absent in pre-plan-mode event logs, where every run was a "normal" run. */
  mode?: RunMode;
  /** Honest serial/parallel scheduling metadata carried into the runtime. */
  routing?: A2ARoutingProjection;
}

export type PlatformEventPayload =
  | { type: "thread.created"; thread: Thread }
  | { type: "message.created"; message: ThreadMessage }
  | { type: "run.queued"; run: AgentRun }
  | { type: "run.started"; runId: Id; threadId: Id; agentId: Id }
  | { type: "run.delta"; runId: Id; threadId: Id; agentId: Id; text: string }
  | {
      type: "run.tool";
      runId: Id;
      threadId: Id;
      agentId: Id;
      phase: "start" | "end";
      toolName: string;
      isError?: boolean;
      toolCallId?: string;
      args?: string;
      resultSummary?: string;
    }
  | {
      type: "run.session";
      runId: Id;
      threadId: Id;
      agentId: Id;
      runtimeKind: RuntimeSpec["kind"];
      resumed: boolean;
    }
  | {
      type: "context.delivered";
      runId: Id;
      threadId: Id;
      agentId: Id;
      messageId: Id;
      truncated: boolean;
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
      type: "run.interrupted";
      runId: Id;
      threadId: Id;
      agentId: Id;
      reason: string;
    }
  | {
      type: "run.thinking";
      runId: Id;
      threadId: Id;
      agentId: Id;
      text: string;
    }
  | {
      /** Streamed output so far is stale; clients must clear it for this run. */
      type: "run.reset";
      runId: Id;
      threadId: Id;
      agentId: Id;
      reason: "retry";
    }
  | {
      type: "run.lifecycle";
      runId: Id;
      threadId: Id;
      agentId: Id;
      phase: "retry_start" | "retry_end" | "compaction_start" | "compaction_end";
      detail?: string;
    }
  | {
      type: "run.diagnostic";
      runId: Id;
      threadId: Id;
      agentId: Id;
      source: "extension" | "runtime";
      message: string;
    }
  | {
      type: "run.usage";
      runId: Id;
      threadId: Id;
      agentId: Id;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      costUsd: number;
      contextTokens?: number;
      contextWindow?: number;
    }
  | {
      /** A human message delivered into a run that was already in flight. */
      type: "run.steered";
      runId: Id;
      threadId: Id;
      agentId: Id;
      messageId: Id;
    }
  | {
      /** The target actually acquired this turn's ball and may now act. */
      type: "ball.handed";
      threadId: Id;
      chainId: Id;
      runId: Id;
      messageId: Id;
      holderAgentId: Id;
      fromAgentId?: Id;
      routing: A2ARoutingProjection;
    }
  | {
      /** An Agent kept custody while waiting on a named external condition. */
      type: "ball.held";
      hold: PendingBallHold;
    }
  | {
      /** A persisted hold fired and re-invoked its holder. */
      type: "ball.wake_sent";
      threadId: Id;
      chainId: Id;
      holdId: Id;
      runId: Id;
      messageId: Id;
      agentId: Id;
    }
  | {
      /** The next move genuinely requires a human decision or clarification. */
      type: "ball.handed_user";
      threadId: Id;
      chainId: Id;
      runId: Id;
      reason:
        | "clarification"
        | "plan-approval"
        | "review-escalation"
        /** The collaboration chain exhausted runnable work after a task run failed. */
        | "runtime-failure";
    }
  | {
      /** A handoff was claimed in structure but named no routable recipient. */
      type: "ball.void_pass";
      threadId: Id;
      chainId: Id;
      runId: Id;
      messageId: Id;
    }
  | {
      type: "ball.hold_cancelled";
      threadId: Id;
      chainId: Id;
      holdId: Id;
      reason: string;
    }
  | {
      type: "invocation.died";
      threadId: Id;
      chainId: Id;
      runId: Id;
      agentId: Id;
      reason: string;
    }
  | {
      type: "task.done";
      threadId: Id;
      chainId: Id;
      runId: Id;
      agentId: Id;
    }
  | {
      type: "ball.cancelled";
      threadId: Id;
      chainId: Id;
      runId: Id;
      agentId: Id;
      reason: string;
    }
  | {
      /** An Agent declared its run produced a deliverable. Arms the review gate. */
      type: "deliverable.declared";
      runId: Id;
      threadId: Id;
      agentId: Id;
      kind: DeliverableKind;
      summary: string;
      evidence?: string[];
    }
  | {
      /**
       * The author reported what prior art it examined before proposing a plan,
       * or why it examined none. Recorded against the task rather than the run
       * so a precedent survives the critique rounds that revise the plan.
       */
      type: "prior-art.recorded";
      runId: Id;
      threadId: Id;
      taskRunId: Id;
      agentId: Id;
      entries: PriorArtEntry[];
      /** Present instead of entries when the author examined none and said why. */
      abstained?: string;
    }
  | {
      /** The Agent stopped before delivery because material human input is missing. */
      type: "clarification.requested";
      runId: Id;
      threadId: Id;
      agentId: Id;
      questions: Array<string | { question: string; options?: Array<{ label: string; value?: string; recommended?: boolean }> }>;
    }
  | {
      type: "review.requested";
      threadId: Id;
      taskRunId: Id;
      reviewRunId: Id;
      authorAgentId: Id;
      reviewerAgentId: Id;
      round: number;
      messageId: Id;
      /** Absent in pre-smart-gate logs; replay treats that as "verify". */
      reviewType?: ReviewType;
      /**
       * How good a match the reviewer was. Absent in pre-routing-policy logs,
       * where only chain independence was recorded and only in the brief.
       */
      reviewerMatch?: ReviewerMatchRecord;
    }
  | {
      type: "review.submitted";
      threadId: Id;
      taskRunId: Id;
      reviewRunId: Id;
      reviewerAgentId: Id;
      verdict: ReviewVerdict;
      summary: string;
      findings?: ReviewFindingInput[];
      /** What the reviewer verified itself. Absent in pre-skeptical-review logs. */
      checks?: string[];
    }
  | {
      /** A review objection opened another natural-language deliberation round. */
      type: "review.rework";
      threadId: Id;
      taskRunId: Id;
      reworkRunId: Id;
      authorAgentId: Id;
      round: number;
      messageId: Id;
    }
  | {
      /** The single terminal marker for a reviewed task run. */
      type: "review.resolved";
      threadId: Id;
      taskRunId: Id;
      outcome: ReviewOutcome;
      rounds: number;
      escalation?: ReviewEscalation;
      detail?: string;
      reviewType?: ReviewType;
    }
  | {
      /**
       * A plan cleared its peer critique and now waits on the human. No run is
       * queued while this stands: plan mode's whole point is that nothing is
       * built until a person says so.
       */
      type: "plan.awaiting-approval";
      threadId: Id;
      taskRunId: Id;
      planRunId: Id;
      authorAgentId: Id;
      plan: string;
      kind?: DeliverableKind;
      summary?: string;
      evidence?: string[];
      peerOutcome: PlanPeerOutcome;
      rounds: number;
      reviewerAgentId?: Id;
      peerSummary?: string;
      escalation?: ReviewEscalation;
      /** What the author examined before proposing this. Absent when nothing was recorded. */
      priorArt?: PriorArtLedger;
    }
  | {
      /** The human's answer on a plan. Approval executes it; rejection replans. */
      type: "plan.decided";
      threadId: Id;
      taskRunId: Id;
      decision: PlanDecision;
      decidedBy: string;
      /** What the human said, verbatim. Required to reject. */
      note?: string;
      /** The message that carries the plan into execution or into revision. */
      followUpMessageId?: Id;
    }
  | {
      type: "routing.accepted";
      runId: Id;
      threadId: Id;
      messageId: Id;
      targetAgentId: Id;
      idempotencyKey: string;
    }
  | {
      type: "routing.rejected";
      runId: Id;
      threadId: Id;
      targetAgentId?: Id;
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
  deliveryCursor: Id;
  truncated: boolean;
}
