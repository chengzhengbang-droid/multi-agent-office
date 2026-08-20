import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FileCustomProviderStore,
  customProviderEnvKey,
  findCustomProvider,
  validateCustomProviderCatalog,
} from "../src/config/custom-providers.js";
import { toPiProviderConfig } from "../src/runtime/pi-shared.js";

const vllm = {
  id: "my-vllm",
  label: "自建 vLLM",
  baseUrl: "http://10.0.0.9:8000/v1",
  api: "openai-completions" as const,
  models: [{ id: "qwen3-coder" }],
};

test("a third-party deployment is accepted with only the fields a user knows", () => {
  const catalog = validateCustomProviderCatalog({ version: 1, providers: [vllm] });
  assert.deepEqual(catalog.providers, [vllm]);
  assert.equal(findCustomProvider(catalog, "my-vllm")?.label, "自建 vLLM");
  assert.equal(findCustomProvider(catalog, "absent"), undefined);
  assert.equal(customProviderEnvKey("my-vllm"), "MAO_CUSTOM_MY_VLLM_API_KEY");
});

test("custom provider definitions reject unusable and unsafe input", () => {
  assert.throws(
    () => validateCustomProviderCatalog({ version: 1, providers: [{ ...vllm, id: "My VLLM" }] }),
    /id/,
  );
  assert.throws(
    () => validateCustomProviderCatalog({ version: 1, providers: [{ ...vllm, baseUrl: "ftp://host/v1" }] }),
    /Base URL/,
  );
  assert.throws(
    () => validateCustomProviderCatalog({ version: 1, providers: [{ ...vllm, api: "grpc" }] }),
    /API 类型/,
  );
  assert.throws(
    () => validateCustomProviderCatalog({ version: 1, providers: [{ ...vllm, models: [] }] }),
    /至少要配置一个模型/,
  );
  assert.throws(
    () => validateCustomProviderCatalog({ version: 1, providers: [vllm, { ...vllm, label: "副本" }] }),
    /重复/,
  );
  // Reusing a built-in id would send the key to that provider's variable while
  // the definition reads its own.
  assert.throws(
    () => validateCustomProviderCatalog({ version: 1, providers: [{ ...vllm, id: "deepseek" }] }),
    /内置提供商/,
  );
  // Pi runs a header value that starts with "!" as a shell command; a form in a
  // local web page is never the right place to gain that.
  assert.throws(
    () =>
      validateCustomProviderCatalog({
        version: 1,
        providers: [{ ...vllm, headers: { "x-token": "!cat /etc/passwd" } }],
      }),
    /不允许执行命令/,
  );
});

test("a custom provider becomes a complete Pi provider config without holding its key", () => {
  const config = toPiProviderConfig({
    ...vllm,
    models: [{ id: "qwen3-coder", reasoning: true }],
    compat: { supportsDeveloperRole: false },
  });
  assert.equal(config.baseUrl, "http://10.0.0.9:8000/v1");
  assert.equal(config.apiKey, "$MAO_CUSTOM_MY_VLLM_API_KEY");
  assert.equal(config.api, "openai-completions");
  const model = config.models?.[0];
  assert.equal(model?.id, "qwen3-coder");
  assert.equal(model?.name, "qwen3-coder");
  assert.equal(model?.reasoning, true);
  assert.equal(model?.contextWindow, 128_000);
  assert.deepEqual(model?.compat, { supportsDeveloperRole: false });
  assert.deepEqual(model?.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("the provider store round-trips atomically and starts empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-custom-providers-"));
  const path = join(directory, "custom-providers.json");
  try {
    const store = new FileCustomProviderStore(path);
    assert.deepEqual(await store.load(), { version: 1, providers: [] });
    await store.replace({ version: 1, providers: [vllm] });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 1, providers: [vllm] });
    assert.deepEqual((await new FileCustomProviderStore(path).load()).providers, [vllm]);
    await assert.rejects(store.replace({ version: 1, providers: [{ ...vllm, baseUrl: "" }] }), /Base URL/);
    // A rejected write leaves the stored definition in place.
    assert.deepEqual((await new FileCustomProviderStore(path).load()).providers, [vllm]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
