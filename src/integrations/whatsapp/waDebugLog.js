import { appendFileSync } from "node:fs";
import { join } from "node:path";

export function waAgentDebugLog(payload) {
  const entry = { sessionId: "3eccec", timestamp: Date.now(), ...payload };
  // #region agent log
  try {
    appendFileSync(join(process.cwd(), "debug-3eccec.log"), `${JSON.stringify(entry)}\n`);
  } catch {}
  fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "3eccec" },
    body: JSON.stringify(entry)
  }).catch(() => {});
  // #endregion
}
