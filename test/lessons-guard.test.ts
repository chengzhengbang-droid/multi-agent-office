import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_NO_LESSON_REASON_LENGTH,
  classifyChangedPath,
  evaluateLessonsGuard,
  isLessonsVolume,
  parseLessonEntryHeading,
  validateLessonsVolume,
} from "../src/tools/lessons-guard.js";

const volume = "lessons/frontend.md";

function heading(line: string, file = volume) {
  return { line, file };
}

/** 解析失败时的 kind，解析成功时返回 undefined，方便直接断言。 */
function problemKind(line: string): string | undefined {
  const parsed = parseLessonEntryHeading(heading(line));
  return "kind" in parsed ? parsed.kind : undefined;
}

test("源码、测试与构建配置都算欠教训的改动", () => {
  assert.equal(classifyChangedPath("src/web/App.tsx"), "code");
  assert.equal(classifyChangedPath("test/collaboration.test.ts"), "code");
  assert.equal(classifyChangedPath("package.json"), "code");
  assert.equal(classifyChangedPath(".github/workflows/checks.yml"), "code");
  assert.equal(classifyChangedPath("src\\core\\event-store.ts"), "code");
});

test("文档、锁文件与 lessons/ 自身不欠教训", () => {
  assert.equal(classifyChangedPath("README.md"), "other");
  assert.equal(classifyChangedPath("CLAUDE.md"), "other");
  assert.equal(classifyChangedPath("pnpm-lock.yaml"), "other");
  assert.equal(classifyChangedPath("lessons/frontend.md"), "lessons");
  assert.equal(classifyChangedPath("build/icon.png"), "other");
});

test("索引和规矩不算分卷：规矩要有分卷里的出处", () => {
  assert.equal(isLessonsVolume("lessons/frontend.md"), true);
  assert.equal(isLessonsVolume("lessons/README.md"), false);
  assert.equal(isLessonsVolume("lessons/rules.md"), false);
  assert.equal(isLessonsVolume("src/core/types.ts"), false);
});

test("标题可以带中间段，比如 commit 短哈希", () => {
  const parsed = parseLessonEntryHeading(heading("### 2026-09-03 · 04fd933 · 用停滞判据取代轮数上限"));
  assert.deepEqual(parsed, {
    date: "2026-09-03",
    isNoLesson: false,
    text: "04fd933 · 用停滞判据取代轮数上限",
  });
});

test("无教训记录必须说清为什么", () => {
  const ok = parseLessonEntryHeading(heading("### 2026-09-04 · 无教训 · 跟着已有的 provider 预设加了一条"));
  assert.deepEqual(ok, {
    date: "2026-09-04",
    isNoLesson: true,
    text: "跟着已有的 provider 预设加了一条",
  });

  // 出口要收费：理由太短就不算给过理由，否则"没有"和"忘了写"分不出来。
  const tooShort = parseLessonEntryHeading(heading("### 2026-09-04 · 无教训 · 无"));
  assert.deepEqual(tooShort, {
    kind: "no-lesson-reason-missing",
    line: "### 2026-09-04 · 无教训 · 无",
    file: volume,
  });

  assert.equal(problemKind("### 2026-09-04 · 无教训"), "no-lesson-reason-missing");
  assert.ok(MIN_NO_LESSON_REASON_LENGTH > 4);
});

test("日期和标题的形状不对就报出来", () => {
  assert.equal(problemKind("### 显示位置是另一层判断"), "bad-date");
  assert.equal(problemKind("## 2026-09-04 · 标题写得很清楚"), "not-an-entry");
  assert.equal(problemKind("### 2026-09-04 · 修"), "title-too-short");
  assert.equal(problemKind("### 2026-09-04"), "title-too-short");
});

test("只改文档不欠教训", () => {
  const verdict = evaluateLessonsGuard({
    changedPaths: ["README.md", "lessons/rules.md"],
    addedEntryHeadings: [],
  });
  assert.deepEqual(verdict, { status: "ok", reason: "no-code-change", entries: [] });
});

test("改了代码却没有新条目 → 拦住，并说清是哪些文件", () => {
  const verdict = evaluateLessonsGuard({
    changedPaths: ["src/core/collaboration.ts", "README.md"],
    addedEntryHeadings: [],
  });
  assert.equal(verdict.status, "missing-entry");
  assert.deepEqual(
    verdict.status === "missing-entry" ? verdict.changedCodePaths : [],
    ["src/core/collaboration.ts"],
  );
});

test("往规矩卷里加一条不能顶替分卷里的记录", () => {
  const verdict = evaluateLessonsGuard({
    changedPaths: ["src/core/collaboration.ts"],
    addedEntryHeadings: [heading("### 2026-09-04 · 只写在规矩里", "lessons/rules.md")],
  });
  assert.equal(verdict.status, "missing-entry");
});

test("分卷里有一条合格的新条目就放行", () => {
  const verdict = evaluateLessonsGuard({
    changedPaths: ["src/core/collaboration.ts"],
    addedEntryHeadings: [heading("### 2026-09-04 · 显示位置是另一层判断")],
  });
  assert.equal(verdict.status, "ok");
  assert.equal(verdict.status === "ok" ? verdict.reason : undefined, "entry-recorded");
});

test("写坏的条目照样报错，哪怕这次没有代码改动", () => {
  const verdict = evaluateLessonsGuard({
    changedPaths: ["README.md"],
    addedEntryHeadings: [heading("### 2026-09-04 · 无教训 · 无")],
  });
  assert.equal(verdict.status, "malformed-entry");
});

test("分卷骨架校验：缺适用范围或变更日志都要报", () => {
  const good = [
    "# 前端与渲染",
    "",
    "**适用范围**：`src/web/**`。",
    "",
    "## 变更日志",
    "",
    "### 2026-09-04 · 显示位置是另一层判断",
  ].join("\n");
  assert.deepEqual(validateLessonsVolume(volume, good), []);

  const bad = ["# 前端与渲染", "", "### 2026-09-04 · 一条写得下去的标题"].join("\n");
  const problems = validateLessonsVolume(volume, bad);
  assert.equal(problems.length, 2);
  assert.ok(problems.every((problem) => problem.file === volume));

  const malformed = [
    "# 前端与渲染",
    "",
    "**适用范围**：`src/web/**`。",
    "",
    "## 变更日志",
    "",
    "### 随手写的标题",
  ].join("\n");
  assert.equal(validateLessonsVolume(volume, malformed).length, 1);
});
