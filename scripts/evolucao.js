#!/usr/bin/env node
// Fala com a mente da Teto que está no ar, pelo servidor (equivale ao .mente da dona no zap).
// Uso: node scripts/evolucao.js <comando> [args]   ex.: status · pedidos · testar · aplicar · desfazer <id> · autorizar <id>
// O pedido vai pra data/evolution/inbox/ e a Teto responde em até ~1 min (o ciclo da mente roda a cada minuto).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const command = process.argv.slice(2).join(" ").trim() || "status";
const dir = join(resolve(process.env.TETOS_EVOLUTION_PATH ?? "./data/evolution"), "inbox");
const waitMs = Number(process.env.TETOS_EVOLUCAO_WAIT_MS ?? 180_000);
mkdirSync(dir, { recursive: true });
const id = `cli-${Date.now().toString(36)}`;
writeFileSync(join(dir, `${id}.json`), JSON.stringify({ command, at: new Date().toISOString() }));
console.log(`pedido "${command}" entregue (${id}) — esperando a Teto responder…`);

const done = join(dir, `${id}.done.json`);
const started = Date.now();
const timer = setInterval(() => {
  if (existsSync(done)) {
    clearInterval(timer);
    const { text } = JSON.parse(readFileSync(done, "utf8"));
    rmSync(done, { force: true });
    console.log(`\n${text}`);
    process.exit(0);
  }
  if (Date.now() - started > waitMs) {
    clearInterval(timer);
    console.log("ela não respondeu a tempo (está no ar? o pedido continua na fila e ela pega quando puder)");
    process.exit(2);
  }
}, 1000);
