import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function readJson(path, fallback) {
  if (!existsSync(path)) {
    return fallback;
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data, null, 2));
}
