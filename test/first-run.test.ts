import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  applyFirstRunEnvironment,
  applyProviderCredential,
  isFirstRunSetupRequired,
  parseFirstRunInput,
  parseProviderCredentialInput,
  saveFirstRunConfig,
  saveProviderCredential,
  updateEnvText,
} from "../src/config/first-run.js";
import { customProviderEnvKey } from "../src/config/custom-providers.js";

test("first-run status respects the completion marker and existing users", () => {
  assert.equal(isFirstRunSetupRequired({ MAO_SETUP_COMPLETED: "0" }), true);
  assert.equal(isFirstRunSetupRequired({ MAO_SETUP_COMPLETED: "1" }), false);
  assert.equal(isFirstRunSetupRequired({ ZAI_CODING_CN_API_KEY: "existing-key" }), false);
  assert.equal(isFirstRunSetupRequired({ DEEPSEEK_API_KEY: "existing-key" }), false);
  assert.equal(isFirstRunSetupRequired({}), true);
});

test("first-run input accepts a supported provider and rejects unsafe keys", () => {
  assert.deepEqual(
    parseFirstRunInput({ provider: "openai", apiKey: "  sk-example-key  ", useCodex: false }),
    { provider: "openai", apiKey: "sk-example-key", useCodex: false },
  );
  assert.throws(
    () => parseFirstRunInput({ provider: "unknown", apiKey: "long-enough", useCodex: false }),
    /API 提供商/,
  );
  assert.throws(
    () => parseFirstRunInput({ provider: "openai", apiKey: "unsafe\nvalue", useCodex: false }),
    /格式无效/,
  );
  assert.deepEqual(
    parseFirstRunInput({ provider: "deepseek", apiKey: "sk-deepseek-example", useCodex: false }),
    { provider: "deepseek", apiKey: "sk-deepseek-example", useCodex: false },
  );
});

test("environment updates select the API runtime without enabling setup early", () => {
  const environment: NodeJS.ProcessEnv = {};
  applyFirstRunEnvironment(
    { provider: "anthropic", apiKey: "sk-ant-example", useCodex: false },
    environment,
  );
  assert.equal(environment.ANTHROPIC_API_KEY, "sk-ant-example");
  assert.equal(environment.MAO_PI_PROVIDER, "anthropic");
  assert.equal(environment.MAO_PI_MODEL, "claude-sonnet-5");
  assert.equal(environment.MAO_DEFAULT_AGENT, "pi");
  assert.equal(environment.MAO_SETUP_COMPLETED, undefined);
});

test("DeepSeek setup selects the official Flash model and credential", () => {
  const environment: NodeJS.ProcessEnv = {};
  applyFirstRunEnvironment(
    { provider: "deepseek", apiKey: "sk-deepseek-example", useCodex: false },
    environment,
  );
  assert.equal(environment.DEEPSEEK_API_KEY, "sk-deepseek-example");
  assert.equal(environment.MAO_PI_PROVIDER, "deepseek");
  assert.equal(environment.MAO_PI_MODEL, "deepseek-v4-flash");
});

test("config updates preserve unrelated settings and quote secret values", () => {
  const next = updateEnvText(
    "# local settings\nMAO_PI_MODEL=old\nCUSTOM_SETTING=keep\n",
    { MAO_PI_MODEL: "gpt-5.5", OPENAI_API_KEY: "sk-special-# value" },
  );
  assert.match(next, /^# local settings/m);
  assert.match(next, /^CUSTOM_SETTING=keep$/m);
  assert.match(next, /^MAO_PI_MODEL="gpt-5\.5"$/m);
  assert.match(next, /^OPENAI_API_KEY="sk-special-# value"$/m);
});

test("first-run config is atomically persisted with a completion marker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-first-run-"));
  const path = join(directory, "config.env");
  try {
    await writeFile(path, "# existing\nCUSTOM_SETTING=keep\n", { mode: 0o600 });
    const input = { provider: "google" as const, apiKey: "gemini-example-key", useCodex: false };
    await saveFirstRunConfig(path, input, false);
    assert.match(await readFile(path, "utf8"), /^MAO_SETUP_COMPLETED="0"$/m);
    await saveFirstRunConfig(path, input, true);
    const saved = await readFile(path, "utf8");
    assert.match(saved, /^GEMINI_API_KEY="gemini-example-key"$/m);
    assert.match(saved, /^MAO_PI_PROVIDER="google"$/m);
    assert.match(saved, /^MAO_SETUP_COMPLETED="1"$/m);
    assert.match(saved, /^CUSTOM_SETTING=keep$/m);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second provider credential is added without disturbing the first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-provider-credential-"));
  const path = join(directory, "config.env");
  try {
    await saveFirstRunConfig(
      path,
      { provider: "zai-coding-cn", apiKey: "zai-example-key", useCodex: false },
      true,
    );
    await saveProviderCredential(path, {
      provider: "deepseek",
      envKey: "DEEPSEEK_API_KEY",
      apiKey: "sk-deepseek-example",
    });
    const saved = await readFile(path, "utf8");
    assert.match(saved, /^ZAI_CODING_CN_API_KEY="zai-example-key"$/m);
    assert.match(saved, /^DEEPSEEK_API_KEY="sk-deepseek-example"$/m);
    // Adding a credential must not repoint the Agents that already work.
    assert.match(saved, /^MAO_PI_PROVIDER="zai-coding-cn"$/m);
    assert.match(saved, /^MAO_SETUP_COMPLETED="1"$/m);
    if (process.platform !== "win32") {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider credential input validates the provider and the key alone", () => {
  assert.deepEqual(
    parseProviderCredentialInput({ provider: "deepseek", apiKey: "  sk-deepseek-example  " }),
    { provider: "deepseek", envKey: "DEEPSEEK_API_KEY", apiKey: "sk-deepseek-example" },
  );
  assert.throws(
    () => parseProviderCredentialInput({ provider: "unknown", apiKey: "long-enough" }),
    /API 提供商/,
  );
  assert.throws(() => parseProviderCredentialInput({ provider: "zai", apiKey: "short" }), /API Key/);
  const environment: NodeJS.ProcessEnv = { MAO_PI_PROVIDER: "zai-coding-cn" };
  applyProviderCredential(
    { provider: "deepseek", envKey: "DEEPSEEK_API_KEY", apiKey: "sk-deepseek-example" },
    environment,
  );
  assert.equal(environment.DEEPSEEK_API_KEY, "sk-deepseek-example");
  assert.equal(environment.MAO_PI_PROVIDER, "zai-coding-cn");
});

test("a third-party deployment stores its key like any built-in provider", () => {
  const resolver = (providerId: string) =>
    providerId === "my-vllm"
      ? { id: "my-vllm", envKey: customProviderEnvKey("my-vllm") }
      : undefined;
  assert.deepEqual(
    parseProviderCredentialInput({ provider: "my-vllm", apiKey: "local-key-example" }, resolver),
    { provider: "my-vllm", envKey: "MAO_CUSTOM_MY_VLLM_API_KEY", apiKey: "local-key-example" },
  );
  // The resolver decides what exists: a preset id is not addressable through a
  // resolver that only knows the workspace's own deployments.
  assert.throws(
    () => parseProviderCredentialInput({ provider: "deepseek", apiKey: "long-enough" }, resolver),
    /API 提供商/,
  );
});
