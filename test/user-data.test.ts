import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APP_NAME,
  LEGACY_APP_NAME,
  migrateLegacyUserData,
  selectUserDataDirectory,
} from "../src/desktop/user-data.js";

test("user data uses the product name unless an explicit override is supplied", () => {
  assert.deepEqual(selectUserDataDirectory("/app-data", []), {
    path: join("/app-data", APP_NAME),
    overridden: false,
  });
  assert.deepEqual(
    selectUserDataDirectory("/app-data", ["--user-data-dir=smoke"], "/work"),
    {
      path: join("/work", "smoke"),
      overridden: true,
    },
  );
});

test("legacy application data migrates without deleting the old directory", async () => {
  const appDataRoot = await mkdtemp(join(tmpdir(), "mao-app-data-"));
  const legacyRoot = join(appDataRoot, LEGACY_APP_NAME);
  const userDataRoot = join(appDataRoot, APP_NAME);
  try {
    await mkdir(join(legacyRoot, "data"), { recursive: true });
    await writeFile(join(legacyRoot, "config.env"), "MAO_SETUP_COMPLETED=1\n");
    await writeFile(join(legacyRoot, "desktop.log"), "legacy log\n");
    await writeFile(join(legacyRoot, "data", "events.jsonl"), "legacy event\n");

    assert.deepEqual(
      (await migrateLegacyUserData(appDataRoot, userDataRoot)).sort(),
      ["config.env", "data", "desktop.log"],
    );
    assert.equal(
      await readFile(join(userDataRoot, "config.env"), "utf8"),
      "MAO_SETUP_COMPLETED=1\n",
    );
    assert.equal(
      await readFile(join(userDataRoot, "data", "events.jsonl"), "utf8"),
      "legacy event\n",
    );
    assert.equal(await readFile(join(legacyRoot, "desktop.log"), "utf8"), "legacy log\n");
  } finally {
    await rm(appDataRoot, { recursive: true, force: true });
  }
});

test("legacy migration never overwrites current application data", async () => {
  const appDataRoot = await mkdtemp(join(tmpdir(), "mao-app-data-"));
  const legacyRoot = join(appDataRoot, LEGACY_APP_NAME);
  const userDataRoot = join(appDataRoot, APP_NAME);
  try {
    await mkdir(join(legacyRoot, "data"), { recursive: true });
    await mkdir(join(userDataRoot, "data"), { recursive: true });
    await writeFile(join(legacyRoot, "config.env"), "legacy\n");
    await writeFile(join(legacyRoot, "desktop.log"), "legacy\n");
    await writeFile(join(legacyRoot, "data", "events.jsonl"), "legacy\n");
    await writeFile(join(userDataRoot, "config.env"), "current\n");
    await writeFile(join(userDataRoot, "desktop.log"), "current\n");
    await writeFile(join(userDataRoot, "data", "events.jsonl"), "current\n");

    assert.deepEqual(await migrateLegacyUserData(appDataRoot, userDataRoot), []);
    assert.equal(await readFile(join(userDataRoot, "config.env"), "utf8"), "current\n");
    assert.equal(
      await readFile(join(userDataRoot, "data", "events.jsonl"), "utf8"),
      "current\n",
    );
  } finally {
    await rm(appDataRoot, { recursive: true, force: true });
  }
});
