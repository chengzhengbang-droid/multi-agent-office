import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  CatalogConflictError,
  FileAgentCatalogStore,
  runtimeFingerprint,
  validateCatalog,
} from "../src/config/agent-catalog.js";
import type { AgentCatalogV1 } from "../src/core/types.js";

test("first catalog load atomically seeds equal @codex and @pi peers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-catalog-"));
  try {
    const path = join(directory, "agents.json");
    const store = createStore(path);
    const catalog = await store.load();
    assert.equal(catalog.version, 1);
    assert.equal(catalog.defaultAgentId, "codex");
    assert.deepEqual(catalog.agents.map((agent) => agent.id), ["codex", "pi"]);
    assert.equal(catalog.agents.find((agent) => agent.id === "codex")?.accessMode, "workspace-write");
    assert.equal(catalog.agents.find((agent) => agent.id === "pi")?.accessMode, "full");
    assert.doesNotMatch(catalog.agents.map((agent) => agent.systemPrompt).join("\n"), /architect|reviewer/i);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), catalog);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("catalog validation enforces unique immutable-style handles and enabled default", () => {
  const base = seed();
  assert.throws(
    () => validateCatalog({ ...base, agents: [base.agents[0], base.agents[0]] }),
    /Duplicate Agent handle/,
  );
  assert.throws(
    () => validateCatalog({
      ...base,
      agents: base.agents.map((agent) => agent.id === "codex" ? { ...agent, enabled: false } : agent),
    }),
    /Default Agent must exist and be enabled/,
  );
});

test("catalog replacement uses optimistic revision conflicts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-catalog-"));
  try {
    const store = createStore(join(directory, "agents.json"));
    const catalog = await store.load();
    const saved = await store.replace({ ...catalog, defaultAgentId: "pi" }, catalog.revision);
    assert.equal(saved.revision, catalog.revision + 1);
    await assert.rejects(
      store.replace(catalog, catalog.revision),
      CatalogConflictError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime fingerprint rotates for prompt, model, access, and capabilities", () => {
  const original = seed().agents[0]!;
  const fingerprint = runtimeFingerprint(original);
  for (const changed of [
    { ...original, systemPrompt: `${original.systemPrompt} changed` },
    { ...original, accessMode: "read-only" as const },
    { ...original, capabilities: [...original.capabilities, "new"] },
    { ...original, runtime: { kind: "codex" as const, command: "codex", model: "gpt-new" } },
  ]) {
    assert.notEqual(runtimeFingerprint(changed), fingerprint);
  }
  assert.equal(runtimeFingerprint({ ...original, displayName: "Renamed" }), fingerprint);
});

function createStore(path: string): FileAgentCatalogStore {
  return new FileAgentCatalogStore(path, {
    piProvider: "test-provider",
    piModel: "test-model",
    piThinkingLevel: "medium",
    codexCommand: "codex",
  });
}

function seed(): AgentCatalogV1 {
  return validateCatalog({
    version: 1,
    revision: 1,
    defaultAgentId: "codex",
    agents: [
      {
        id: "codex",
        displayName: "Codex",
        description: "peer",
        systemPrompt: "peer",
        capabilities: ["code"],
        enabled: true,
        accessMode: "workspace-write",
        runtime: { kind: "codex", command: "codex" },
      },
      {
        id: "pi",
        displayName: "Pi",
        description: "peer",
        systemPrompt: "peer",
        capabilities: ["analysis"],
        enabled: true,
        accessMode: "full",
        runtime: { kind: "pi", provider: "test", model: "test", thinkingLevel: "medium" },
      },
    ],
  });
}
