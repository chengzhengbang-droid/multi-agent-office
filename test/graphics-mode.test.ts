import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  describeGraphicsMode,
  graphicsModeSwitches,
  nextGraphicsMode,
  parseGraphicsMode,
  readGraphicsModeState,
  resolveGraphicsMode,
  writeGraphicsModeState,
} from "../src/desktop/graphics-mode.js";

test("hardware acceleration stays untouched for healthy machines", () => {
  assert.deepEqual(graphicsModeSwitches("hardware"), []);
  assert.deepEqual(
    resolveGraphicsMode({ mode: "hardware", pending: false }),
    { mode: "hardware", overridden: false },
  );
});

test("a launch that never showed a window escalates to the next mode", () => {
  assert.deepEqual(
    resolveGraphicsMode({ mode: "hardware", pending: true }),
    { mode: "software", escalatedFrom: "hardware", overridden: false },
  );
  assert.deepEqual(
    resolveGraphicsMode({ mode: "software", pending: true }),
    { mode: "compatibility", escalatedFrom: "software", overridden: false },
  );
});

test("the most compatible mode never escalates further", () => {
  assert.equal(nextGraphicsMode("compatibility"), undefined);
  assert.deepEqual(
    resolveGraphicsMode({ mode: "compatibility", pending: true }),
    { mode: "compatibility", overridden: false },
  );
});

test("the fallback keeps the GPU process out of the way", () => {
  assert.deepEqual(graphicsModeSwitches("software"), [
    "disable-gpu",
    "disable-gpu-compositing",
    "disable-gpu-sandbox",
    "in-process-gpu",
  ]);
  assert.deepEqual(graphicsModeSwitches("compatibility"), [
    "disable-gpu",
    "disable-gpu-compositing",
    "disable-gpu-sandbox",
    "in-process-gpu",
    "no-sandbox",
  ]);
});

test("an explicit mode wins over the remembered one and disables escalation", () => {
  assert.equal(parseGraphicsMode(["--graphics-mode=software"]), "software");
  assert.equal(parseGraphicsMode(["--graphics-mode", "hardware"]), "hardware");
  assert.equal(parseGraphicsMode(["--safe-graphics"]), "compatibility");
  assert.equal(
    parseGraphicsMode([], { MAO_GRAPHICS_MODE: "compatibility" }),
    "compatibility",
  );
  assert.equal(parseGraphicsMode(["--graphics-mode=turbo"]), undefined);
  assert.equal(parseGraphicsMode([], { MAO_GRAPHICS_MODE: "turbo" }), undefined);
  assert.deepEqual(
    resolveGraphicsMode({ mode: "compatibility", pending: true }, "hardware"),
    { mode: "hardware", overridden: true },
  );
});

test("the remembered mode survives a restart and tolerates a damaged file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-graphics-"));
  const statePath = join(directory, "graphics-mode.json");
  try {
    assert.deepEqual(readGraphicsModeState(statePath), {
      mode: "hardware",
      pending: false,
    });

    assert.equal(
      writeGraphicsModeState(statePath, {
        mode: "software",
        pending: true,
        reason: "GPU process gone (crashed, exit -2147483645)",
      }),
      true,
    );
    assert.deepEqual(readGraphicsModeState(statePath), {
      mode: "software",
      pending: true,
      reason: "GPU process gone (crashed, exit -2147483645)",
    });
    const stored: unknown = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(
      typeof (stored as { updatedAt?: unknown }).updatedAt,
      "string",
    );

    await writeFile(statePath, "{ not json");
    assert.deepEqual(readGraphicsModeState(statePath), {
      mode: "hardware",
      pending: false,
    });

    await writeFile(statePath, JSON.stringify({ mode: "turbo", pending: true }));
    assert.deepEqual(readGraphicsModeState(statePath), {
      mode: "hardware",
      pending: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every mode has a label for the menu", () => {
  assert.equal(describeGraphicsMode("hardware"), "硬件加速");
  assert.notEqual(
    describeGraphicsMode("software"),
    describeGraphicsMode("compatibility"),
  );
});
