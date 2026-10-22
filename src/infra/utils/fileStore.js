import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function readJson(path, fallback) {
  // Gravação adiada ainda não foi pro disco → o estado certo é o pendente, não o arquivo velho.
  const pending = pendingWrites.get(path);
  if (pending) return structuredClone(pending.data);
  if (!existsSync(path)) {
    // Cópia: devolver o próprio objeto padrão fazia stores diferentes mutarem a mesma constante.
    return fallback && typeof fallback === "object" ? structuredClone(fallback) : fallback;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    // JSON corrompido não derruba a Teto: guarda o arquivo ruim ao lado e segue com o padrão.
    const aside = `${path}.corrupt-${Date.now()}`;
    try { renameSync(path, aside); } catch {}
    console.warn(`[fileStore] ${path} ilegível (${error?.message ?? error}); movido para ${aside}`);
    return fallback && typeof fallback === "object" ? structuredClone(fallback) : fallback;
  }
}

/** Grava em arquivo temporário e renomeia: queda no meio nunca deixa JSON truncado. */
function writeJsonAtomic(path, data) {
  // Pasta nova (ex.: data/life/) é criada na hora — antes a gravação falhava em silêncio.
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export function writeJson(path, data) {
  pendingWrites.delete(path);
  writeJsonAtomic(path, data);
}

/** path → { data, timer } — gravações coalescidas (stores quentes mudam várias vezes por mensagem). */
const pendingWrites = new Map();
const DEFAULT_DEFER_MS = 400;
let exitHooksInstalled = false;

function installExitHooks() {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on("exit", flushJsonWrites);
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.once(signal, () => {
      flushJsonWrites();
      process.exit(code);
    });
  }
}

/**
 * Agenda a gravação de `data` em `path`. Chamadas seguidas no mesmo intervalo viram uma só;
 * o objeto é serializado no momento do flush (estado mais recente).
 */
export function writeJsonDeferred(path, data, delayMs = DEFAULT_DEFER_MS) {
  installExitHooks();
  const pending = pendingWrites.get(path);
  if (pending) {
    pending.data = data;
    return;
  }
  const timer = setTimeout(() => flushJsonWrite(path), delayMs);
  timer.unref?.();
  pendingWrites.set(path, { data, timer });
}

function flushJsonWrite(path) {
  const pending = pendingWrites.get(path);
  if (!pending) return;
  pendingWrites.delete(path);
  clearTimeout(pending.timer);
  try {
    writeJsonAtomic(path, pending.data);
  } catch (error) {
    console.error(`[fileStore] falha ao gravar ${path}:`, error?.message ?? error);
  }
}

export function flushJsonWrites() {
  for (const path of [...pendingWrites.keys()]) flushJsonWrite(path);
}
