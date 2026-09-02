import type { Id } from "./types.js";

/**
 * Prior-art recording for plan mode, modelled on clowder-ai's research lane
 * (`cat-cafe-skills/deep-research`, `open-source-teardown`, `source-audit`) and
 * on the two sieves its capability index applies before blaming an Agent for
 * not using a capability (`cat-cafe-skills/refs/capability-wakeup-index.md`).
 *
 * What is borrowed, and what is deliberately not:
 *
 * - clowder's teardown rule is "不许只看 README 下判断": a claim about how
 *   someone else solved this has to be traced to the thing itself, not to its
 *   marketing. That rule is mechanical, so it lives here as validation rather
 *   than as advice a brief hopes an Agent follows.
 * - clowder's teardown also demands the tradeoff — "我们因为 tradeoff 不
 *   follow 的理由" — so declining to copy something is an answer, not a gap,
 *   as long as the reason is on the record.
 * - clowder decides *whether* a topic deserves research semantically, through
 *   an operator asking for it. This platform cannot read that intent, and
 *   guessing it would produce exactly the false expectation clowder's sieve 0
 *   warns about, so no expectation is inferred from the plan's content. Every
 *   plan-mode run is simply told the lane exists and what a usable entry looks
 *   like, and what it did about that is recorded either way.
 * - clowder's sieve 0 asks whether a capability is even reachable from the
 *   current context, because "一个你以为够不着的能力，miss 不是因为懒，是从
 *   没进考虑" — a miss caused by unreachability needs a different fix than a
 *   miss caused by haste, and a forcing function aimed at the wrong one makes
 *   things worse. This platform cannot see whether an Agent's harness can
 *   reach the network, so it does not pretend to: the Agent reports that
 *   itself by abstaining with a reason, which is why abstention is a
 *   first-class outcome here rather than a silent absence.
 */

/** How deep the author actually looked at the source it is citing. */
export type PriorArtSourceKind =
  /** The implementation itself: source files, a spec's normative text, the artifact. */
  | "source"
  /** Official documentation, reference manual, or a paper's own body. */
  | "docs"
  /** README, landing page, release post, slide deck — the project describing itself. */
  | "marketing"
  /** Someone else's summary: a thread, an article about it, unverified recall. */
  | "secondhand";

/** What the author decided to do about the prior art it found. */
export type PriorArtVerdict =
  /** Build it the way this source does. */
  | "adopt"
  /** Take the shape, change something that matters here. */
  | "adapt"
  /** Deliberately not follow it. */
  | "reject";

/**
 * One examined precedent. The shape is a claims ledger rather than prose so a
 * critique reviewer can check entries one at a time instead of re-researching
 * a paragraph of confident summary.
 */
export interface PriorArtEntry {
  /** Concrete identity of what was examined: a URL, repository, paper, or local path. */
  source: string;
  sourceKind: PriorArtSourceKind;
  /** What this source is claimed to do, in a form that can be proved wrong. */
  claim: string;
  verdict: PriorArtVerdict;
  /**
   * What the author read or ran to confirm the claim — the file it opened, the
   * path it traced, the command it ran. Required to adopt, for the same reason
   * a reviewer cannot approve without naming a check: a claim nobody verified
   * is the source's own marketing repeated back.
   */
  checked?: string;
  /**
   * Why this is not copied as-is. Required to adapt or reject, because a
   * verdict without a reason teaches the next round nothing and invites the
   * same precedent to be re-proposed.
   */
  tradeoff?: string;
}

/**
 * What a planning task did about prior art. Three states, not two: silence and
 * a reasoned "there was nothing reachable to look at" are different facts, and
 * collapsing them hides the one that is actually fixable.
 */
export type PriorArtOutcome =
  /** The author examined precedents and recorded them. */
  | "recorded"
  /** The author explicitly declined, with a reason on the record. */
  | "abstained"
  /** Plan mode ran and the author said nothing either way. */
  | "none";

export interface PriorArtLedger {
  taskRunId: Id;
  authorAgentId: Id;
  outcome: Exclude<PriorArtOutcome, "none">;
  entries: PriorArtEntry[];
  /** Present when the outcome is abstained. */
  abstainedReason?: string;
  recordedAt: string;
}

export const MAX_PRIOR_ART_ENTRIES = 20;
const MAX_FIELD_LENGTH = 2_000;

