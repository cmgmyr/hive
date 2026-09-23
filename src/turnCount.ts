import { readFileSync } from "node:fs";

export function readTurnCount(path: string): number | null {
  if (!path) return null;
  try {
    const ids = new Set<string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"type":"assistant"')) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; message?: { id?: unknown; model?: unknown } };
        if (record.type !== "assistant") continue;
        const message = record.message;
        if (typeof message?.id !== "string" || message.id === "" || message.model === "<synthetic>") continue;
        ids.add(message.id);
      } catch {}
    }
    return ids.size;
  } catch {
    return null;
  }
}
