import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  emptyCustomProviderCatalog,
  validateCustomProviderCatalog,
  type CustomProviderCatalogV1,
} from "./custom-providers.js";

export class FileCustomProviderStore {
  private cached: CustomProviderCatalogV1 | undefined;
  private writeQueue = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async load(): Promise<CustomProviderCatalogV1> {
    if (this.cached) return structuredClone(this.cached);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (error) {
      if (!isMissing(error)) throw error;
      this.cached = emptyCustomProviderCatalog();
      return structuredClone(this.cached);
    }
    const catalog = validateCustomProviderCatalog(parsed);
    this.cached = catalog;
    return structuredClone(catalog);
  }

  public async replace(input: unknown): Promise<CustomProviderCatalogV1> {
    const catalog = validateCustomProviderCatalog(input);
    const write = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${globalThis.crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
      await rename(temporary, this.filePath);
    });
    this.writeQueue = write.catch(() => undefined);
    await write;
    this.cached = catalog;
    return structuredClone(catalog);
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
