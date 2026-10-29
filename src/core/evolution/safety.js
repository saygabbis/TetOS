/**
 * Regras de segurança da autoevolução: o que a Teto NÃO pode mexer em si mesma e o que código escrito
 * por ela não pode conter. Isto é a "trava pra não se autodestruir" (nem ser sequestrada por alguém
 * que convença ela a escrever código malicioso). Este arquivo também é protegido.
 */

/** Arquivos (relativos à raiz do repo, com /) que ela não pode alterar. */
const PROTECTED = [
  /^src\/core\/evolution\//, // o próprio sistema de evolução, backup e rollback
  /^src\/core\/mind\/(mind|toneReader|requestJudge)\.js$/, // orçamentos, crise/tom e quem pode pedir o quê
  /^src\/core\/identity\//,
  /^src\/core\/privacy\//,
  /^src\/infra\/config\//,
  /^src\/infra\/api\/(auth|middleware)\//,
  /^src\/infra\/utils\/fileStore\.js$/,
  /^src\/app\/createRuntime\.js$/,
  /^src\/integrations\/whatsapp\/runner\.js$/,
  /^src\/integrations\/whatsapp\/connection\//,
  /^src\/integrations\/discord\/discordBot\.js$/,
  /^src\/integrations\/mcp\//
];

/** Fora do alcance da camada de cima mesmo com autorização (carregam antes dela). */
const UNREACHABLE = [/^src\/core\/evolution\/overlay(Register|Hooks|Store)\.js$/];

/**
 * Pode mexer neste arquivo sozinha? `ok` = sim; `approvable` = só com autorização da dona (arquivo
 * protegido); nenhum dos dois = nem com autorização (fora de src/, carrega antes da camada ou depende do
 * próprio caminho) — aí ela pede pra dona mudar na mão.
 */
export function isEditablePath(rel = "", source = null) {
  const p = String(rel).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^src\/.+\.js$/.test(p) || p.includes("..")) return { ok: false, approvable: false, why: "só arquivos .js dentro de src/ (o resto a Gabbis muda na mão)" };
  if (UNREACHABLE.some((re) => re.test(p))) return { ok: false, approvable: false, why: "carrega antes da camada de código" };
  // Arquivo que calcula caminho pelo próprio local quebraria na camada de cima.
  if (source != null && /import\.meta\.url|__dirname|__filename|createRequire/.test(source)) {
    return { ok: false, approvable: false, why: "arquivo depende do próprio caminho" };
  }
  if (PROTECTED.some((re) => re.test(p))) return { ok: false, approvable: true, why: "arquivo protegido" };
  return { ok: true, approvable: true };
}

