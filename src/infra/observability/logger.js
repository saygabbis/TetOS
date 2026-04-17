import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export class Logger {
  constructor(path = "./data/logs/tetos.log") {
    this.path = path;
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  log(event, payload = {}) {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload
    });
    appendFileSync(this.path, `${line}\n`);
  }
}
