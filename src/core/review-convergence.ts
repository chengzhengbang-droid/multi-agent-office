import type { ReviewFinding, ReviewFindingInput } from "./types.js";

/**
 * When peer review has stopped converging, and what still holds a task back.
 *
 * The problem this exists for: a round budget is a clock, not a disagreement
 * detector. Spending the last round is not evidence that two peers disagree —
 * only that they ran out of turns — so escalating on "rounds used up" hands the
 * human a task whose peers may well have been one exchange from agreeing, and
 * does it on almost every task. clowder-ai does not count turns for this. It
 * triages findings by severity (`cat-cafe-skills/receive-review`: P1 blocks, P3
 * is discussed and dropped) and escalates on a named stall instead — the same
 * finding surviving three rounds means the gap is upstream of the code, so stop
 * and fetch a human rather than keep grinding (its "≥3 轮升级规则").
 *
 * This module is the mechanical half of that: which objections gate, and
 * whether a round moved. Everything here is a pure function over findings, so
 * the platform's escalation decision can be replayed from the event log and
 * argued with in a test rather than inferred from a counter.
 */

/** How similar two objections' shingle sets must be to count as the same one. */
const SAME_OBJECTION_JACCARD = 0.6;

/** Or: how much of the shorter objection the longer one has to contain. */
const SAME_OBJECTION_CONTAINMENT = 0.85;

/**
 * Both thresholds are deliberately high. Reading two different objections as
 * one declares a stall that is not there and calls a human early, which is the
 * failure this module exists to remove; missing a repeat only means the
 * discussion runs to its hard round cap, which was the old behaviour anyway.
 */

/**
 * What decides whether a task keeps a human waiting. Stated to the reviewer in
 * both the review brief and the system prompt, because a reviewer that believes
 * every objection blocks will block on nits — and nits are what used to spend
 * the round budget that then summoned the operator.
 */
export const REVIEW_SEVERITY_BRIEF = [
  "Severity, not the verdict, is what holds the task: give every finding a severity.",
  "blocking — must not ship as is. major — wrong or missing enough that the author has to answer it. minor — a nit, a preference, a follow-up idea.",
  "If nothing you found is blocking or major, that is an approval with comments: approve and list the minor findings anyway. The author still gets them; nobody waits on them.",
  "Mark a finding kind=question only when it turns on something the human never decided and no amount of discussion between the two of you could settle. It stops the discussion and asks them directly, so never use it for something you could work out yourselves.",
] as const;

/**
 * Findings as the platform reasons about them. A bare string is a pre-severity
 * log entry, and back then every finding blocked, so it replays as "major"
 * rather than being quietly downgraded to a comment.
 */
export function normalizeFindings(findings: ReviewFindingInput[] | undefined): ReviewFinding[] {
  return (findings ?? [])
    .map((finding) =>
      typeof finding === "string"
        ? { detail: finding.trim(), severity: "major" as const, kind: "defect" as const }
        : {
            detail: finding.detail.trim(),
            severity: finding.severity,
            kind: finding.kind ?? ("defect" as const),
          },
    )
    .filter((finding) => finding.detail.length > 0);
}

/** The objections that actually hold the task back. */
export function gatingFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((finding) => finding.severity !== "minor");
}

/** The rest: real feedback, handed to the author as comments rather than a gate. */
export function advisoryFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.filter((finding) => finding.severity === "minor");
}

/**
 * Gating objections that no further peer round can settle, because they are
 * about something the human never decided. Peers can argue a defect to a
 * conclusion; they can only guess at an unstated requirement.
 */
export function humanQuestions(findings: ReviewFinding[]): ReviewFinding[] {
  return gatingFindings(findings).filter((finding) => finding.kind === "question");
}

/** One finding as a line in a brief or a thread message. */
export function findingLabel(finding: ReviewFinding): string {
  const kind = finding.kind === "question" ? "，需要人类回答" : "";
  return `[${finding.severity}${kind}] ${finding.detail}`;
}

/**
 * Whether two objections are the same objection restated. Reviewers rephrase
 * between rounds, so this compares shingle sets rather than text: word tokens
 * for scripts that space their words, character bigrams for the CJK runs that
 * do not.
 */
export function sameObjection(left: ReviewFinding, right: ReviewFinding): boolean {
  const a = shingles(left.detail);
  const b = shingles(right.detail);
  if (a.size === 0 || b.size === 0) return left.detail === right.detail;
  let shared = 0;
  for (const shingle of a) if (b.has(shingle)) shared++;
  const union = a.size + b.size - shared;
  if (union > 0 && shared / union >= SAME_OBJECTION_JACCARD) return true;
  return shared / Math.min(a.size, b.size) >= SAME_OBJECTION_CONTAINMENT;
}

/**
 * Whether a round moved. Objections are unchanged when each side covers the
 * other: the author resolved none of them and the reviewer found nothing new.
 * A shrinking list is progress even if what remains is word-for-word identical,
 * and so is a new objection — the hard round cap is what bounds the case where
 * a reviewer keeps finding fresh things forever.
 */
export function objectionsUnchanged(
  previous: ReviewFinding[],
  current: ReviewFinding[],
): boolean {
  if (previous.length === 0 || current.length === 0) return false;
  const covers = (haystack: ReviewFinding[], needles: ReviewFinding[]): boolean =>
    needles.every((needle) => haystack.some((candidate) => sameObjection(candidate, needle)));
  return covers(previous, current) && covers(current, previous);
}

/**
 * How many rounds in a row have now restated the round before them. Counted
 * from the full history rather than kept in a counter so that a replayed log
 * reaches the same escalation decision as the live run did.
 */
export function stalledRounds(history: ReviewFinding[][]): number {
  let stalled = 0;
  for (let index = history.length - 1; index > 0; index--) {
    if (!objectionsUnchanged(history[index - 1] as ReviewFinding[], history[index] as ReviewFinding[])) break;
    stalled++;
  }
  return stalled;
}

/** Word tokens, plus character bigrams inside each unspaced CJK run. */
function shingles(text: string): Set<string> {
  const runs = text.toLowerCase().normalize("NFKC").match(RUN_PATTERN) ?? [];
  const result = new Set<string>();
  for (const run of runs) {
    if (!CJK_PATTERN.test(run)) {
      result.add(run);
      continue;
    }
    if (run.length === 1) {
      result.add(run);
      continue;
    }
    for (let index = 0; index + 1 < run.length; index++) result.add(run.slice(index, index + 2));
  }
  return result;
}

// CJK first, so a mixed run like "解析JSON" splits into one CJK run and one word
// instead of being swallowed whole by the general letter class.
const RUN_PATTERN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}]+/gu;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
