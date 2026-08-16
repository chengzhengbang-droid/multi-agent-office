import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StoredPlatformEvent } from "./types.js";

export interface EventStore {
  append(event: StoredPlatformEvent): Promise<void>;
  readAll(): Promise<StoredPlatformEvent[]>;
}

export class JsonlEventStore implements EventStore {
  private appendQueue = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async append(event: StoredPlatformEvent): Promise<void> {
    const write = this.appendQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
    this.appendQueue = write.catch(() => undefined);
    await write;
  }

  public async readAll(): Promise<StoredPlatformEvent[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }

    return contents
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoredPlatformEvent);
  }
}

export class InMemoryEventStore implements EventStore {
  private readonly events: StoredPlatformEvent[] = [];

  public async append(event: StoredPlatformEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  public async readAll(): Promise<StoredPlatformEvent[]> {
    return structuredClone(this.events);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
