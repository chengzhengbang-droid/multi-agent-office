import type { AgentDefinition, Id, RuntimeSpec } from "./types.js";

/**
 * Reviewer routing, modelled on clowder-ai's reviewer matcher
 * (`packages/api/src/domains/cats/services/collaboration/reviewer-matcher.ts`).
 *
 * Its rules, in clowder's own order: never the author, must hold the
 * peer-reviewer role, must be available, prefer a different model family,
 * prefer the configured lead, prefer whoever is active in this thread, and
 * degrade rather than skip — recording why the match was degraded.
 *
 * Preference order here, strongest first: chain independence, the roster's
 * configured reviewer, a different model family, recent activity in the thread,
 * then roster order. Two of those sit differently than in clowder, and both
 * times because the signal means something different in this workbench:
 *
 * - Chain independence outranks model family. clowder's roster has no notion of
 *   "already worked on this task"; ours does, and a peer that produced part of
 *   the work under review is judging itself. That disqualification is a
 *   stronger form of clowder's own "cannot review own code" rule, so it is
 *   ranked above the cross-family preference rather than below it.
 * - The roster's `reviewerAgentId` outranks model family, where clowder ranks
 *   family above its `preferLead`. clowder's lead flag is a roster-wide
 *   heuristic; ours is an explicit assignment a human made for this specific
 *   author, and clowder puts the same call in operator hands through
 *   `ReviewPolicy.requireDifferentFamily`. Honouring the assignment is
 *   honouring that decision, not overriding it — and the degraded match is
 *   still recorded, so a same-family review still says what it cost.
 */

/**
 * The capability an Agent declares to be eligible to review. Honoured only when
 * at least one routable peer declares it: a roster that never named the role
 * keeps every peer eligible, exactly as before the role existed.
 */
export const PEER_REVIEWER_ROLE = "peer-reviewer";

/** Why a match is worse than the policy asks for. Recorded, never hidden. */
export type ReviewerDegradeReason =
  /** Every eligible peer already produced work in this collaboration chain. */
  | "chain-contributor"
  /** Every eligible peer runs the same model family as the author. */
  | "same-family";

export interface ReviewerCandidate {
  agent: AgentDefinition;
  /** Enabled and its runtime is available — clowder's availability filter. */
  routable: boolean;
  /** Produced non-review work in this collaboration chain. */
  contributor: boolean;
  /** Epoch milliseconds of this peer's last message in the thread, if any. */
  lastActiveAt?: number;
}

export interface ReviewerRoutingInput {
  authorAgentId: Id;
  /** The roster, in roster order, so every fallback stays deterministic. */
  candidates: ReviewerCandidate[];
  /** The author's roster-configured default reviewer. */
  preferredReviewerId?: Id;
}

/** What the routing decided, and what it had to give up to decide it. */
export interface ReviewerMatch {
  /** Undefined when no peer passed the hard rules at all. */
  reviewerAgentId?: Id;
  /** The reviewer produced no work of its own in this chain. */
  independent: boolean;
  /** The reviewer runs a different model family than the author. */
  crossFamily: boolean;
  degraded: boolean;
  degradeReasons: ReviewerDegradeReason[];
  /** Every peer that passed the hard rules, in preference order. */
  candidates: Id[];
}

/**
 * The model family behind an Agent. Cross-family review is what "one model
 * writes, a different one reviews" means: two Agents on the same provider share
 * their training, their blind spots and their failure modes, so a peer from
 * another family is a genuinely independent reader and one from the same family
 * is a second opinion from the same mind.
 */
export function modelFamilyOf(runtime: RuntimeSpec): string {
  if (runtime.kind === "codex") return "codex";
  return runtime.provider.trim().toLowerCase() || "unknown";
}

export function resolveReviewerMatch(input: ReviewerRoutingInput): ReviewerMatch {
  const author = input.candidates.find((candidate) => candidate.agent.id === input.authorAgentId);
  const authorFamily = author ? modelFamilyOf(author.agent.runtime) : undefined;

  // Hard rules, in clowder's order: not the author, holds the role, available.
  const notAuthor = input.candidates.filter(
    (candidate) => candidate.agent.id !== input.authorAgentId && candidate.routable,
  );
  const roleHolders = notAuthor.filter((candidate) =>
    candidate.agent.capabilities.some((capability) => capability.trim().toLowerCase() === PEER_REVIEWER_ROLE),
  );
  const eligible = roleHolders.length > 0 ? roleHolders : notAuthor;

  const rank = (candidate: ReviewerCandidate, index: number) => ({
    candidate,
    index,
    independent: !candidate.contributor,
    crossFamily: authorFamily !== undefined && modelFamilyOf(candidate.agent.runtime) !== authorFamily,
    preferred: candidate.agent.id === input.preferredReviewerId,
    lastActiveAt: candidate.lastActiveAt ?? 0,
  });
  const ranked = eligible.map(rank).sort((left, right) => {
    if (left.independent !== right.independent) return left.independent ? -1 : 1;
    if (left.preferred !== right.preferred) return left.preferred ? -1 : 1;
    if (left.crossFamily !== right.crossFamily) return left.crossFamily ? -1 : 1;
    if (left.lastActiveAt !== right.lastActiveAt) return right.lastActiveAt - left.lastActiveAt;
    return left.index - right.index;
  });

  const chosen = ranked[0];
  const candidates = ranked.map((entry) => entry.candidate.agent.id);
  if (!chosen) {
    return {
      independent: false,
      crossFamily: false,
      degraded: true,
      degradeReasons: [],
      candidates,
    };
  }
  const degradeReasons: ReviewerDegradeReason[] = [];
  if (!chosen.independent) degradeReasons.push("chain-contributor");
  if (!chosen.crossFamily) degradeReasons.push("same-family");
  return {
    reviewerAgentId: chosen.candidate.agent.id,
    independent: chosen.independent,
    crossFamily: chosen.crossFamily,
    degraded: degradeReasons.length > 0,
    degradeReasons,
    candidates,
  };
}

/** What a degraded match means for the reviewer, in the reviewer's own brief. */
export const REVIEWER_DEGRADE_BRIEF: Record<ReviewerDegradeReason, string[]> = {
  "chain-contributor": [
    "You already worked in this chain, so you are not a neutral party here — no uninvolved peer was available.",
    "Hold your own contribution to the same standard you would apply to anyone else's.",
  ],
  "same-family": [
    "You and the author run the same model family, so you share its blind spots — no peer from another family was available.",
    "Assume the mistakes you would make yourself are the ones you are least likely to notice here, and check those first.",
  ],
};
