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
  "esta"
]);

/** ID de grupo WhatsApp salvo por engano como alias de pessoa. */
export function isWhatsAppGroupIdAlias(alias = "") {
  const s = String(alias ?? "").trim();
  if (!s) return false;
  const bare = s.startsWith("dm-") ? s.slice(3) : s;
  return /^120\d{12,18}$/.test(bare);
}

export function isPlausibleHumanNickname(raw = "") {
  const n = cleanDisplayName(raw);
  if (!n || n.length < 2 || n.length > 28) return false;
  const lower = n.toLowerCase();
  if (NICKNAME_STOPWORDS.has(lower)) return false;
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
  const replacement = name || "você";

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
