import assert from "node:assert/strict";
import { test } from "node:test";
import {
  modelFamilyOf,
  PEER_REVIEWER_ROLE,
  resolveReviewerMatch,
  type ReviewerCandidate,
} from "../src/core/reviewer-routing.js";
import type { AgentDefinition, RuntimeSpec } from "../src/core/types.js";

function agent(id: string, runtime: RuntimeSpec, overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id,
    displayName: id,
    description: "",
    systemPrompt: "",
    capabilities: [],
    enabled: true,
    accessMode: "read-only",
    runtime,
    ...overrides,
  };
}

const pi = (provider: string): RuntimeSpec => ({
  kind: "pi",
  provider,
  model: "model-1",
  thinkingLevel: "medium",
});
const codex: RuntimeSpec = { kind: "codex", command: "codex" };

function candidate(definition: AgentDefinition, overrides: Partial<ReviewerCandidate> = {}): ReviewerCandidate {
  return { agent: definition, routable: true, contributor: false, ...overrides };
}

test("model family is the provider behind an Agent, normalised", () => {
  assert.equal(modelFamilyOf(pi("Anthropic")), "anthropic");
  assert.equal(modelFamilyOf(codex), "codex");
});

test("a peer from another model family outranks a same-family peer", () => {
  const match = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      candidate(agent("sibling", pi("anthropic"))),
      candidate(agent("outsider", codex)),
    ],
  });
  assert.equal(match.reviewerAgentId, "outsider");
  assert.equal(match.crossFamily, true);
  assert.equal(match.degraded, false);
  assert.deepEqual(match.degradeReasons, []);
});

test("chain independence outranks the cross-family preference", () => {
  const match = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      // Different family, but it already produced work in this chain.
      candidate(agent("outsider", codex), { contributor: true }),
      candidate(agent("sibling", pi("anthropic"))),
    ],
  });
  assert.equal(match.reviewerAgentId, "sibling");
  assert.equal(match.independent, true);
  assert.deepEqual(match.degradeReasons, ["same-family"]);
  assert.equal(match.degraded, true);
});

test("a degraded match is recorded rather than refused", () => {
  const match = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      candidate(agent("sibling", pi("anthropic")), { contributor: true }),
    ],
  });
  assert.equal(match.reviewerAgentId, "sibling");
  assert.deepEqual(match.degradeReasons, ["chain-contributor", "same-family"]);
});

test("the peer-reviewer role filters candidates only when someone declares it", () => {
  const withoutRole = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      candidate(agent("sibling", pi("anthropic"))),
    ],
  });
  assert.equal(withoutRole.reviewerAgentId, "sibling");

  const withRole = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      // Cross-family, but it does not hold the role someone else declares.
      candidate(agent("outsider", codex)),
      candidate(agent("sibling", pi("anthropic"), { capabilities: [PEER_REVIEWER_ROLE] })),
    ],
  });
  assert.equal(withRole.reviewerAgentId, "sibling");
});

test("unavailable peers and the author itself never review", () => {
  const match = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      candidate(agent("offline", codex), { routable: false }),
    ],
  });
  assert.equal(match.reviewerAgentId, undefined);
  assert.deepEqual(match.candidates, []);
  assert.equal(match.degraded, true);
});

test("the roster's configured reviewer wins over the heuristics, activity over roster order", () => {
  // An explicit per-author assignment is a human decision about this author,
  // so it outranks both the cross-family preference and thread activity — and
  // the same-family cost of honouring it is still recorded.
  const configured = resolveReviewerMatch({
    authorAgentId: "author",
    preferredReviewerId: "quiet",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      candidate(agent("chatty", pi("anthropic")), { lastActiveAt: 900 }),
      candidate(agent("outsider", codex)),
      candidate(agent("quiet", pi("anthropic"))),
    ],
  });
  assert.equal(configured.reviewerAgentId, "quiet");
  assert.deepEqual(configured.degradeReasons, ["same-family"]);

  const unconfigured = resolveReviewerMatch({
    authorAgentId: "author",
    candidates: [
      candidate(agent("author", pi("anthropic"))),
      candidate(agent("first", pi("anthropic"))),
      candidate(agent("chatty", pi("anthropic")), { lastActiveAt: 900 }),
    ],
  });
  assert.equal(unconfigured.reviewerAgentId, "chatty");
});
