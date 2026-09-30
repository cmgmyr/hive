import { createHash } from "node:crypto";

export const FIRST_MESSAGE_SHA_ENV = "HIVE_LEAD_FIRST_MESSAGE_SHA";

export function firstMessageDigest(message: string): string {
  return createHash("sha256").update(message.trim()).digest("hex");
}
