import { TimeStore } from "../src/core/time/timeStore.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTimeLookupKeys } from "../src/core/time/timeKeys.js";
import { assert, ok } from "./test-helpers.js";

const keys = resolveTimeLookupKeys("dm-157947506229421", "wa-dm:157947506229421@lid");
assert(keys.includes("wa-dm:157947506229421@lid"), "session key");
assert(keys.includes("dm-157947506229421"), "dm key");
assert(keys.includes("157947506229421"), "legacy lid key");

const dir = mkdtempSync(join(tmpdir(), "tetos-time-"));
try {
  const store = new TimeStore(join(dir, "time.json"));
  const past = Date.now() - 120000;
  store.state.lastMessageAt["157947506229421"] = new Date(past).toISOString();
  store.save();

  const found = store.getLastMessage("dm-157947506229421", "wa-dm:157947506229421@lid");
  assert(Boolean(found), "legacy lid timestamp resolves for new dm session");

  store.markMessage("dm-157947506229421", Date.now(), "wa-dm:157947506229421@lid");
  const written = store.getLastMessage("dm-157947506229421", "wa-dm:157947506229421@lid");
  assert(written && Date.parse(written) > past, "writes on session key");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

ok("test-time-keys");