export interface PriorArtInput {
  entries?: PriorArtEntry[];
  /**
   * Why no precedent was examined: nothing comparable exists, this run cannot
   * reach the sources, or the change is too local for prior art to inform it.
   */
  abstained?: string;
}

export type PriorArtValidation =
  | { ok: true; entries: PriorArtEntry[]; abstained?: string }
  | { ok: false; reason: string };

const SOURCE_KINDS = new Set<string>(["source", "docs", "marketing", "secondhand"]);
const VERDICTS = new Set<string>(["adopt", "adapt", "reject"]);

/** Deep enough to justify building something the same way. */
const FIRSTHAND_KINDS = new Set<PriorArtSourceKind>(["source", "docs"]);

/**
 * The rules that make a ledger evidence rather than a gesture. They mirror the
 * burden of proof this platform already places on a reviewer's approval: the
 * claim that costs something to be wrong about is the one that has to show its
 * work, and the cautious verdict is never the expensive one to file.
 */
export function validatePriorArt(input: PriorArtInput): PriorArtValidation {
  const abstained = input.abstained?.trim();
  const rawEntries = input.entries ?? [];

  if (abstained && rawEntries.length > 0) {
    return {
      ok: false,
      reason: "record either examined prior art or a reason for examining none, not both",
    };
  }
  if (abstained) {
    if (abstained.length > MAX_FIELD_LENGTH) {
      return { ok: false, reason: `the abstention reason must be at most ${MAX_FIELD_LENGTH} characters` };
    }
    return { ok: true, entries: [], abstained };
  }
  if (rawEntries.length === 0) {
    return {
      ok: false,
      reason:
        "record at least one examined precedent, or pass abstained with the reason none was examined",
    };
  }
  if (rawEntries.length > MAX_PRIOR_ART_ENTRIES) {
    return { ok: false, reason: `record at most ${MAX_PRIOR_ART_ENTRIES} precedents` };
  }

  const entries: PriorArtEntry[] = [];
  for (const [index, raw] of rawEntries.entries()) {
    const at = `entry ${index + 1}`;
    const source = raw?.source?.trim() ?? "";
    const claim = raw?.claim?.trim() ?? "";
    const checked = raw?.checked?.trim();
    const tradeoff = raw?.tradeoff?.trim();

    if (!source) return { ok: false, reason: `${at}: source is required` };
    if (!claim) return { ok: false, reason: `${at}: claim is required` };
    if (!SOURCE_KINDS.has(raw.sourceKind)) {
      return { ok: false, reason: `${at}: sourceKind must be source, docs, marketing, or secondhand` };
    }
    if (!VERDICTS.has(raw.verdict)) {
      return { ok: false, reason: `${at}: verdict must be adopt, adapt, or reject` };
    }
    for (const [label, value] of [["source", source], ["claim", claim], ["checked", checked], ["tradeoff", tradeoff]] as const) {
      if (value && value.length > MAX_FIELD_LENGTH) {
        return { ok: false, reason: `${at}: ${label} must be at most ${MAX_FIELD_LENGTH} characters` };
      }
    }

    // Adopting is the expensive verdict to be wrong about: it puts someone
    // else's design into this plan. clowder's teardown rule is that a claim
    // about how a project works has to reach the project, not its README, so
    // an adopt whose deepest look was the pitch is refused rather than filed.
    if (raw.verdict === "adopt" && !FIRSTHAND_KINDS.has(raw.sourceKind)) {
      return {
        ok: false,
        reason:
          `${at}: adopt needs a firsthand look — you read the ${raw.sourceKind === "marketing" ? "project's own pitch" : "secondhand summary"}, not the implementation or its documentation. Read the source, or record this as adapt or reject with the tradeoff.`,
      };
    }
    if (raw.verdict === "adopt" && !checked) {
      return {
        ok: false,
        reason: `${at}: adopt requires checked — name the file, path, or command that proved the claim to you`,
      };
    }
    if (raw.verdict !== "adopt" && !tradeoff) {
      return {
        ok: false,
        reason: `${at}: ${raw.verdict} requires tradeoff — say why this is not copied as-is, or the next round proposes it again`,
      };
    }

    entries.push({
      source,
      sourceKind: raw.sourceKind,
      claim,
      verdict: raw.verdict,
      ...(checked ? { checked } : {}),
      ...(tradeoff ? { tradeoff } : {}),
    });
  }
  return { ok: true, entries };
}

