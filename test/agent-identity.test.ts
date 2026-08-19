import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_AVATAR_TONES,
  agentAvatarTone,
  agentInitials,
} from "../src/web/agent-identity.js";

test("avatar tones are stable, in range, and spread across a Pi-per-provider roster", () => {
  const handles = ["pi", "codex", "pi-deepseek", "pi-glm", "agent-2", "agent-3"];
  for (const handle of handles) {
    const tone = agentAvatarTone(handle);
    assert.equal(tone, agentAvatarTone(handle), `tone for ${handle} must be stable`);
    assert.ok(Number.isInteger(tone) && tone >= 0 && tone < AGENT_AVATAR_TONES);
  }
  // The handles that used to collide on the same initial must not also collide
  // on colour, or the roster is unreadable.
  assert.notEqual(agentAvatarTone("pi-deepseek"), agentAvatarTone("pi-glm"));
  assert.notEqual(agentAvatarTone("agent-2"), agentAvatarTone("agent-3"));
});

test("initials separate handles that share a first letter", () => {
  assert.equal(agentInitials("pi-deepseek"), "PD");
  assert.equal(agentInitials("pi-glm"), "PG");
  assert.equal(agentInitials("agent-2"), "A2");
  assert.equal(agentInitials("pi"), "PI");
  assert.equal(agentInitials("codex"), "CO");
  assert.equal(agentInitials("x"), "X");
  assert.equal(agentInitials(""), "?");
});
