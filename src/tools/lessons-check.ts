/**
 * `pnpm run check` 里的 lessons 闸门：改了代码就必须在 lessons/ 的某一卷里留下一条记录。
 *
 * 这个文件只负责跟 git 说话，判断全在 lessons-guard.ts（那边有单元测试）。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
  LESSONS_DIR,
  NO_LESSON_MARKER,
  describeEntryProblem,
  evaluateLessonsGuard,
  isLessonsVolume,
  validateLessonsVolume,
  type LessonEntryHeading,
  type LessonsFileProblem,
} from "./lessons-guard.js";

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function tryGit(args: readonly string[], cwd: string): string | undefined {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
}

function toLines(output: string | undefined): string[] {
  if (!output) return [];
  return output.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

/**
 * 找一个"这次改动从哪里开始"的基点。
 *
 * 找不到就放行并说明原因（浅克隆、还没有远端、独立的 git 仓库都会走到这里）。
 * 静默跳过是不行的：一道会悄悄消失的闸门比没有闸门更糟，因为大家以为它还在。
 */
function resolveBase(repoRoot: string): { base: string; label: string } | undefined {
  const override = process.env["LESSONS_BASE"]?.trim();
  if (override) {
    const resolved = tryGit(["rev-parse", "--verify", `${override}^{commit}`], repoRoot)?.trim();
    if (resolved) return { base: resolved, label: `LESSONS_BASE=${override}` };
    console.warn(`[lessons] LESSONS_BASE=${override} 解析不到，回退到默认基点。`);
  }

  for (const candidate of ["origin/main", "main", "origin/HEAD"]) {
    const exists = tryGit(["rev-parse", "--verify", `${candidate}^{commit}`], repoRoot);
    if (!exists) continue;
    const mergeBase = tryGit(["merge-base", "HEAD", candidate], repoRoot)?.trim();
    if (mergeBase) return { base: mergeBase, label: `merge-base HEAD ${candidate}` };
  }
  return undefined;
}

function collectChangedPaths(repoRoot: string, base: string): string[] {
  const tracked = toLines(tryGit(["diff", "--name-only", base], repoRoot));
  const untracked = toLines(tryGit(["ls-files", "--others", "--exclude-standard"], repoRoot));
  return [...new Set([...tracked, ...untracked])];
}

function collectAddedHeadings(
  repoRoot: string,
  base: string,
  changedPaths: readonly string[],
): LessonEntryHeading[] {
  const headings: LessonEntryHeading[] = [];

  const diff = tryGit(["diff", "--unified=0", base, "--", `${LESSONS_DIR}/`], repoRoot) ?? "";
  let currentFile: string | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      currentFile = target === "/dev/null" ? undefined : target.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (!line.startsWith("+") || currentFile === undefined) continue;
    const content = line.slice(1);
    if (content.startsWith("### ")) headings.push({ line: content, file: currentFile });
  }

  // 还没进索引的新分卷文件在 diff 里看不见，整份当成新增。
  for (const file of changedPaths) {
    if (!isLessonsVolume(file)) continue;
    const isUntracked = !tryGit(["ls-files", "--error-unmatch", file], repoRoot);
    if (!isUntracked) continue;
    for (const line of readFileSync(path.join(repoRoot, file), "utf8").split("\n")) {
      if (line.startsWith("### ")) headings.push({ line, file });
    }
  }

  return headings;
}

function validateAllVolumes(repoRoot: string): LessonsFileProblem[] {
  const dir = path.join(repoRoot, LESSONS_DIR);
  const problems: LessonsFileProblem[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = `${LESSONS_DIR}/${name}`;
    if (!isLessonsVolume(file)) continue;
    problems.push(...validateLessonsVolume(file, readFileSync(path.join(repoRoot, file), "utf8")));
  }
  return problems;
}

function main(): number {
  const repoRoot = tryGit(["rev-parse", "--show-toplevel"], process.cwd())?.trim();
  if (!repoRoot) {
    console.warn("[lessons] 不在 git 仓库里，跳过教训记录检查。");
    return 0;
  }

  const volumeProblems = validateAllVolumes(repoRoot);
  if (volumeProblems.length > 0) {
    console.error("[lessons] 分卷文件格式不对：");
    for (const problem of volumeProblems) console.error(`  - ${problem.file}：${problem.message}`);
    console.error(`  骨架见 ${LESSONS_DIR}/README.md 的「格式」一节。`);
    return 1;
  }

  const resolved = resolveBase(repoRoot);
  if (!resolved) {
    console.warn("[lessons] 找不到可比的基点（浅克隆或没有 main），跳过教训记录检查。");
    return 0;
  }

  const changedPaths = collectChangedPaths(repoRoot, resolved.base);
  const verdict = evaluateLessonsGuard({
    changedPaths,
    addedEntryHeadings: collectAddedHeadings(repoRoot, resolved.base, changedPaths),
  });

  switch (verdict.status) {
    case "ok":
      if (verdict.reason === "no-code-change") {
        console.log(`[lessons] 本次没有代码改动（基点：${resolved.label}），无需记录。`);
      } else {
        const summary = verdict.entries
          .map((entry) => `${entry.date} · ${entry.isNoLesson ? `${NO_LESSON_MARKER}：` : ""}${entry.text}`)
          .join("\n           ");
        console.log(`[lessons] 已记录 ${verdict.entries.length} 条：\n           ${summary}`);
      }
      return 0;

    case "malformed-entry":
      console.error("[lessons] 变更日志条目写坏了：");
      for (const problem of verdict.problems) console.error(`  - ${describeEntryProblem(problem)}`);
      return 1;

    case "missing-entry": {
      const shown = verdict.changedCodePaths.slice(0, 8);
      console.error("[lessons] 这次改了代码，但 lessons/ 里没有新增条目。");
      for (const file of shown) console.error(`  - ${file}`);
      if (verdict.changedCodePaths.length > shown.length) {
        console.error(`  - …还有 ${verdict.changedCodePaths.length - shown.length} 个文件`);
      }
      console.error("");
      console.error(`  往 ${LESSONS_DIR}/ 里对应的那一卷的「变更日志」顶部加一条：`);
      console.error("    ### YYYY-MM-DD · 标题");
      console.error(`  这次确实没有值得记的判断，就写一条无教训记录，并说清为什么：`);
      console.error(`    ### YYYY-MM-DD · ${NO_LESSON_MARKER} · 跟着已有模式加的，没有新判断`);
      console.error(`  怎么挑分卷见 ${LESSONS_DIR}/README.md。`);
      return 1;
    }
  }
}

process.exit(main());
