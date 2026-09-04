/**
 * 「改了代码就要留下教训」这条约定的机制化实现。
 *
 * 为什么是机制而不是措辞：见 lessons/rules.md 规矩 7。同一句话写在 CLAUDE.md 里
 * 已经漏掉过相当一部分改动；这里把它接进 `pnpm run check`，忘记的成本从零变成红色。
 *
 * 这个文件只做判断，不碰 git —— 输入是"改了哪些路径"和"lessons/ 里新增了哪些标题行"，
 * 输出是裁决。git 那一侧在 lessons-check.ts。分开是为了让每条规则都能被单元测试，
 * 而不是只能靠在本仓库跑一遍看红不红来验证。
 */

export const LESSONS_DIR = "lessons";
export const LESSONS_INDEX = "lessons/README.md";
export const LESSONS_RULES = "lessons/rules.md";

/** 无教训记录的标记词。出口要留，但要收费——见 lessons/process.md。 */
export const NO_LESSON_MARKER = "无教训";

/**
 * 无教训记录的理由至少要这么长。
 *
 * 取 8 是因为"跟着已有模式加了一条"这种最短的合法理由是 12 个字，而"无""没有""不需要"
 * 这类应付都在 4 个字以内。卡在中间，错向宽松一侧：这里误放一条含糊的理由，代价是
 * 多一行噪音；误拒一条真实的理由，代价是逼人编一条教训——后者更贵。
 */
export const MIN_NO_LESSON_REASON_LENGTH = 8;

/** 教训标题的最小长度。比无教训的理由松，因为标题下面还有正文。 */
export const MIN_TITLE_LENGTH = 4;

export type ChangeKind = "code" | "lessons" | "other";

export interface LessonEntryHeading {
  /** 原始标题行，报错时原样回显，便于对照。 */
  readonly line: string;
  /** 这条标题所在的分卷文件，仓库相对路径。 */
  readonly file: string;
}

export interface ParsedLessonEntry {
  readonly date: string;
  readonly isNoLesson: boolean;
  /** 教训条目是标题；无教训条目是那句理由。 */
  readonly text: string;
}

export type EntryProblem =
  | { readonly kind: "not-an-entry"; readonly line: string; readonly file: string }
  | { readonly kind: "bad-date"; readonly line: string; readonly file: string }
  | { readonly kind: "title-too-short"; readonly line: string; readonly file: string }
  | { readonly kind: "no-lesson-reason-missing"; readonly line: string; readonly file: string };

export type LessonsGuardVerdict =
  | { readonly status: "ok"; readonly reason: "no-code-change" | "entry-recorded"; readonly entries: readonly ParsedLessonEntry[] }
  | { readonly status: "missing-entry"; readonly changedCodePaths: readonly string[] }
  | { readonly status: "malformed-entry"; readonly problems: readonly EntryProblem[] };

export interface LessonsGuardInput {
  /** 相对仓库根的改动路径，已提交的和工作区里的都算。 */
  readonly changedPaths: readonly string[];
  /** lessons/ 的分卷文件里**新增**的标题行（以 `###` 开头的那些）。 */
  readonly addedEntryHeadings: readonly LessonEntryHeading[];
}

/** 文档、锁文件、图标之类改了不欠教训的东西。 */
const NON_CODE_FILES = new Set([
  "README.md",
  "CLAUDE.md",
  "AGENTS.md",
  "LESSONS.md",
  ".gitignore",
  ".env.example",
  "pnpm-lock.yaml",
]);

const CODE_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.web.json",
  "vite.config.ts",
  "index.html",
]);

const CODE_PREFIXES = ["src/", "test/", ".github/workflows/"];

export function classifyChangedPath(path: string): ChangeKind {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (normalized === LESSONS_DIR || normalized.startsWith(`${LESSONS_DIR}/`)) return "lessons";
  if (NON_CODE_FILES.has(normalized)) return "other";
  if (CODE_FILES.has(normalized)) return "code";
  if (CODE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "code";
  return "other";
}

/**
 * 分卷文件 = lessons/ 下除索引和规矩之外的 .md。
 *
 * 规矩那一卷不算数：规矩是从两次以上的教训里提炼出来的，直接往那里加一条而不在
 * 分卷里留出处，等于跳过了"这次到底发生了什么"。
 */
export function isLessonsVolume(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.startsWith(`${LESSONS_DIR}/`) || !normalized.endsWith(".md")) return false;
  return normalized !== LESSONS_INDEX && normalized !== LESSONS_RULES;
}

const ENTRY_PREFIX = "### ";
const SEPARATOR = "·";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 解析一条变更日志标题。接受两种形状：
 *   ### 2026-09-04 · 标题
 *   ### 2026-09-04 · 04fd933 · 标题        （中间段可以是 commit 短哈希等）
 *   ### 2026-09-04 · 无教训 · 为什么这次没有
 */
