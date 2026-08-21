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

export type ReviewVerdict = "approved" | "changes-requested";

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
  /** maxReviewRounds rounds of rework still did not satisfy the reviewer. */
  | "max-rounds";

export interface ReviewSubmission {
  verdict: ReviewVerdict;
  summary: string;
  findings?: string[];
  /**
   * What the reviewer checked for itself, and how — the files it read, the
   * commands it ran, the outputs it saw. Required to approve: an approval that
   * cannot name an independent check is the author's word repeated back.
   * Absent in pre-skeptical-review event logs, which replay unchanged.
   */
  checks?: string[];
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
    }
  | {
      type: "review.submitted";
      threadId: Id;
      taskRunId: Id;
      reviewRunId: Id;
      reviewerAgentId: Id;
      verdict: ReviewVerdict;
      summary: string;
      findings?: string[];
      /** What the reviewer verified itself. Absent in pre-skeptical-review logs. */
      checks?: string[];
    }
  | {
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
