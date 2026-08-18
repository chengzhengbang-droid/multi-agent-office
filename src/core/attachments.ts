import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createId } from "./ids.js";
import type { MessageAttachment } from "./types.js";

/**
 * Image types every supported provider accepts. Anything else is rejected
 * rather than stored, so the workspace never holds a file no Agent can read.
 */
const ALLOWED_MEDIA_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export interface AttachmentInput {
  mediaType: string;
  /** Base64-encoded bytes, with or without a data: URL prefix. */
  dataBase64: string;
}

export function parseAttachmentInputs(value: unknown): AttachmentInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("attachments 必须是数组");
  if (value.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    throw new Error(`一条消息最多附带 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("附件格式不正确");
    }
    const record = entry as Record<string, unknown>;
    const mediaType = typeof record.mediaType === "string" ? record.mediaType.toLowerCase() : "";
    const dataBase64 = typeof record.dataBase64 === "string" ? record.dataBase64 : "";
    if (!ALLOWED_MEDIA_TYPES[mediaType]) {
      throw new Error(`不支持的图片类型：${mediaType || "未知"}`);
    }
    if (!dataBase64) throw new Error("附件内容为空");
    return { mediaType, dataBase64 };
  });
}

/**
 * Writes attachments under the data directory and returns the references stored
 * on the message. Bytes stay out of the event log, which is replayed in full on
 * every start.
 */
export async function saveAttachments(
  dataRoot: string,
  inputs: AttachmentInput[],
): Promise<MessageAttachment[]> {
  if (inputs.length === 0) return [];
  const directory = resolve(dataRoot, "attachments");
  await mkdir(directory, { recursive: true });
  const saved: MessageAttachment[] = [];
  for (const input of inputs) {
    const extension = ALLOWED_MEDIA_TYPES[input.mediaType];
    if (!extension) throw new Error(`不支持的图片类型：${input.mediaType}`);
    const bytes = Buffer.from(stripDataUrlPrefix(input.dataBase64), "base64");
    if (bytes.length === 0) throw new Error("附件内容无法解码");
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `单张图片不能超过 ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB`,
      );
    }
    const id = createId("att");
    const path = resolve(directory, `${id}.${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    saved.push({ id, mediaType: input.mediaType, path, byteSize: bytes.length });
  }
  return saved;
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.startsWith("data:") ? value.indexOf(",") : -1;
  return comma >= 0 ? value.slice(comma + 1) : value;
}
