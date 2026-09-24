import fs from "node:fs";
import path from "node:path";

const AUDIT_PATH = process.env.TETOS_AUTOMATE_AUDIT_PATH ?? "./data/automate-audit.ndjson";

export function auditAutomateEnqueue(entry) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...entry,
  });
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.appendFileSync(AUDIT_PATH, `${line}\n`, "utf8");
}
