import { closeSync, openSync, readSync } from "node:fs";

/** Lê só o início do ficheiro — evita carregar MP4/JPEG inteiro na memória. */
export function readFileHead(filePath, maxBytes = 65536) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.alloc(Math.max(16, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
