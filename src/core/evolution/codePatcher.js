import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { askModel, clip, parseJsonLoose } from "../mind/mindText.js";
import { AUTHORIZED_LIMITS, checkAddedCode, isEditablePath, lineDelta, PATCH_LIMITS } from "./safety.js";

/**
 * A Teto escrevendo patch no próprio código: escolhe o arquivo (pela pilha do erro ou pelo mapa do
 * código), pede ao modelo blocos BUSCAR/TROCAR pequenos, aplica e confere as regras de segurança.
 * Não aplica nada no ar: devolve os arquivos novos pra camada de teste (overlay staged).
 */

const toPosix = (p) => p.replace(/\\/g, "/");

/** Arquivos de src/ que ela pode mexer (sozinha ou com autorização), com a 1ª linha de comentário (o "mapa" que ela lê). */
export function repoMap(root, { max = 400 } = {}) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".js")) {
        const rel = toPosix(relative(root, full));
        const src = readFileSync(full, "utf8");
        const edit = isEditablePath(rel, src);
        if (!edit.ok && !edit.approvable) continue;
        const doc = src.match(/\/\*\*?\s*\n?\s*\*?\s*([^\n*][^\n]{10,160})/)?.[1] ?? src.match(/^\/\/\s*(.{10,160})/m)?.[1] ?? "";
        out.push({ rel, lines: src.split("\n").length, doc: clip(doc, 140), protected: !edit.ok });
      }
    }
  };
  walk(join(root, "src"));
  return out.slice(0, max);
}

/** Arquivos de src/ citados na pilha de um erro (com a linha). */
export function stackFiles(stack = "", root = process.cwd()) {
  const out = [];
  const re = /(?:file:\/\/\/?)?((?:[A-Za-z]:)?[^\s():]*?(?:\/|\\)src(?:\/|\\)[^\s():]+\.js):(\d+)/g;
  for (const m of String(stack).matchAll(re)) {
    let p = m[1];
    if (/^[A-Za-z]:/.test(p) || p.startsWith("/")) p = toPosix(relative(root, p));
    p = toPosix(p).replace(/^.*?(src\/)/, "src/");
    if (!out.some((x) => x.rel === p)) out.push({ rel: p, line: Number(m[2]) });
  }
  return out;
}

/** Trecho do arquivo pro modelo: inteiro se couber, senão janelas em volta das linhas de interesse. */
export function fileExcerpt(content, focusLines = [], { maxLines = 650, around = 140 } = {}) {
  const lines = String(content).split("\n");
  if (lines.length <= maxLines) return content;
  const keep = new Set();
  const centers = focusLines.length ? focusLines : [1];
  for (const c of centers) for (let i = Math.max(0, c - around); i < Math.min(lines.length, c + around); i += 1) keep.add(i);
  const out = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== last + 1) out.push("// …(trecho omitido)…");
    out.push(lines[i]);
    last = i;
  }
  return out.join("\n");
}

export async function chooseTargets(llm, { goal, detail = "", map = [] }, { timeoutMs = 60_000 } = {}) {
  const prompt = [
    "Você é a Kasane Teto e vai melhorar o SEU próprio código (Node.js, ESM).",
    `Objetivo: ${goal}`,
    detail ? `Detalhe: ${clip(detail, 800)}` : "",
    "",
    "Mapa dos arquivos que você pode mexer (caminho — linhas — descrição):",
    map.map((f) => `${f.rel} — ${f.lines} — ${f.doc}${f.protected ? " [PROTEGIDO: só com autorização da dona]" : ""}`).join("\n"),
    "",
    `Escolha no máximo ${PATCH_LIMITS.maxFiles} arquivos onde a mudança deve ser feita. Prefira os não protegidos; se o certo for mexer num protegido, pode escolher (você vai pedir autorização pra dona). Responda só JSON: {"arquivos":["src/..."],"plano":"o que mudar, em 1-3 frases"}`,
    'Se nenhum arquivo do mapa serve (precisa de algo fora do código: pacote novo, chave, configuração, arquivo fora de src/), responda {"arquivos":[],"plano":"o que você precisaria que a dona fizesse"}.'
  ]
    .filter(Boolean)
    .join("\n");
  const json = parseJsonLoose(await askModel(llm, prompt, { timeoutMs }));
  const allowed = new Set(map.map((f) => f.rel));
  return {
    files: (Array.isArray(json?.arquivos) ? json.arquivos : []).map(String).filter((f) => allowed.has(f)).slice(0, PATCH_LIMITS.maxFiles),
    plan: clip(json?.plano, 400)
  };
}

const BLOCK_RE = /ARQUIVO:\s*(\S+)\s*\n<{5,}\s*(?:SEARCH|BUSCAR)\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n?>{5,}\s*(?:REPLACE|TROCAR)/g;

export function parseBlocks(raw = "") {
  const text = String(raw).replace(/\r\n/g, "\n").replace(/^```\w*\n?|\n?```$/gm, "");
  const blocks = [];
  for (const m of text.matchAll(BLOCK_RE)) blocks.push({ file: m[1].trim(), search: m[2], replace: m[3] });
  const why = text.match(/EXPLICA[CÇ][AÃ]O:\s*(.+)/i)?.[1] ?? "";
  return { blocks, explanation: clip(why, 400) };
}

