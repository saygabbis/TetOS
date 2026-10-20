import { cleanDisplayName } from "./waIdentity.js";
import { isOwnerContact } from "./userActivity.js";

/** Nome da dona — só deve aparecer como vocativo quando o interlocutor é a dona. */
export const OWNER_GIVEN_NAME_TOKENS = new Set(["gabbis", "gabbi"]);

const NICKNAME_STOPWORDS = new Set([
  "aí",
  "ah",
  "ahhh",
  "alaaaa",
  "certo",
  "conheço",
  "do",
  "eu",
  "explica",
  "fica",
  "me",
  "menu",
  "mds",
  "não",
  "nao",
  "oie",
  "oieee",
  "ou",
  "oxi",
  "pode",
  "prontooo",
  "que",
  "quem",
  "quer",
  "repertório",
  "repertorio",
  "sacou",
  "saber",
  "sellye",
  "só",
  "so",
  "tá",
  "ta",
  "tava",
  "tô",
  "to",
  "uai",
  "ué",
  "ue",
  "veio",
  "visão",
  "visao",
  "você",
  "voce",
  "vou",
  "calmaaa",
  "achei",
  "está",
  "esta",
  // Palavras comuns que a captura antiga confundia com apelido (primeira palavra da bolha).
  "a", "o", "as", "os", "um", "uma", "de", "da", "dos", "das", "em", "no", "na", "pra", "pro",
  "se", "mas", "e", "é", "eh", "ou", "nem", "com", "sem", "por", "para", "lá", "la", "aqui",
  "oi", "oii", "oiii", "oiie", "ooi", "ooooi", "olá", "ola", "ei", "eii", "eai", "eae", "opa", "salve",
  "aff", "afff", "ugh", "ui", "ai", "aii", "ah", "ahh", "oh", "ohh", "eita", "eitaa", "nossa", "poxa",
  "putz", "vish", "vixi", "xi", "oxí", "oxe", "ops", "hm", "hmm", "hmmm", "mmm", "uhul", "aham", "uhum",
  "kk", "kkk", "kkkk", "haha", "hahaha", "rs", "rsrs", "ksks", "mano", "cara", "gente", "véi", "vei",
  "sim", "nao", "não", "né", "ne", "tá", "ta", "tô", "to", "ok", "okay", "beleza", "blz", "certo", "claro",
  "então", "entao", "bom", "boa", "bem", "mal", "sério", "serio", "calma", "pronto", "enfim", "tipo",
  "olha", "vai", "vem", "bora", "deixa", "fala", "manda", "qual", "quando", "onde", "como", "porque",
  "sou", "era", "foi", "fui", "vi", "já", "ja", "ainda", "agora", "hoje", "também", "tambem", "muito",
  "nasci", "dormindo", "rindo", "sofrimento", "depende", "perfeito", "salvo", "salvooo", "três", "tres",
  "aquele", "aquela", "isso", "esse", "essa", "xiu", "fica", "vou", "vamos", "acho", "sei", "sabe",
  "obrigada", "obrigado", "valeu", "desculpa", "tchau", "bye", "teto", "vibe", "lado", "impaciente",
  "deus", "vida", "celular", "casa", "dia", "noite", "tarde"
]);

/** Termos de carinho que a Teto usa como vocativo ("amor, ..." / "minha linda"). */
export const TETO_ENDEARMENTS = new Set([
  "amor", "amorzinho", "amore", "mozão", "mozao", "mozinho", "mor", "bebê", "bebe", "bb", "bebezinha",
  "bebezinho", "neném", "nenem", "nenê", "princesa", "princesinha", "príncipe", "principe", "linda",
  "lindinha", "lindona", "lindeza", "fofa", "fofinha", "fofo", "fofinho", "gata", "gatinha", "gato",
  "gatinho", "anjo", "anjinho", "flor", "florzinha", "querida", "querido", "docinho", "xuxu", "chuchu",
  "coisinha", "diva", "rainha", "tesouro", "benzinho", "maninha", "miga", "amiga", "migs"
]);

