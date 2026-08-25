import { findApiProvider } from "./provider-presets.js";

/**
 * Third-party and self-hosted deployments.
 *
 * Pi only knows the providers it ships with, so a company gateway, a vLLM or
 * Ollama box, or any other OpenAI-compatible endpoint used to mean hand-editing
 * `~/.pi/agent/models.json` outside the app. These definitions are owned by the
 * workbench instead: they are stored next to the roster and registered on pi's
 * `ModelRuntime` at startup, so a custom deployment picks the same provider and
 * model pickers, credential box and availability checks as a built-in provider.
 */
export const CUSTOM_PROVIDER_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export interface CustomProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
}

export interface CustomProviderCompat {
  /** OpenAI-compatible servers that reject the `developer` role need this off. */
  supportsDeveloperRole?: boolean;
  /** Servers that reject `reasoning_effort` need this off. */
  supportsReasoningEffort?: boolean;
}

export interface CustomProvider {
  id: string;
  label: string;
  baseUrl: string;
  api: CustomProviderApi;
  models: CustomProviderModel[];
  headers?: Record<string, string>;
  compat?: CustomProviderCompat;
}

export interface CustomProviderCatalogV1 {
  version: 1;
  providers: CustomProvider[];
}

export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 128_000;
export const DEFAULT_CUSTOM_MAX_TOKENS = 16_384;

const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_PROVIDERS = 32;
const MAX_MODELS = 64;

export function emptyCustomProviderCatalog(): CustomProviderCatalogV1 {
  return { version: 1, providers: [] };
}

/**
 * Environment variable holding a custom provider's API key.
 *
 * Custom providers are registered with `apiKey: "$MAO_CUSTOM_..._API_KEY"`, so
 * their credentials are written to the same config file as every built-in
 * provider's and never end up inside the provider definition itself.
 */
export function customProviderEnvKey(id: string): string {
  return `MAO_CUSTOM_${id.replace(/-/g, "_").toLocaleUpperCase()}_API_KEY`;
}

export function findCustomProvider(
  catalog: CustomProviderCatalogV1,
  id: string,
): CustomProvider | undefined {
  return catalog.providers.find((provider) => provider.id === id);
}

export function validateCustomProviderCatalog(value: unknown): CustomProviderCatalogV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("自定义提供商配置必须是对象");
  }
  const candidate = value as Partial<CustomProviderCatalogV1>;
  if (candidate.version !== 1) throw new Error("不支持的自定义提供商配置版本");
  if (!Array.isArray(candidate.providers)) {
    throw new Error("自定义提供商配置缺少 providers 列表");
  }
  if (candidate.providers.length > MAX_PROVIDERS) {
    throw new Error(`自定义提供商最多 ${MAX_PROVIDERS} 个`);
  }
  const providers = candidate.providers.map(validateCustomProvider);
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`自定义提供商 id 重复：${provider.id}`);
    seen.add(provider.id);
  }
  return { version: 1, providers };
}

function validateCustomProvider(value: unknown): CustomProvider {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("每个自定义提供商必须是对象");
  }
  const candidate = value as Partial<CustomProvider>;
  if (typeof candidate.id !== "string" || !ID_PATTERN.test(candidate.id)) {
    throw new Error("提供商 id 必须匹配 ^[a-z][a-z0-9-]{0,31}$");
  }
  // A built-in provider already owns its id and its credential variable, so a
  // definition reusing it would take a key the endpoint stores somewhere else.
  if (findApiProvider(candidate.id)) {
    throw new Error(`${candidate.id} 是内置提供商，请换一个 id`);
  }
  if (typeof candidate.label !== "string" || !candidate.label.trim()) {
    throw new Error(`提供商 ${candidate.id} 缺少名称`);
  }
  const baseUrl = typeof candidate.baseUrl === "string" ? candidate.baseUrl.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`提供商 ${candidate.id} 的 Base URL 无效`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`提供商 ${candidate.id} 的 Base URL 必须是 http 或 https`);
  }
  if (!isCustomProviderApi(candidate.api)) {
    throw new Error(`提供商 ${candidate.id} 的 API 类型无效`);
  }
  if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
    throw new Error(`提供商 ${candidate.id} 至少要配置一个模型`);
  }
  if (candidate.models.length > MAX_MODELS) {
    throw new Error(`提供商 ${candidate.id} 的模型最多 ${MAX_MODELS} 个`);
  }
  const models = candidate.models.map((model) => validateCustomModel(candidate.id as string, model));
  const modelIds = new Set<string>();
  for (const model of models) {
    if (modelIds.has(model.id)) {
      throw new Error(`提供商 ${candidate.id} 的模型 id 重复：${model.id}`);
    }
    modelIds.add(model.id);
  }
  return {
    id: candidate.id,
    label: candidate.label.trim(),
    baseUrl,
    api: candidate.api,
    models,
    ...(candidate.headers ? { headers: validateHeaders(candidate.id, candidate.headers) } : {}),
    ...(candidate.compat ? { compat: validateCompat(candidate.id, candidate.compat) } : {}),
  };
}

