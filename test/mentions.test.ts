import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAgentMentions, parseUserMentions } from "../src/core/mentions.js";
import type { AgentDefinition } from "../src/core/types.js";

const agents = [peer("pi"), peer("codex"), peer("research")];

test("user mentions work in normal text and exclude code, URLs, and quoted strings", () => {
  const result = parseUserMentions(
    [
      "请让 @pi 先做，再由 @codex 判断。",
      "`@research`",
      "```ts",
      "const owner = '@research';",
      "```",
      "https://example.test/@research",
      '引用字符串 "@research"',
    ].join("\n"),
    agents,
  );
  assert.deepEqual(result.targets, ["pi", "codex"]);
  assert.deepEqual(result.unknown, []);
});

test("user parser excludes mentions in an unclosed fenced block", () => {
  const result = parseUserMentions("@pi start\n```\n@codex hidden", agents);
  assert.deepEqual(result.targets, ["pi"]);
});

test("Agent routing only accepts a handle immediately after a permitted line prefix", () => {
  const result = parseAgentMentions(
    [
      "普通文字 @pi 不路由",
      "@pi 接手",
      "- @codex 审查",
      "> @research 调研",
      "@pi 文中再次写 @research 不应多路由",
    ].join("\n"),
    agents,
    3,
  );
  assert.deepEqual(result.targets, ["pi", "codex", "research"]);
});

test("mention parsing reports unknown and overflow targets", () => {
  const unknown = parseUserMentions("@missing help", agents);
  assert.deepEqual(unknown.unknown, ["missing"]);
  const overflow = parseUserMentions("@pi @codex @research", agents, 2);
  assert.deepEqual(overflow.targets, ["pi", "codex"]);
  assert.equal(overflow.overflow, true);
});

function peer(id: string): AgentDefinition {
  return {
    id,
    displayName: id,
    description: "test",
    systemPrompt: "test",
    capabilities: [],
    enabled: true,
    accessMode: "read-only",
    runtime: { kind: "pi", provider: "test", model: "test", thinkingLevel: "off" },
  };
}
