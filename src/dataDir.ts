import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// Resolved on its own, with no database side effects, so tmux.ts can derive
// session names without opening the store.

export const DEFAULT_DATA_DIR = join(homedir(), ".hive");

// Where hive keeps its store. HIVE_DATA_DIR points tests and scratch
// instances at a private one.
export const dataDir = process.env.HIVE_DATA_DIR
  ? resolve(process.env.HIVE_DATA_DIR)
  : DEFAULT_DATA_DIR;

// Project ids are SQLite row ids, unique only within one store: project 1 in
// a scratch store is a different project from project 1 in ~/.hive. tmux
// session names are built from those ids and share one machine-wide
// namespace, so an isolated store would otherwise resolve to -- and act on --
// the live session of whatever real project happens to be id 1. Tagging the
// name with the store keeps the default case readable (hive-1) and puts every
// other store somewhere it cannot collide.
export const dataDirTag =
  dataDir === DEFAULT_DATA_DIR
    ? ""
    : `${createHash("sha256").update(dataDir).digest("hex").slice(0, 8)}-`;
