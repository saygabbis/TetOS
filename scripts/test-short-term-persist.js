import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShortTermMemory } from "../src/core/memory/shortTerm.js";
import { assert, ok } from "./test-helpers.js";

const dir = mkdtempSync(join(tmpdir(), "tetos-st-"));
const sessionId = "wa-dm:157947506229421@lid";

try {
  const mem = new ShortTermMemory(24, { persistPath: dir });
  mem.add({ role: "user", content: "to com fome amiga" }, sessionId);
  mem.add({ role: "assistant", content: "pedindo pizza no teu lugar" }, sessionId);

  const reloaded = new ShortTermMemory(24, { persistPath: dir });
  const rows = reloaded.getAll(sessionId);

  assert(rows.length === 2, "history survives reload");
  assert(rows[0].content.includes("fome"), "first turn persisted");
  assert(rows[1].role === "assistant", "assistant turn persisted");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

ok("test-short-term-persist");