/** Risada/interjeição de teclado: nunca é apelido nem identidade. */
export function isLaughterOrNoiseToken(raw = "") {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return true;
  if (/^k{2,}$/.test(s) || /^[ks]{3,}$/.test(s)) return true;
  if (/^(rs)+$/.test(s) || /^(ha|he|hi|hu){2,}h?$/.test(s)) return true;
  const letters = s.replace(/[^\p{L}]/gu, "");
  if ((letters.match(/k/g) ?? []).length >= 2 && (letters.match(/[ksjdhf]/g) ?? []).length / letters.length >= 0.7) return true;
  // "ooooi", "prontooo", "aiii" → forma base é palavra comum
  const collapsed = s.replace(/(\p{L})\1+/gu, "$1");
  if (collapsed !== s && NICKNAME_STOPWORDS.has(collapsed)) return true;
  return false;
}

/**
 * Vocativo/apelido que a Teto usou é aceitável? Só termos de carinho conhecidos ou
 * variações do nome da pessoa (ex.: "Gabi" para "Gabbis") — nunca a 1ª palavra solta da bolha.
 */
export function isTetoNicknameCandidate(raw = "", { displayName = null, knownNames = [] } = {}) {
  const n = cleanDisplayName(raw);
  if (!n || n.length < 2 || n.length > 24) return false;
  const lower = n.toLowerCase();
  if (TETO_ENDEARMENTS.has(lower)) return true;
  if (!isPlausibleHumanNickname(n)) return false;
  const names = [displayName, ...(knownNames ?? [])]
    .map((x) => cleanDisplayName(x)?.toLowerCase())
    .filter((x) => x && x.length >= 3);
  return names.some((name) => lower.length >= 3 && name.slice(0, 3) === lower.slice(0, 3));
}

/** ID de grupo WhatsApp salvo por engano como alias de pessoa (atual 120363… ou legado tel-timestamp). */
export function isWhatsAppGroupIdAlias(alias = "") {
  const s = String(alias ?? "").trim();
  if (!s) return false;
  const bare = (s.startsWith("dm-") ? s.slice(3) : s).replace(/@g\.us$/i, "");
  return /^120\d{12,18}$/.test(bare) || /^\d{10,15}-\d{9,10}$/.test(bare) || /@g\.us$/i.test(s);
}

/** Chave de identidade = telefone, LID, dm-* ou JID de pessoa — nunca nome, apelido ou grupo. */
export function isIdentityIdLike(alias = "") {
  const s = String(alias ?? "").trim();
  if (!s || isWhatsAppGroupIdAlias(s)) return false;
  if (/^[\d]+@(s\.whatsapp\.net|lid|c\.us)$/i.test(s)) return true;
  const bare = s.startsWith("dm-") ? s.slice(3) : s;
  return /^\d{6,20}$/.test(bare);
}

export function isPlausibleHumanNickname(raw = "") {
  const n = cleanDisplayName(raw);
  if (!n || n.length < 2 || n.length > 28) return false;
  const lower = n.toLowerCase();
  if (NICKNAME_STOPWORDS.has(lower)) return false;
  if (isLaughterOrNoiseToken(lower)) return false;
  if (/^\d+$/.test(n)) return false;
  if (!/[\p{L}]/u.test(n)) return false;
  return true;
}

