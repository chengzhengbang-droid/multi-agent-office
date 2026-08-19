/**
 * Visual identity derived from an Agent handle.
 *
 * The avatar used to key a CSS class off the raw handle, and no such class was
 * ever defined, so every Agent rendered in the same colour with a single-letter
 * initial. That is already thin with one Pi and one Codex Agent; a roster that
 * runs several Pi Agents — one per model provider — collapses into identical
 * tiles whenever the handles share a first letter. Tone and initials are
 * computed from the handle instead, so distinct handles look distinct.
 */

/** Number of avatar tones defined in `styles.css` as `.agent-avatar--tone-N`. */
export const AGENT_AVATAR_TONES = 8;

/**
 * FNV-1a over the handle. A hash keeps the tone stable across reloads and
 * machines, which roster order or a running index would not.
 */
export function agentAvatarTone(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < agentId.length; index += 1) {
    hash ^= agentId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % AGENT_AVATAR_TONES;
}

/**
 * Two characters, so `pi-deepseek` and `pi-glm` differ in the avatar itself
 * rather than only in the label beside it. Segmented handles contribute one
 * character per segment; a single word contributes its first two.
 */
export function agentInitials(agentId: string): string {
  const segments = agentId.split(/[-_\s]+/).filter(Boolean);
  const initials =
    segments.length > 1
      ? `${segments[0]?.[0] ?? ""}${segments[1]?.[0] ?? ""}`
      : (segments[0] ?? "").slice(0, 2);
  return initials.toLocaleUpperCase() || "?";
}