export function parseLessonEntryHeading(
  heading: LessonEntryHeading,
): ParsedLessonEntry | EntryProblem {
  const { line, file } = heading;
  const trimmed = line.trim();
  if (!trimmed.startsWith(ENTRY_PREFIX)) return { kind: "not-an-entry", line, file };

  // 只在第一个分隔符处切，剩下的原样保留：`04fd933 · 标题` 这种中间段是标题的一部分，
  // 拆开再拼回去会丢掉原来的空格，让报错信息跟文件里的原文对不上。
  const body = trimmed.slice(ENTRY_PREFIX.length);
  const firstBreak = body.indexOf(SEPARATOR);
  if (firstBreak < 0) {
    // 只有日期、后面什么都没写，报"标题太短"而不是"日期不对"——报错要指向真正缺的东西。
    const kind = DATE_PATTERN.test(body.trim()) ? "title-too-short" : "bad-date";
    return { kind, line, file };
  }

  const date = body.slice(0, firstBreak).trim();
  if (!DATE_PATTERN.test(date)) return { kind: "bad-date", line, file };

  const rest = body.slice(firstBreak + SEPARATOR.length).trim();
  if (rest.startsWith(NO_LESSON_MARKER)) {
    const afterMarker = rest.slice(NO_LESSON_MARKER.length).trim();
    const reason = afterMarker.startsWith(SEPARATOR)
      ? afterMarker.slice(SEPARATOR.length).trim()
      : afterMarker;
    if (reason.length < MIN_NO_LESSON_REASON_LENGTH) {
      return { kind: "no-lesson-reason-missing", line, file };
    }
    return { date, isNoLesson: true, text: reason };
  }

  if (rest.length < MIN_TITLE_LENGTH) return { kind: "title-too-short", line, file };
  return { date, isNoLesson: false, text: rest };
}

function isProblem(value: ParsedLessonEntry | EntryProblem): value is EntryProblem {
  return "kind" in value;
}

export function evaluateLessonsGuard(input: LessonsGuardInput): LessonsGuardVerdict {
  const changedCodePaths = input.changedPaths.filter((path) => classifyChangedPath(path) === "code");

  const parsed = input.addedEntryHeadings
    .filter((heading) => isLessonsVolume(heading.file))
    .map(parseLessonEntryHeading);

  const entries = parsed.filter((value): value is ParsedLessonEntry => !isProblem(value));
  const problems = parsed.filter(isProblem);

  // 写坏的条目要报出来，哪怕这次并没有欠教训——否则一条格式不对的记录会一直躺在那里，
  // 直到下一次真正欠教训的改动才被发现，而那时它已经不属于任何人了。
  if (problems.length > 0) return { status: "malformed-entry", problems };
  if (changedCodePaths.length === 0) return { status: "ok", reason: "no-code-change", entries };
  if (entries.length === 0) return { status: "missing-entry", changedCodePaths };
  return { status: "ok", reason: "entry-recorded", entries };
}

export interface LessonsFileProblem {
  readonly file: string;
  readonly message: string;
}

/** 分卷文件的骨架校验。索引里写了这个骨架，这里保证它不是一句空话。 */
export function validateLessonsVolume(file: string, content: string): readonly LessonsFileProblem[] {
  const problems: LessonsFileProblem[] = [];
  const lines = content.split("\n");
  if (!lines.some((line) => line.startsWith("# "))) {
    problems.push({ file, message: "缺少一级标题（`# 标题`）" });
  }
  if (!lines.some((line) => line.startsWith("**适用范围**："))) {
    problems.push({ file, message: "缺少 `**适用范围**：` 一行，读的人无从判断该不该点开" });
  }
  if (!lines.some((line) => line.trim() === "## 变更日志")) {
    problems.push({ file, message: "缺少 `## 变更日志` 小节" });
  }
  for (const line of lines) {
    if (!line.startsWith(ENTRY_PREFIX)) continue;
    const parsed = parseLessonEntryHeading({ line, file });
    if (isProblem(parsed)) {
      problems.push({ file, message: `条目标题不合格式（${parsed.kind}）：${line.trim()}` });
    }
  }
  return problems;
}

export function describeEntryProblem(problem: EntryProblem): string {
  switch (problem.kind) {
    case "not-an-entry":
      return `${problem.file}: 不是一条变更日志标题：${problem.line.trim()}`;
    case "bad-date":
      return `${problem.file}: 标题要以 \`### YYYY-MM-DD ·\` 开头：${problem.line.trim()}`;
    case "title-too-short":
      return `${problem.file}: 标题太短，说不清这次改了什么：${problem.line.trim()}`;
    case "no-lesson-reason-missing":
      return `${problem.file}: \`${NO_LESSON_MARKER}\` 后面要写清为什么这次没有教训（至少 ${MIN_NO_LESSON_REASON_LENGTH} 个字）：${problem.line.trim()}`;
  }
}
