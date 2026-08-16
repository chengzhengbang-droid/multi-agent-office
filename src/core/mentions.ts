import type { AgentDefinition, Id } from "./types.js";

export interface MentionParseResult {
  targets: Id[];
  unknown: string[];
  overflow: boolean;
}

interface Span {
  start: number;
  end: number;
}

const HANDLE_RE = /@([a-zA-Z][a-zA-Z0-9-]*)/g;

export function parseUserMentions(
  content: string,
  agents: AgentDefinition[],
  maxTargets = 2,
): MentionParseResult {
  const excluded = exclusionSpans(content);
  return collectMentions(content, agents, maxTargets, (position) =>
    !inside(position, excluded) && isUserBoundary(content, position),
  );
}

export function parseAgentMentions(
  content: string,
  agents: AgentDefinition[],
  maxTargets = 2,
): MentionParseResult {
  const excluded = exclusionSpans(content);
  const eligiblePositions = new Set<number>();
  const prefixPattern = /^[ \t]*(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))*[*_\u200b\u200c\u200d\ufeff\u2060]*(?=@)/gm;
  for (const match of content.matchAll(prefixPattern)) {
    if (match.index !== undefined) eligiblePositions.add(match.index + match[0].length);
  }

  return collectMentions(
    content,
    agents,
    maxTargets,
    (position) =>
      !inside(position, excluded) &&
      eligiblePositions.has(position),
  );
}

function collectMentions(
  content: string,
  agents: AgentDefinition[],
  maxTargets: number,
  eligible: (position: number) => boolean,
): MentionParseResult {
  const ids = new Map(agents.map((agent) => [agent.id.toLocaleLowerCase(), agent.id]));
  const targets: Id[] = [];
  const unknown: string[] = [];
  for (const match of content.matchAll(HANDLE_RE)) {
    const position = match.index;
    const handle = match[1];
    if (position === undefined || !handle || !eligible(position)) continue;
    const normalized = handle.toLocaleLowerCase();
    const id = ids.get(normalized);
    if (id) {
      if (!targets.includes(id)) targets.push(id);
    } else if (!unknown.includes(normalized)) {
      unknown.push(normalized);
    }
  }
  return {
    targets: targets.slice(0, maxTargets),
    unknown,
    overflow: targets.length > maxTargets,
  };
}

function exclusionSpans(content: string): Span[] {
  const spans: Span[] = [];
  addMatches(spans, content, /```[\s\S]*?(?:```|$)/g);
  addMatches(spans, content, /`[^`\n]*`/g);
  addMatches(spans, content, /https?:\/\/[^\s]+/g);
  addMatches(spans, content, /"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|‘[^’\n]*’/g);
  return spans;
}

function addMatches(spans: Span[], content: string, pattern: RegExp): void {
  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined) continue;
    spans.push({ start: match.index, end: match.index + match[0].length });
  }
}

function inside(position: number, spans: Span[]): boolean {
  return spans.some((span) => position >= span.start && position < span.end);
}

function isUserBoundary(content: string, position: number): boolean {
  const previous = content[position - 1];
  return previous === undefined || !/[\w.+-]/.test(previous);
}
