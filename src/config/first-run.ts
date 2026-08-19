import { randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  API_PROVIDER_PRESETS,
  findApiProvider,
  type ApiProviderId,
} from "./provider-presets.js";

export interface FirstRunInput {
  provider: ApiProviderId;
  apiKey: string;
  useCodex: boolean;
}

export interface ProviderCredentialInput {
  provider: ApiProviderId;
  apiKey: string;
}

export function parseFirstRunInput(value: Record<string, unknown>): FirstRunInput {
  const credential = parseProviderCredentialInput(value);
  if (typeof value.useCodex !== "boolean") throw new Error("请选择是否启用 Codex");
  return { ...credential, useCodex: value.useCodex };
}

/**
 * A key for one provider, with no say over which provider the roster uses.
 * Adding a second Pi Agent on another provider needs its credential without
 * repointing the Agents that already work.
 */
export function parseProviderCredentialInput(
  value: Record<string, unknown>,
): ProviderCredentialInput {
  const providerId = typeof value.provider === "string" ? value.provider : "";
  const provider = findApiProvider(providerId);
  if (!provider) throw new Error("请选择受支持的 API 提供商");
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  if (apiKey.length < 8 || apiKey.length > 8_000) {
    throw new Error("请输入有效的 API Key");
  }
  if (/[\r\n\0]/.test(apiKey)) throw new Error("API Key 格式无效");
  return { provider: provider.id, apiKey };
}

export function isFirstRunSetupRequired(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (environment.MAO_SETUP_COMPLETED === "1") return false;
  if (environment.MAO_SETUP_COMPLETED === "0") return true;
  return !API_PROVIDER_PRESETS.some((provider) => Boolean(environment[provider.envKey]?.trim()));
}

export function applyProviderCredential(
  input: ProviderCredentialInput,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const provider = findApiProvider(input.provider);
  if (!provider) throw new Error("Unsupported API provider");
  environment[provider.envKey] = input.apiKey;
}

/**
 * Writes one provider key into the config file, leaving every other key and the
 * `MAO_PI_*` defaults untouched, so a workspace can hold credentials for several
 * providers at once.
 */
export async function saveProviderCredential(
  path: string,
  input: ProviderCredentialInput,
): Promise<void> {
  const provider = findApiProvider(input.provider);
  if (!provider) throw new Error("Unsupported API provider");
  await writeEnvValues(path, { [provider.envKey]: input.apiKey });
}

export function applyFirstRunEnvironment(
  input: FirstRunInput,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const provider = findApiProvider(input.provider);
  if (!provider) throw new Error("Unsupported API provider");
  environment[provider.envKey] = input.apiKey;
  environment.MAO_PI_PROVIDER = provider.id;
  environment.MAO_PI_MODEL = provider.model;
  environment.MAO_PI_THINKING = "medium";
  environment.MAO_DEFAULT_AGENT = "pi";
}

export async function saveFirstRunConfig(
  path: string,
  input: FirstRunInput,
  completed: boolean,
): Promise<void> {
  const provider = findApiProvider(input.provider);
  if (!provider) throw new Error("Unsupported API provider");
  await writeEnvValues(path, {
    [provider.envKey]: input.apiKey,
    MAO_PI_PROVIDER: provider.id,
    MAO_PI_MODEL: provider.model,
    MAO_PI_THINKING: "medium",
    MAO_DEFAULT_AGENT: "pi",
    MAO_SETUP_COMPLETED: completed ? "1" : "0",
  });
}

async function writeEnvValues(
  path: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const next = updateEnvText(current, values);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, next, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export function updateEnvText(
  source: string,
  values: Readonly<Record<string, string>>,
): string {
  const remaining = new Map(Object.entries(values));
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const next = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !remaining.has(key)) return line;
    const value = remaining.get(key) ?? "";
    remaining.delete(key);
    return `${key}=${serializeEnvValue(value)}`;
  });
  while (next.length > 0 && next.at(-1) === "") next.pop();
  if (remaining.size > 0 && next.length > 0) next.push("");
  for (const [key, value] of remaining) next.push(`${key}=${serializeEnvValue(value)}`);
  return `${next.join("\n")}\n`;
}

function serializeEnvValue(value: string): string {
  return JSON.stringify(value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
