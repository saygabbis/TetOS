import { MindLogger } from "../src/core/consciousness/MindLogger.js";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { assert, ok } from "./test-helpers.js";

const path = "./data/test-mind-log.ndjson";
if (existsSync(path)) unlinkSync(path);
const logger = new MindLogger(path, { enabled: true });
logger.append({ turnId: "t1", input: { message: "oi" }, brain: { emotion: { mood: "neutral" } } });
assert(existsSync(path), "mind log file created");
const line = readFileSync(path, "utf8").trim();
assert(line.includes("turnId"), "valid ndjson entry");
ok("test-mind-logger");
