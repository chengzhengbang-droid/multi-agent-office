import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advisoryFindings,
  gatingFindings,
  humanQuestions,
  normalizeFindings,
  objectionsUnchanged,
  sameObjection,
  stalledRounds,
} from "../src/core/review-convergence.js";
import type { ReviewFinding } from "../src/core/types.js";

const finding = (
  detail: string,
  severity: ReviewFinding["severity"] = "blocking",
  kind?: ReviewFinding["kind"],
): ReviewFinding => ({ detail, severity, ...(kind ? { kind } : {}) });

test("a pre-severity finding replays with the weight it had when it was written", () => {
  // Bare strings come from logs where every finding blocked. Reading them as
  // comments now would retroactively approve work a peer had objected to.
  assert.deepEqual(normalizeFindings(["  补上回滚方案  ", "", "   "]), [
    { detail: "补上回滚方案", severity: "major", kind: "defect" },
  ]);
  assert.deepEqual(normalizeFindings([{ detail: "命名可以更好", severity: "minor" }]), [
    { detail: "命名可以更好", severity: "minor", kind: "defect" },
  ]);
  assert.deepEqual(normalizeFindings(undefined), []);
});

test("severity, not the verdict, decides what holds the task", () => {
  const findings = [
    finding("错误分支没有处理", "blocking"),
    finding("缺少一个测试", "major"),
    finding("这个名字可以更好", "minor"),
    finding("要不要支持离线模式，原始任务没说", "blocking", "question"),
  ];
  assert.deepEqual(
    gatingFindings(findings).map((item) => item.detail),
    ["错误分支没有处理", "缺少一个测试", "要不要支持离线模式，原始任务没说"],
  );
  assert.deepEqual(advisoryFindings(findings).map((item) => item.detail), ["这个名字可以更好"]);
  // A question only counts when it also gates: a minor "just wondering" is a
  // comment, and comments do not interrupt a human's day.
  assert.deepEqual(humanQuestions(findings).map((item) => item.detail), [
    "要不要支持离线模式，原始任务没说",
  ]);
  assert.deepEqual(humanQuestions([finding("随便问问", "minor", "question")]), []);
});

test("a rephrased objection is still the same objection", () => {
  assert.ok(
    sameObjection(
      finding("解析失败时没有错误处理分支"),
      finding("解析失败时缺少错误处理分支"),
    ),
  );
  assert.ok(sameObjection(finding("missing error handling on parse"), finding("Missing error handling on parse")));
  assert.ok(!sameObjection(finding("解析失败时没有错误处理分支"), finding("配置文件的默认值写错了")));
  assert.ok(!sameObjection(finding("missing error handling"), finding("the default config value is wrong")));
});

test("a round that resolved something is progress, even if what remains is identical", () => {
  const first = [finding("错误分支没有处理"), finding("缺少一个测试")];
  const second = [finding("错误分支没有处理")];
  assert.ok(!objectionsUnchanged(first, second));
  // And so is a new objection: the reviewer is still finding real things.
  assert.ok(!objectionsUnchanged(second, [finding("错误分支没有处理"), finding("并发写会互相覆盖")]));
  assert.ok(objectionsUnchanged(second, [finding("错误分支还是没有处理")]));
  // An approved round pushes an empty list, which can never be a stall.
  assert.ok(!objectionsUnchanged([], second));
});

test("stalled rounds are counted from the history, not from a counter", () => {
  const wall = [finding("回滚路径还是没写清楚")];
  assert.equal(stalledRounds([]), 0);
  assert.equal(stalledRounds([wall]), 0);
  assert.equal(stalledRounds([wall, wall]), 1);
  assert.equal(stalledRounds([wall, wall, wall]), 2);
  // The streak restarts as soon as a round moves.
  assert.equal(stalledRounds([wall, wall, [finding("并发写会互相覆盖")]]), 0);
});