export function sanitizeProfileNicknames(nicknames = [], { displayName = null, max = 16 } = {}) {
  const base = cleanDisplayName(displayName)?.toLowerCase();
  const out = [];
  const seen = new Set();
  for (const raw of nicknames ?? []) {
    const n = cleanDisplayName(raw);
    if (!isPlausibleHumanNickname(n)) continue;
    const key = n.toLowerCase();
    if (OWNER_GIVEN_NAME_TOKENS.has(key) && key !== base) continue;
    if (base && key === base) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Filtros extras de identityAliases (após regras bot↔humano em botIdentity).
 */
export function filterIdentityAliasTokens(aliases = [], runtime, profileKey = "") {
  const isOwner =
    isOwnerContact(runtime, null, profileKey) ||
    isOwnerContact(runtime, null, String(profileKey).replace(/^dm-/, ""));

  return aliases.filter((alias) => {
    const lower = String(alias).toLowerCase();
    if (!isOwner && OWNER_GIVEN_NAME_TOKENS.has(lower)) return false;
    if (isWhatsAppGroupIdAlias(alias)) return false;
    // Só IDs (tel/LID/dm-*/JID); palavras e apelidos ligavam contatos diferentes entre si.
    if (alias !== profileKey && !isIdentityIdLike(alias)) return false;
    return true;
  });
}

/** Linhas seguras de perfil para prompt em PV (sem identityAliases crus). */
export function formatDmProfilePromptLines(facts = {}, meta = {}) {
  if (!facts || typeof facts !== "object") return [];

  const interlocutor =
    cleanDisplayName(meta.speakerName) ||
    cleanDisplayName(facts.preferredName) ||
    cleanDisplayName(facts.displayName) ||
    cleanDisplayName(facts.name) ||
    null;

  const lines = [];
  if (interlocutor) lines.push(`interlocutor: ${interlocutor}`);
  if (facts.preferredName && facts.preferredName !== interlocutor) {
    lines.push(`prefere ser chamada: ${facts.preferredName}`);
  }
  if (facts.pronouns) lines.push(`pronomes: ${facts.pronouns}`);

  const nicks = sanitizeProfileNicknames(
    [...(facts.nicknames ?? []), ...(facts.tetoNicknames ?? [])],
    { displayName: interlocutor, max: 8 }
  );
  if (nicks.length) lines.push(`apelidos válidos: ${nicks.join(", ")}`);

  return lines;
}

/**
 * Corrige texto da Teto que chama a dona (Gabbis) quando o interlocutor não é ela.
 */
export function fixMisaddressedOwnerName(text = "", { isOwner = false, interlocutorName = null } = {}) {
  let out = String(text ?? "");
  if (!out || isOwner) return out;

  const name = cleanDisplayName(interlocutorName);

  out = out.replace(/@gabbis\b/gi, name ? `@${name}` : "você");
  out = out.replace(
    /\b(gabbis|gabbi)\b(?=\s*[,!?.\s]|$)/gi,
    (match) => {
      if (name) {
        return match[0] === match[0].toUpperCase() ? name : name;
      }
      return "você";
    }
  );

  if (!name && /\bvocê\b/i.test(out) === false && /@gabbis/i.test(text)) {
    out = out.replace(/\s{2,}/g, " ").trim();
  }

  return out;
}

export function fixMisaddressedOwnerNameInReplies(replies = [], options = {}) {
  if (!Array.isArray(replies) || options.isOwner) return replies;
  const actions = replies.actions;
  const fixed = replies.map((r) => fixMisaddressedOwnerName(r, options));
  if (Array.isArray(actions) && actions.length > 0) {
    fixed.actions = actions.map((action) => {
      if (action?.type === "message" && action.text) {
        return { ...action, text: fixMisaddressedOwnerName(action.text, options) };
      }
      return action;
    });
  }
  return fixed;
}

/** Em PV com terceiros, não injetar memórias cujo foco é a dona. */
export function shouldOmitOwnerCentricMemoryHint(hint = "", { isGroup = false, isOwner = false } = {}) {
  if (isGroup || isOwner) return false;
  const h = String(hint ?? "");
  if (!h) return false;
  if (!/\bgabbis\b/i.test(h)) return false;
  if (/\b(chama|menciona|marca)\s+(a\s+)?gabbis\b/i.test(h)) return true;
  if (/\b(namorando|apaixonad|dona|pix)\b/i.test(h) && /\bgabbis\b/i.test(h)) return true;
  return false;
}