function validateCustomModel(providerId: string, value: unknown): CustomProviderModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`提供商 ${providerId} 的模型必须是对象`);
  }
  const candidate = value as Partial<CustomProviderModel>;
  if (typeof candidate.id !== "string" || !candidate.id.trim() || candidate.id.length > 200) {
    throw new Error(`提供商 ${providerId} 的模型 id 无效`);
  }
  if (candidate.name !== undefined && typeof candidate.name !== "string") {
    throw new Error(`提供商 ${providerId} 的模型名称无效`);
  }
  if (candidate.reasoning !== undefined && typeof candidate.reasoning !== "boolean") {
    throw new Error(`提供商 ${providerId} 的模型 reasoning 必须是布尔值`);
  }
  if (
    candidate.input !== undefined &&
    (!Array.isArray(candidate.input) ||
      candidate.input.some((item) => item !== "text" && item !== "image"))
  ) {
    throw new Error(`提供商 ${providerId} 的模型输入类型无效`);
  }
  return {
    id: candidate.id.trim(),
    ...(candidate.name?.trim() ? { name: candidate.name.trim() } : {}),
    ...(candidate.reasoning !== undefined ? { reasoning: candidate.reasoning } : {}),
    ...(candidate.input ? { input: [...candidate.input] } : {}),
    ...(isPositiveInteger(candidate.contextWindow)
      ? { contextWindow: candidate.contextWindow }
      : {}),
    ...(isPositiveInteger(candidate.maxTokens) ? { maxTokens: candidate.maxTokens } : {}),
  };
}

/**
 * Header values reach pi's config-value resolver, where a leading `!` runs the
 * rest as a shell command. A header typed into a local web form is never worth
 * that, so the syntax is rejected rather than passed through.
 */
function validateHeaders(
  providerId: string,
  value: unknown,
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`提供商 ${providerId} 的请求头必须是对象`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
      throw new Error(`提供商 ${providerId} 的请求头名称无效：${name}`);
    }
    if (typeof headerValue !== "string" || /[\r\n\0]/.test(headerValue)) {
      throw new Error(`提供商 ${providerId} 的请求头 ${name} 取值无效`);
    }
    if (headerValue.startsWith("!")) {
      throw new Error(`提供商 ${providerId} 的请求头 ${name} 不允许执行命令`);
    }
    headers[name] = headerValue;
  }
  return headers;
}

function validateCompat(providerId: string, value: unknown): CustomProviderCompat {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`提供商 ${providerId} 的兼容性设置必须是对象`);
  }
  const candidate = value as Record<string, unknown>;
  const compat: CustomProviderCompat = {};
  for (const field of ["supportsDeveloperRole", "supportsReasoningEffort"] as const) {
    const flag = candidate[field];
    if (flag === undefined) continue;
    if (typeof flag !== "boolean") {
      throw new Error(`提供商 ${providerId} 的 ${field} 必须是布尔值`);
    }
    compat[field] = flag;
  }
  return compat;
}

function isCustomProviderApi(value: unknown): value is CustomProviderApi {
  return CUSTOM_PROVIDER_APIS.includes(value as CustomProviderApi);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
