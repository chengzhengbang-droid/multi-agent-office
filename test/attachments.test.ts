import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  parseAttachmentInputs,
  saveAttachments,
} from "../src/core/attachments.js";

const png = Buffer.from("89504e470d0a1a0a", "hex");

test("attachment input parsing accepts only supported image types", () => {
  assert.deepEqual(parseAttachmentInputs(undefined), []);
  assert.deepEqual(
    parseAttachmentInputs([{ mediaType: "image/PNG", dataBase64: "AAAA" }]),
    [{ mediaType: "image/png", dataBase64: "AAAA" }],
  );
  assert.throws(
    () => parseAttachmentInputs([{ mediaType: "application/pdf", dataBase64: "AAAA" }]),
    /不支持的图片类型/,
  );
  assert.throws(() => parseAttachmentInputs([{ mediaType: "image/png", dataBase64: "" }]), /内容为空/);
  assert.throws(() => parseAttachmentInputs("nope"), /必须是数组/);
  assert.throws(
    () =>
      parseAttachmentInputs(
        Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => ({
          mediaType: "image/png",
          dataBase64: "AAAA",
        })),
      ),
    /最多附带/,
  );
});

test("attachments are written under the data directory with owner-only access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-attachment-store-"));
  try {
    const saved = await saveAttachments(directory, [
      // Browsers send a data: URL; the prefix must not end up in the bytes.
      { mediaType: "image/png", dataBase64: `data:image/png;base64,${png.toString("base64")}` },
    ]);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.mediaType, "image/png");
    assert.equal(saved[0]?.byteSize, png.length);
    assert.ok(saved[0]?.path.endsWith(".png"));
    assert.deepEqual(await readFile(saved[0]!.path), png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("undecodable attachment content is rejected rather than stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mao-attachment-store-"));
  try {
    await assert.rejects(
      saveAttachments(directory, [{ mediaType: "image/png", dataBase64: "!!!!" }]),
      /无法解码/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
