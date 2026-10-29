/**
 * Ganchos do carregador de módulos (node:module register): quando o app importa um arquivo de src/
 * que a Teto reescreveu, carrega a versão dela (data/evolution/overlay/…) no lugar da original.
 * Imports relativos de dentro da versão dela continuam resolvendo como se ela estivesse no lugar
 * original (o pai é traduzido de volta antes de resolver).
 */

let forward = new Map(); // URL original → URL da versão dela
let backward = new Map(); // URL da versão dela → URL original

export async function initialize(data = {}) {
  forward = new Map(Object.entries(data.map ?? {}));
  backward = new Map([...forward].map(([orig, over]) => [over, orig]));
}

export async function resolve(specifier, context, nextResolve) {
  const parent = context.parentURL;
  const ctx = parent && backward.has(parent) ? { ...context, parentURL: backward.get(parent) } : context;
  const result = await nextResolve(specifier, ctx);
  const target = forward.get(result.url);
  return target ? { ...result, url: target, shortCircuit: true } : result;
}
