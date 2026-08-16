import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonlEventStore } from "../src/core/event-store.js";
import type { StoredPlatformEvent } from "../src/core/types.js";

test("JSONL EventStore serializes concurrent appends into valid ordered lines", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-events-"));
  try {
    const store = new JsonlEventStore(join(directory, "events.jsonl"));
    const events = Array.from({ length: 100 }, (_, index) => ({
      type: "thread.created" as const,
      thread: { id: `thread-${index}`, title: `${index}`, createdAt: "2026-01-01T00:00:00.000Z" },
      eventId: `event-${index}`,
      recordedAt: "2026-01-01T00:00:00.000Z",
    } satisfies StoredPlatformEvent));
    await Promise.all(events.map((event) => store.append(event)));
    const replayed = await store.readAll();
    assert.equal(replayed.length, events.length);
    assert.deepEqual(replayed.map((event) => event.eventId), events.map((event) => event.eventId));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