export interface PriorArtSummary {
  outcome: PriorArtOutcome;
  examined: number;
  adopted: number;
  adapted: number;
  rejected: number;
  /** Entries resting on the project's own pitch or someone's summary. */
  secondhand: number;
  abstainedReason?: string;
}

export function summarizePriorArt(ledger: PriorArtLedger | undefined): PriorArtSummary {
  if (!ledger) {
    return { outcome: "none", examined: 0, adopted: 0, adapted: 0, rejected: 0, secondhand: 0 };
  }
  const count = (verdict: PriorArtVerdict) =>
    ledger.entries.filter((entry) => entry.verdict === verdict).length;
  return {
    outcome: ledger.outcome,
    examined: ledger.entries.length,
    adopted: count("adopt"),
    adapted: count("adapt"),
    rejected: count("reject"),
    secondhand: ledger.entries.filter((entry) => !FIRSTHAND_KINDS.has(entry.sourceKind)).length,
    ...(ledger.abstainedReason ? { abstainedReason: ledger.abstainedReason } : {}),
  };
}

/**
 * Merges a new ledger into whatever the task already had. Critique is a
 * multi-round negotiation, and a precedent examined in round one is still
 * examined in round two: dropping it would quietly punish the author for
 * revising, and re-listing it every round is work that teaches nobody
 * anything. Entries are keyed by source so a revision can correct its own
 * earlier verdict without leaving both versions on the record.
 */
export function mergePriorArt(
  existing: PriorArtLedger | undefined,
  incoming: PriorArtLedger,
): PriorArtLedger {
  if (!existing) return incoming;
  const bySource = new Map<string, PriorArtEntry>();
  for (const entry of [...existing.entries, ...incoming.entries]) {
    bySource.set(entry.source.trim().toLowerCase(), entry);
  }
  const entries = [...bySource.values()].slice(0, MAX_PRIOR_ART_ENTRIES);
  // An abstention is only honest while nothing has been examined. Once any
  // round records a precedent, the task has prior art and saying otherwise
  // would misreport it on the approval card.
  const outcome = entries.length > 0 ? "recorded" : incoming.outcome;
  const abstainedReason = entries.length > 0 ? undefined : incoming.abstainedReason ?? existing.abstainedReason;
  return {
    ...incoming,
    outcome,
    entries,
    ...(abstainedReason ? { abstainedReason } : {}),
  };
}

/** What the lane means for the Agent writing the plan. */
export const PRIOR_ART_AUTHOR_BRIEF: string[] = [
  "- Someone has probably solved a version of this already. Before settling on an approach, look at how comparable systems do it, and record what you found with record_prior_art: the source, how deep you actually looked, the claim, and your verdict.",
  "- Reaching a project's README is not reaching the project. To adopt an approach you must have read its implementation or its real documentation and be able to name what you read; otherwise record it as adapt or reject and say what the tradeoff is.",
  "- Deciding not to follow a precedent is a result, not a gap — as long as the reason is on the record. So is finding nothing: if no comparable prior art exists, this run cannot reach any, or the change is too local for it to matter, call record_prior_art with abstained and say which. Silence is the only answer the plan cannot defend.",
];

/** What a recorded, empty, or abstained ledger means for the critique reviewer. */
export function priorArtCritiqueBrief(summary: PriorArtSummary): string[] {
  if (summary.outcome === "none") {
    return [
      "- The author recorded no prior art and gave no reason for that. Nothing here has been checked against how comparable systems solve this, so treat any claim that this design is the natural one as unargued.",
    ];
  }
  if (summary.outcome === "abstained") {
    return [
      `- The author examined no prior art and gave this reason: ${summary.abstainedReason ?? "(none given)"}. Judge the reason, not just the plan — if comparable work does exist and is reachable, that is a finding.`,
    ];
  }
  const lines = [
    `- The author recorded ${summary.examined} examined precedent(s): ${summary.adopted} adopt, ${summary.adapted} adapt, ${summary.rejected} reject. These are the author's claims about other people's systems, not established fact — spot-check the ones the plan leans on hardest.`,
  ];
  if (summary.secondhand > 0) {
    lines.push(
      `- ${summary.secondhand} of them rest on the project's own pitch or a secondhand summary rather than its implementation. A plan that leans on one of those is leaning on marketing.`,
    );
  }
  return lines;
}