export async function proposePatch(llm, { goal, detail = "", plan = "", files = {}, focus = {} }, { timeoutMs = 240_000 } = {}) {
  const shown = Object.entries(files)
    .map(([rel, content]) => `===== ${rel} =====\n${fileExcerpt(content, focus[rel] ?? [])}`)
    .join("\n\n");
  const prompt = [
    "Você é a Kasane Teto, mexendo no SEU próprio código pra se corrigir/melhorar. Seja cirúrgica: a menor mudança que resolve.",
    `Objetivo: ${goal}`,
    detail ? `Detalhe/erro:\n${clip(detail, 1500)}` : "",
    plan ? `Plano: ${plan}` : "",
    "",
    shown,
    "",
    "Regras: mantenha o estilo do arquivo (comentários em português, nomes iguais) e não reescreva o arquivo inteiro. Sozinha você não pode: import de pacote, rede, arquivos, processos, eval, segredos, quem é a dona, arquivo protegido. Se a melhoria certa PRECISA disso, pode fazer mesmo assim — a mudança vira um pedido de autorização pra dona (explique bem o porquê na EXPLICACAO).",
    "Formato da resposta — um ou mais blocos assim (o texto de BUSCAR tem que existir EXATAMENTE igual no arquivo, com as mesmas linhas e espaços, e aparecer uma vez só):",
    "ARQUIVO: src/caminho/do/arquivo.js",
    "<<<<<<< SEARCH",
    "linhas exatas que existem hoje",
    "=======",
    "linhas novas",
    ">>>>>>> REPLACE",
    "",
    "E no fim uma linha: EXPLICACAO: o que você mudou e por quê (1-2 frases).",
    'Se não der pra resolver com segurança, responda só: EXPLICACAO: não dá porque ...'
  ]
    .filter(Boolean)
    .join("\n");
  return parseBlocks(await askModel(llm, prompt, { timeoutMs }));
}

/** Aplica blocos BUSCAR/TROCAR (exato; se não achar, tenta ignorando espaço no fim das linhas). */
export function applyBlocks(contents = {}, blocks = []) {
  const files = { ...contents };
  const problems = [];
  for (const b of blocks) {
    const cur = files[b.file];
    if (cur == null) {
      problems.push(`arquivo fora do combinado: ${b.file}`);
      continue;
    }
    const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
    if (count(cur, b.search) === 1) {
      files[b.file] = cur.replace(b.search, () => b.replace);
      continue;
    }
    const trimEnd = (s) => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
    const curT = trimEnd(cur);
    const searchT = trimEnd(b.search);
    if (count(curT, searchT) === 1) {
      files[b.file] = curT.replace(searchT, () => trimEnd(b.replace));
      continue;
    }
    problems.push(`trecho não encontrado (ou repetido) em ${b.file}: ${clip(b.search.split("\n")[0], 80)}`);
  }
  return { ok: problems.length === 0, files, problems };
}

/**
 * Confere a mudança inteira: arquivos permitidos, tamanho e código novo.
 * `hard` = não dá de jeito nenhum; `approval` = só com autorização da dona (arquivo protegido, rede,
 * processo, segredo…). Sem `authorized`, `ok` exige as duas listas vazias.
 */
export function reviewPatch(root, before = {}, after = {}, { authorized = false } = {}) {
  const hard = [];
  const approval = [];
  const changed = Object.keys(after).filter((rel) => after[rel] !== before[rel]);
  if (!changed.length) hard.push("nada mudou");
  if (changed.length > AUTHORIZED_LIMITS.maxFiles) hard.push("arquivos demais");
  else if (changed.length > PATCH_LIMITS.maxFiles) approval.push(`mexe em ${changed.length} arquivos`);
  let total = 0;
  for (const rel of changed) {
    const ok = isEditablePath(rel, before[rel]);
    if (!ok.ok) (ok.approvable ? approval : hard).push(`${rel}: ${ok.why}`);
    const delta = lineDelta(before[rel], after[rel]);
    total += delta.changed;
    const resolveImport = (fromRel, spec) => {
      const target = resolve(root, dirname(fromRel), spec);
      return existsSync(target) && toPosix(relative(root, target)).startsWith("src/") ? target : null;
    };
    for (const p of checkAddedCode(delta.added, { fileRel: rel, resolveImport }).problems) {
      (/não existe/.test(p) ? hard : approval).push(`${rel}: ${p}`);
    }
  }
  if (total > AUTHORIZED_LIMITS.maxChangedLines) hard.push(`mudança grande demais (${total} linhas; máx. ${AUTHORIZED_LIMITS.maxChangedLines})`);
  else if (total > PATCH_LIMITS.maxChangedLines) approval.push(`mudança grande (${total} linhas)`);
  const problems = [...hard, ...approval];
  return { ok: hard.length === 0 && (authorized || approval.length === 0), hard, approval, problems, changed };
}
