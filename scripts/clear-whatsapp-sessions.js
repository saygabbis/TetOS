import "dotenv/config";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const targets = [
  process.env.WHATSAPP_SESSION_PATH ?? "./data/session",
  process.env.WHATSAPP_MEDIA_SESSION_PATH ?? "./data/session-media"
];

for (const target of targets) {
  const abs = path.resolve(target);
  if (!existsSync(abs)) {
    console.log(`[skip] ${abs} (nao existe)`);
    continue;
  }
  rmSync(abs, { recursive: true, force: true });
  console.log(`[ok] removido ${abs}`);
}

console.log("\nSessoes limpas. Rode npm run start:wa e escaneie os QRs na ordem correta.");