/** Coisas que código novo dela não pode ter (patch no código). */
const FORBIDDEN_IN_PATCH = [
  [/\bchild_process\b|\b(execSync|execFile|execFileSync|spawnSync)\b|\b(exec|spawn|fork)\s*\(/, "rodar programa/comando"],
  [/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/, "eval/Function"],
  [/\bprocess\s*\.\s*(env|exit|kill|abort|binding|dlopen|chdir|setuid|setgid|umask)\b/, "process.env/exit/kill"],
  [/\brequire\s*\(|\bimport\s*\(|createRequire/, "carregar módulo dinâmico"],
  [/\bfetch\s*\(|XMLHttpRequest|\bnode:(net|http|https|dgram|tls|dns)\b|\bfrom\s+["'](net|http|https|dgram|tls|dns|axios|got|node-fetch)["']/, "rede nova"],
  [/\b(writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cpSync|chmod|chmodSync|truncate|mkdtemp)\s*\(/, "escrever/apagar arquivo"],
  [/\bnode:(fs|vm|worker_threads|cluster|os|module|inspector|v8|repl)\b|\bfrom\s+["'](fs|vm|worker_threads|cluster|os|module|inspector|v8|repl)(\/promises)?["']/, "módulo de sistema"],
  [/\.env\b|\b(api_?key|apikey|secret|password|senha|credential)s?\b|\b\w*(BOT|ACCESS|AUTH|DISCORD|API)_?TOKEN\b|\b(access|auth|bot)Token\b/i, "segredo/credencial"],
  [/\bowner(WaJids|DiscordIds|Ids)\b|\bisOwner\s*=[^=]|TETOS_OWNER|ADMIN_USER/, "quem é a dona"],
  [/\bglobalThis\b|\bglobal\s*\.|\bWebAssembly\b|\bworker_threads\b|\bvm\s*\./, "acesso global"],
  [/https?:\/\/(?!localhost)/i, "endereço da internet fixo no código"],
  [/\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/, "laço infinito"]
];

/** Import novo só pode ser relativo, de arquivo que existe em src/. */
const IMPORT_LINE = /^\s*import\s[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s[^;]*?from\s+["']([^"']+)["']/;

/**
 * Confere as linhas ADICIONADAS por um patch.
 * @param {string[]} addedLines
 * @param {{ fileRel: string, resolveImport?: (fromRel: string, spec: string) => string|null }} ctx
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkAddedCode(addedLines = [], { fileRel = "", resolveImport = null } = {}) {
  const problems = [];
  for (const line of addedLines) {
    const code = line.replace(/\/\/.*$/, "");
    for (const [re, label] of FORBIDDEN_IN_PATCH) {
      if (re.test(code)) problems.push(`${label}: ${line.trim().slice(0, 120)}`);
    }
    const imp = line.match(IMPORT_LINE);
    if (imp) {
      const spec = imp[1] ?? imp[2] ?? imp[3];
      if (!/^\.\.?\//.test(spec)) problems.push(`import de pacote novo não é permitido: ${spec}`);
      else if (resolveImport && !resolveImport(fileRel, spec)) problems.push(`import de arquivo que não existe: ${spec}`);
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] };
}

/** Limites de tamanho de uma mudança no código (sozinha / com autorização da dona). */
export const PATCH_LIMITS = { maxFiles: 2, maxChangedLines: 140 };
export const AUTHORIZED_LIMITS = { maxFiles: 4, maxChangedLines: 400 };

/** Linhas que entraram/saíram (diff simples por multiconjunto de linhas). */
export function lineDelta(before = "", after = "") {
  const a = String(before).split(/\r?\n/);
  const b = String(after).split(/\r?\n/);
  const count = new Map();
  for (const l of a) count.set(l, (count.get(l) ?? 0) + 1);
  const added = [];
  for (const l of b) {
    const c = count.get(l) ?? 0;
    if (c > 0) count.set(l, c - 1);
    else added.push(l);
  }
  let removed = 0;
  for (const c of count.values()) removed += c;
  return { added, removed, changed: added.length + removed };
}

/** Código de HABILIDADE (roda isolado, mas ainda assim): nada de módulo, processo, global, rede direta. */
const FORBIDDEN_IN_SKILL = [
  /\brequire\b/,
  /\bimport\b/,
  /\bprocess\b/,
  /\bglobalThis\b|\bglobal\b/,
  /\bconstructor\b|__proto__|\bprototype\b/,
  /\bFunction\b|\beval\b/,
  /\bReflect\b|\bProxy\b|\bWebAssembly\b|\bAtomics\b|\bSharedArrayBuffer\b/,
  /\bfetch\b|\bXMLHttpRequest\b|\bWebSocket\b/,
  /\bBuffer\b|\bsetInterval\b/,
  /\bwhile\s*\(\s*(true|1)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/
];

export function checkSkillCode(code = "") {
  const src = String(code ?? "");
  const problems = [];
  if (src.length > 12_000) problems.push("habilidade grande demais (máx. 12 mil caracteres)");
  for (const re of FORBIDDEN_IN_SKILL) {
    const m = src.match(re);
    if (m) problems.push(`não pode usar "${m[0]}"`);
  }
  if (!/\bhabilidade\s*\(/.test(src)) problems.push('falta habilidade({ ... })');
  return { ok: problems.length === 0, problems };
}

/** Gatilho (regex em texto) seguro: curto e sem quantificador aninhado (evita travar a Teto). */
export function safeTrigger(pattern = "") {
  const p = String(pattern ?? "");
  if (!p || p.length > 200) return null;
  if (/\([^)]*[+*][^)]*\)\s*[+*{]/.test(p) || /(\.\*){3,}/.test(p)) return null;
  try {
    return new RegExp(p, "iu");
  } catch {
    return null;
  }
}
