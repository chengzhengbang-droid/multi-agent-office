import { readFileSync, writeFileSync } from "node:fs";

/**
 * Chromium's GPU process is unusable on a minority of Windows machines: it dies
 * with an access violation (exit code -2147483645 / 0xC0000005) before the
 * first frame, Electron gives up with "GPU process isn't usable. Goodbye." and
 * the shortcut looks like it does nothing. Command line switches fix those
 * machines, but forcing them on everybody would cost the healthy majority their
 * hardware acceleration.
 *
 * The launcher therefore remembers, per machine, the least invasive graphics
 * mode that actually starts. Every launch is written down as unproven and is
 * confirmed once a window appears; a launch that dies before that - or a GPU
 * process that goes away while running - escalates to the next mode.
 */
export type GraphicsMode = "hardware" | "software" | "compatibility";

export const GRAPHICS_MODE_FILE = "graphics-mode.json";

/** Ordered from least to most invasive; escalation walks it left to right. */
const GRAPHICS_MODES: readonly GraphicsMode[] = [
  "hardware",
  "software",
  "compatibility",
];

// Disabling the GPU alone is not enough: Electron still starts a GPU process,
// which is exactly what crashes. Keeping it in-process and out of the GPU
// sandbox is what makes the affected machines start.
const SOFTWARE_SWITCHES: readonly string[] = [
  "disable-gpu",
  "disable-gpu-compositing",
  "disable-gpu-sandbox",
  "in-process-gpu",
];

export interface GraphicsModeState {
  mode: GraphicsMode;
  /** True while a launch in `mode` has started but not yet shown a window. */
  pending: boolean;
  reason?: string;
  updatedAt?: string;
}

export interface GraphicsModeDecision {
  mode: GraphicsMode;
  /** Set when the previous launch in this mode never reached a window. */
  escalatedFrom?: GraphicsMode;
  /** True when the mode came from the command line or the environment. */
  overridden: boolean;
}

export function isGraphicsMode(value: unknown): value is GraphicsMode {
  return (
    typeof value === "string" &&
    GRAPHICS_MODES.includes(value as GraphicsMode)
  );
}

export function graphicsModeSwitches(mode: GraphicsMode): readonly string[] {
  if (mode === "hardware") return [];
  if (mode === "software") return SOFTWARE_SWITCHES;
  // Security software that injects into Chromium's processes can also break the
  // renderer sandbox, so the last resort drops it too.
  return [...SOFTWARE_SWITCHES, "no-sandbox"];
}

export function nextGraphicsMode(mode: GraphicsMode): GraphicsMode | undefined {
  return GRAPHICS_MODES[GRAPHICS_MODES.indexOf(mode) + 1];
}

export function resolveGraphicsMode(
  stored: GraphicsModeState,
  override?: GraphicsMode,
): GraphicsModeDecision {
  if (override) return { mode: override, overridden: true };
  if (!stored.pending) return { mode: stored.mode, overridden: false };
  const escalated = nextGraphicsMode(stored.mode);
  // The most compatible mode has nothing left to escalate to: keep using it and
  // let the real failure surface instead of restarting forever.
  if (!escalated) return { mode: stored.mode, overridden: false };
  return { mode: escalated, escalatedFrom: stored.mode, overridden: false };
}

export function parseGraphicsMode(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {},
): GraphicsMode | undefined {
  const prefix = "--graphics-mode=";
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--safe-graphics") return "compatibility";
    if (argument?.startsWith(prefix)) {
      const value = argument.slice(prefix.length);
      if (isGraphicsMode(value)) return value;
    }
    if (argument === "--graphics-mode") {
      const value = arguments_[index + 1];
      if (isGraphicsMode(value)) return value;
    }
  }
  const fromEnvironment = environment.MAO_GRAPHICS_MODE;
  return isGraphicsMode(fromEnvironment) ? fromEnvironment : undefined;
}

export function readGraphicsModeState(path: string): GraphicsModeState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return defaultState();
    const record = parsed as Record<string, unknown>;
    if (!isGraphicsMode(record.mode)) return defaultState();
    const reason = typeof record.reason === "string" ? record.reason : undefined;
    return {
      mode: record.mode,
      pending: record.pending === true,
      ...(reason ? { reason } : {}),
    };
  } catch {
    // A missing or damaged marker must never stop the app: the machine simply
    // starts with hardware acceleration and proves itself again.
    return defaultState();
  }
}

export function writeGraphicsModeState(
  path: string,
  state: GraphicsModeState,
  now: Date = new Date(),
): boolean {
  const payload: GraphicsModeState = {
    mode: state.mode,
    pending: state.pending,
    ...(state.reason ? { reason: state.reason } : {}),
    updatedAt: state.updatedAt ?? now.toISOString(),
  };
  try {
    writeFileSync(path, `${JSON.stringify(payload, undefined, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

export function describeGraphicsMode(mode: GraphicsMode): string {
  if (mode === "hardware") return "硬件加速";
  if (mode === "software") return "软件渲染兼容模式";
  return "最大兼容模式";
}

function defaultState(): GraphicsModeState {
  return { mode: "hardware", pending: false };
}
