import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AccessMode,
  AgentCatalogV1,
  AgentDefinition,
  ThinkingLevel,
} from "../core/types.js";

export class CatalogConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}

export interface DefaultCatalogOptions {
  piProvider: string;
  piModel: string;
  piThinkingLevel: ThinkingLevel;
  codexCommand?: string;
  defaultAgentId?: "codex" | "pi";
}

export class FileAgentCatalogStore {
  private cached: AgentCatalogV1 | undefined;
  private writeQueue = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly defaults: DefaultCatalogOptions,
  ) {}

  public async load(): Promise<AgentCatalogV1> {
    if (this.cached) return structuredClone(this.cached);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      const catalog = createDefaultCatalog(this.defaults);
      await this.persist(catalog);
      this.cached = catalog;
      return structuredClone(catalog);
    }
    const catalog = validateCatalog(parsed);
    this.cached = catalog;
    return structuredClone(catalog);
  }

  public async replace(
    input: AgentCatalogV1,
    expectedRevision: number,
  ): Promise<AgentCatalogV1> {
    const current = await this.load();
    if (current.revision !== expectedRevision) {
      throw new CatalogConflictError(
        `Agent catalog revision changed from ${expectedRevision} to ${current.revision}`,
      );
    }
    const validated = validateCatalog({ ...input, revision: current.revision + 1 });
    await this.persist(validated);
    this.cached = validated;
    return structuredClone(validated);
  }

  private async persist(catalog: AgentCatalogV1): Promise<void> {
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
  }
}

export function createDefaultCatalog(options: DefaultCatalogOptions): AgentCatalogV1 {
  return {
    version: 1,
    revision: 1,
    defaultAgentId: options.defaultAgentId ?? "codex",
    agents: [
      {
        id: "codex",
        displayName: "Codex",
        description: "对等协作者，擅长代码实现、审查、测试和安全验证。",
        systemPrompt: peerPrompt("Codex"),
        capabilities: ["代码实现", "代码审查", "测试", "安全分析"],
        enabled: true,
        accessMode: "workspace-write",
        runtime: {
          kind: "codex",
          command: options.codexCommand ?? "codex",
        },
      },
      {
        id: "pi",
        displayName: "Pi",
        description: "对等协作者，擅长通用分析、规划、实现和跨角色协作。",
        systemPrompt: peerPrompt("Pi"),
        capabilities: ["分析", "规划", "代码实现", "协作转交"],
        enabled: true,
        accessMode: "full",
        runtime: {
          kind: "pi",
          provider: options.piProvider,
          model: options.piModel,
          thinkingLevel: options.piThinkingLevel,
        },
      },
    ],
  };
}

export function validateCatalog(value: unknown): AgentCatalogV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent catalog must be an object");
  }
  const candidate = value as Partial<AgentCatalogV1>;
  if (candidate.version !== 1) throw new Error("Unsupported Agent catalog version");
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? 0) < 1) {
    throw new Error("Agent catalog revision must be a positive integer");
  }
  if (!Array.isArray(candidate.agents) || candidate.agents.length === 0) {
    throw new Error("Agent catalog must contain at least one Agent");
  }
  const agents = candidate.agents.map(validateAgent);
  const ids = new Set<string>();
  for (const agent of agents) {
    const normalized = agent.id.toLocaleLowerCase();
    if (ids.has(normalized)) throw new Error(`Duplicate Agent handle: ${agent.id}`);
    ids.add(normalized);
  }
  if (typeof candidate.defaultAgentId !== "string") {
    throw new Error("Agent catalog must define defaultAgentId");
  }
  const defaultAgent = agents.find((agent) => agent.id === candidate.defaultAgentId);
  if (!defaultAgent?.enabled) throw new Error("Default Agent must exist and be enabled");
  return {
    version: 1,
    revision: candidate.revision as number,
    defaultAgentId: candidate.defaultAgentId,
    agents,
  };
}

export function runtimeFingerprint(agent: AgentDefinition): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        systemPrompt: agent.systemPrompt,
        capabilities: agent.capabilities,
        accessMode: agent.accessMode,
        runtime: agent.runtime,
      }),
    )
    .digest("hex")
    .slice(0, 20);
}

function validateAgent(value: unknown): AgentDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Each Agent must be an object");
  }
  const candidate = value as Partial<AgentDefinition>;
  if (typeof candidate.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(candidate.id)) {
    throw new Error("Agent id must match ^[a-z][a-z0-9-]{0,31}$");
  }
  for (const [field, content] of [
    ["displayName", candidate.displayName],
    ["description", candidate.description],
    ["systemPrompt", candidate.systemPrompt],
  ] as const) {
    if (typeof content !== "string" || !content.trim()) {
      throw new Error(`Agent ${candidate.id} must define ${field}`);
    }
  }
  if (!Array.isArray(candidate.capabilities) || candidate.capabilities.some((item) => typeof item !== "string")) {
    throw new Error(`Agent ${candidate.id} capabilities must be strings`);
  }
  if (typeof candidate.enabled !== "boolean") {
    throw new Error(`Agent ${candidate.id} enabled must be boolean`);
  }
  if (!isAccessMode(candidate.accessMode)) {
    throw new Error(`Agent ${candidate.id} has invalid accessMode`);
  }
  const runtime = validateRuntime(candidate.id, candidate.runtime);
  return {
    id: candidate.id,
    displayName: candidate.displayName as string,
    description: candidate.description as string,
    systemPrompt: candidate.systemPrompt as string,
    capabilities: [...candidate.capabilities],
    enabled: candidate.enabled,
    accessMode: candidate.accessMode,
    runtime,
  };
}

function validateRuntime(agentId: string, value: unknown): AgentDefinition["runtime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Agent ${agentId} runtime must be an object`);
  }
  const runtime = value as Record<string, unknown>;
  if (runtime.kind === "pi") {
    if (
      typeof runtime.provider !== "string" ||
      !runtime.provider ||
      typeof runtime.model !== "string" ||
      !runtime.model ||
      !isThinkingLevel(runtime.thinkingLevel)
    ) {
      throw new Error(`Agent ${agentId} has invalid Pi runtime settings`);
    }
    return {
      kind: "pi",
      provider: runtime.provider,
      model: runtime.model,
      thinkingLevel: runtime.thinkingLevel,
    };
  }
  if (runtime.kind === "codex") {
    if (typeof runtime.command !== "string" || !runtime.command) {
      throw new Error(`Agent ${agentId} must define the Codex command`);
    }
    return {
      kind: "codex",
      command: runtime.command,
      ...(typeof runtime.model === "string" && runtime.model ? { model: runtime.model } : {}),
      ...(typeof runtime.profile === "string" && runtime.profile ? { profile: runtime.profile } : {}),
      ...(isReasoningEffort(runtime.reasoningEffort)
        ? { reasoningEffort: runtime.reasoningEffort }
        : {}),
    };
  }
  throw new Error(`Agent ${agentId} runtime kind must be pi or codex`);
}

function peerPrompt(name: string): string {
  return [
    `You are ${name}, an autonomous peer in a multi-agent team.`,
    "There is no boss agent and no fixed workflow.",
    "Use your own judgment to accept the work, ask the human, or hand it to a better-suited peer.",
    "When another peer should act, use the post_message tool and put their @handle at the start of a line.",
    "Do not manufacture agreement: state concrete disagreements and evidence.",
  ].join(" ");
}

function isAccessMode(value: unknown): value is AccessMode {
  return value === "read-only" || value === "workspace-write" || value === "full";
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(value));
}

function isReasoningEffort(value: unknown): value is "low" | "medium" | "high" | "xhigh" {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
