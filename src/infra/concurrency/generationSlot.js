const MAX_PARALLEL = Number(process.env.TETOS_MAX_PARALLEL_GENERATIONS ?? 3);
let active = 0;
const waiters = [];

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

/** Limita chamadas simultâneas ao LLM para evitar timeout e perda de contexto sob carga. */
export async function withGenerationSlot(fn) {
  if (active >= MAX_PARALLEL) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  active += 1;
  try {
    return await fn();
  } finally {
    release();
  }
}
