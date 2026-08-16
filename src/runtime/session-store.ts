import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface RuntimeSessionBinding {
  threadId: string;
  agentId: string;
  runtimeKind: "pi" | "codex";
  fingerprint: string;
  locator: string;
  updatedAt: string;
}

interface SessionBindingDocument {
  version: 1;
  bindings: RuntimeSessionBinding[];
}

export interface RuntimeSessionStore {
  get(threadId: string, agentId: string): Promise<RuntimeSessionBinding | undefined>;
  set(binding: RuntimeSessionBinding): Promise<void>;
}

export class FileRuntimeSessionStore implements RuntimeSessionStore {
  private document: SessionBindingDocument | undefined;
  private operationQueue = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async get(
    threadId: string,
    agentId: string,
  ): Promise<RuntimeSessionBinding | undefined> {
    const document = await this.load();
    const binding = document.bindings.find(
      (item) => item.threadId === threadId && item.agentId === agentId,
    );
    return binding ? structuredClone(binding) : undefined;
  }

  public async set(binding: RuntimeSessionBinding): Promise<void> {
    const operation = this.operationQueue.then(async () => {
      const document = await this.load();
      const next = document.bindings.filter(
        (item) =>
          item.threadId !== binding.threadId || item.agentId !== binding.agentId,
      );
      next.push(structuredClone(binding));
      const updated: SessionBindingDocument = { version: 1, bindings: next };
      await this.persist(updated);
      this.document = updated;
    });
    this.operationQueue = operation.catch(() => undefined);
    await operation;
  }

  private async load(): Promise<SessionBindingDocument> {
    if (this.document) return this.document;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as Partial<SessionBindingDocument>;
      if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) {
        throw new Error("Unsupported runtime session binding document");
      }
      this.document = { version: 1, bindings: parsed.bindings.map(validateBinding) };
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.document = { version: 1, bindings: [] };
    }
    return this.document;
  }

  private async persist(document: SessionBindingDocument): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}

export class InMemoryRuntimeSessionStore implements RuntimeSessionStore {
  private readonly bindings = new Map<string, RuntimeSessionBinding>();

  public async get(
    threadId: string,
    agentId: string,
  ): Promise<RuntimeSessionBinding | undefined> {
    const binding = this.bindings.get(key(threadId, agentId));
    return binding ? structuredClone(binding) : undefined;
  }

  public async set(binding: RuntimeSessionBinding): Promise<void> {
    this.bindings.set(key(binding.threadId, binding.agentId), structuredClone(binding));
  }
}

function validateBinding(value: unknown): RuntimeSessionBinding {
  if (!value || typeof value !== "object") throw new Error("Invalid runtime session binding");
  const candidate = value as Partial<RuntimeSessionBinding>;
  if (
    typeof candidate.threadId !== "string" ||
    typeof candidate.agentId !== "string" ||
    (candidate.runtimeKind !== "pi" && candidate.runtimeKind !== "codex") ||
    typeof candidate.fingerprint !== "string" ||
    typeof candidate.locator !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    throw new Error("Invalid runtime session binding");
  }
  return candidate as RuntimeSessionBinding;
}

function key(threadId: string, agentId: string): string {
  return `${threadId}\u0000${agentId}`;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
