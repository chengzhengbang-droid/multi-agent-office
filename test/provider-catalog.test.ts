import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  API_PROVIDER_PRESETS,
  FEATURED_API_PROVIDERS,
  findApiProvider,
  providerEnvKeys,
} from "../src/config/provider-presets.js";
import { PiSharedRuntime } from "../src/runtime/pi-shared.js";

/**
 * The preset table is a promise about pi's catalog: pick this provider and the
 * default model resolves, paste a key into that environment variable and pi
 * finds it. Both halves drift silently when pi is upgraded, so they are checked
 * against the catalog that ships with the pinned version.
 */
async function createRuntime(): Promise<ModelRuntime | undefined> {
  try {
    return await ModelRuntime.create();
  } catch {
    return undefined;
  }
}

test("every preset provider and default model exists in pi's catalog", async (context) => {
  const modelRuntime = await createRuntime();
  if (!modelRuntime) {
    context.skip("pi model runtime is unavailable in this environment");
    return;
  }
  const known = new Set(modelRuntime.getProviders().map((provider) => provider.id));
  for (const preset of API_PROVIDER_PRESETS) {
    assert.ok(known.has(preset.id), `pi does not know provider ${preset.id}`);
    const models = modelRuntime.getModels(preset.id).map((model) => model.id);
    assert.ok(
      models.includes(preset.model),
      `${preset.id} has no model ${preset.model}`,
    );
  }
});

test("pi reads the credential from the environment variable each preset names", async (context) => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [provider, keys] of Object.entries(providerEnvKeys())) {
    for (const key of keys) environment[key] = `test-key-for-${provider}`;
  }
  const restore = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    restore.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const modelRuntime = await createRuntime();
    if (!modelRuntime) {
      context.skip("pi model runtime is unavailable in this environment");
      return;
    }
    for (const preset of API_PROVIDER_PRESETS) {
      assert.ok(
        modelRuntime.getProviderAuthStatus(preset.id).configured,
        `${preset.id} ignores ${preset.envKey}`,
      );
    }
  } finally {
    for (const [key, value] of restore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("the featured providers are a non-empty subset offered on the first-run page", () => {
  assert.ok(FEATURED_API_PROVIDERS.length >= 6);
  assert.ok(FEATURED_API_PROVIDERS.length < API_PROVIDER_PRESETS.length);
  for (const provider of FEATURED_API_PROVIDERS) {
    assert.ok(findApiProvider(provider.id), `${provider.id} is not a preset`);
  }
  const ids = new Set(API_PROVIDER_PRESETS.map((provider) => provider.id));
  assert.equal(ids.size, API_PROVIDER_PRESETS.length);
});

test("Moonshot open-platform presets default to Kimi K3 and stay distinct from Kimi Coding", () => {
  for (const id of ["moonshotai-cn", "moonshotai"]) {
    const preset = findApiProvider(id);
    assert.equal(preset?.model, "kimi-k3");
    assert.equal(preset?.envKey, "MOONSHOT_API_KEY");
  }
  const coding = findApiProvider("kimi-coding");
  assert.equal(coding?.model, "kimi-for-coding");
  assert.equal(coding?.envKey, "KIMI_API_KEY");
});

test("a declared third-party deployment is registered on the shared model runtime", async (context) => {
  const shared = new PiSharedRuntime({
    customProviders: {
      load: async () => ({
        version: 1 as const,
        providers: [
          {
            id: "my-gateway",
            label: "公司网关",
            baseUrl: "https://gateway.example.com/v1",
            api: "openai-completions" as const,
            models: [{ id: "house-model" }],
          },
        ],
      }),
    },
  });
  let modelRuntime: ModelRuntime;
  try {
    modelRuntime = await shared.modelRuntime();
  } catch {
    context.skip("pi model runtime is unavailable in this environment");
    return;
  }
  assert.deepEqual(
    modelRuntime.getModels("my-gateway").map((model) => model.id),
    ["house-model"],
  );
  assert.equal(modelRuntime.getProvider("my-gateway")?.name, "公司网关");
  assert.deepEqual(shared.warnings(), []);
  shared.dispose();
});

test("an unreadable provider definition is reported, not fatal", async (context) => {
  // Every Pi Agent shares one model runtime, so a broken definition none of
  // them use must not take the whole roster offline.
  const shared = new PiSharedRuntime({
    customProviders: { load: async () => { throw new Error("配置文件损坏"); } },
  });
  let modelRuntime: ModelRuntime;
  try {
    modelRuntime = await shared.modelRuntime();
  } catch {
    context.skip("pi model runtime is unavailable in this environment");
    return;
  }
  assert.ok(modelRuntime.getProviders().length > 0);
  assert.match(shared.warnings().join(" "), /配置文件损坏/);
  shared.dispose();
  assert.deepEqual(shared.warnings(), []);
});
