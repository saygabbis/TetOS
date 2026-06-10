import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";

const NDJSON_READ_CHUNK_BYTES = 256 * 1024;

export function readNdjsonStream(path, { lineFilter = null } = {}) {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(NDJSON_READ_CHUNK_BYTES);
  let leftover = "";
  const results = [];
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      leftover += buffer.toString("utf8", 0, bytesRead);
      let newlineAt = leftover.indexOf("\n");
      while (newlineAt >= 0) {
        const line = leftover.slice(0, newlineAt).trim();
        leftover = leftover.slice(newlineAt + 1);
        if (line && (!lineFilter || lineFilter(line))) {
          try {
            results.push(JSON.parse(line));
          } catch {
            // linha invalida ignorada
          }
        }
        newlineAt = leftover.indexOf("\n");
      }
    }
    const trailing = leftover.trim();
    if (trailing && (!lineFilter || lineFilter(trailing))) {
      try {
        results.push(JSON.parse(trailing));
      } catch {
        // linha invalida ignorada
      }
    }
  } finally {
    closeSync(fd);
  }
  return results;
}

export function readNdjsonFile(path) {
  return readNdjsonStream(path);
}

export function readNdjsonFileSize(path) {
  if (!existsSync(path)) return 0;
  return statSync(path).size;
}

/** Itera linhas NDJSON sem acumular objetos parseados na memória. */
export function forEachNdjsonLine(path, onLine, { lineFilter = null } = {}) {
  if (!existsSync(path)) return 0;
  const fd = openSync(path, "r");
  const buffer = Buffer.alloc(NDJSON_READ_CHUNK_BYTES);
  let leftover = "";
  let lines = 0;
  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) break;
      leftover += buffer.toString("utf8", 0, bytesRead);
      let newlineAt = leftover.indexOf("\n");
      while (newlineAt >= 0) {
        const line = leftover.slice(0, newlineAt).trim();
        leftover = leftover.slice(newlineAt + 1);
        if (line && (!lineFilter || lineFilter(line))) {
          onLine(line);
          lines += 1;
        }
        newlineAt = leftover.indexOf("\n");
      }
    }
    const trailing = leftover.trim();
    if (trailing && (!lineFilter || lineFilter(trailing))) {
      onLine(trailing);
      lines += 1;
    }
  } finally {
    closeSync(fd);
  }
  return lines;
}

export const NDJSON_TS_DAY_RE = /"ts"\s*:\s*"(\d{4}-\d{2}-\d{2})/;

export function extractNdjsonDay(line) {
  const match = String(line).match(NDJSON_TS_DAY_RE);
  return match?.[1] ?? null;
}
