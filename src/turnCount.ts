import { readFileSync, statSync } from "node:fs";

type CachedCount = { size: number; mtimeMs: number; count: number };
const cache = new Map<string, CachedCount>();

export function readTurnCount(path: string): number | null {
  if (!path) return null;
  try {
    const stat = statSync(path);
    const cached = cache.get(path);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.count;
    const ids = new Set<string>();
    for (const line of readFileSync(path, "utf8").split("\n")) {
      try {
        const record = JSON.parse(line) as { type?: unknown; message?: { id?: unknown; model?: unknown } };
        if (record.type !== "assistant") continue;
        const message = record.message;
        if (typeof message?.id !== "string" || message.id === "" || message.model === "<synthetic>") continue;
        ids.add(message.id);
      } catch {}
    }
    cache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, count: ids.size });
    return ids.size;
  } catch {
    return null;
  }
}
