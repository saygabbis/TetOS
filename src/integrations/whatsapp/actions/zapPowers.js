/**
 * Poderes do zap pra Teto: tudo que dá pelo app (grupo, enquete, evento, contato, local, fixar) e
 * mandar mensagem em outro chat. Ela decide sozinha quando usar; a SEGURANÇA fica aqui:
 *  - ações de admin (remover, adicionar, promover, nome, fechar…) só se quem pediu é a dona ou admin
 *    do grupo, e ela precisa ser admin; nunca contra a dona nem contra ela mesma;
 *  - mandar mensagem em outro chat: a dona manda pra qualquer um; os outros só deixam recado pra dona;
 *  - limite de envios pra outros chats (não vira spam).
 */
import { randomBytes } from "node:crypto";
import { generateWAMessageFromContent } from "baileys";
import { isOwnerContact } from "../../../core/channels/userActivity.js";
import { buildIdentityIndex } from "../../../core/channels/waIdentity.js";
import { translateAtMentions } from "../inbound/mentionResolver.js";

const norm = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/^@/, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");
const localOf = (jid) => String(jid ?? "").split("@")[0].split(":")[0];

/** Ações que mexem no grupo como admin. */
export const ADMIN_ACTIONS = new Set([
  "remover", "adicionar", "promover", "rebaixar", "nome", "descricao", "foto",
  "fechar", "abrir", "trancar", "destrancar", "temporarias", "aprovacao", "link", "resetarlink", "apagar"
]);
/** Ações que qualquer um pode fazer (a Teto mesma decide). */
export const FREE_ACTIONS = new Set(["enquete", "evento", "contato", "local", "fixar", "desfixar"]);

const ALIASES = {
  remove: "remover", expulsar: "remover", kick: "remover", banir: "remover", tirar: "remover",
  add: "adicionar", incluir: "adicionar",
  promote: "promover", admin: "promover", daradm: "promover",
  demote: "rebaixar", tiraradm: "rebaixar",
  renomear: "nome", titulo: "nome", assunto: "nome", subject: "nome",
  desc: "descricao", "descrição": "descricao", description: "descricao",
  mutar: "fechar", silenciar: "fechar", fecha: "fechar", "so admins": "fechar",
  desmutar: "abrir", abre: "abrir",
  lock: "trancar", unlock: "destrancar",
  temporaria: "temporarias", "temporárias": "temporarias", efemeras: "temporarias",
  convite: "link", invite: "link",
  poll: "enquete", votacao: "enquete", "votação": "enquete",
  event: "evento", agendar: "evento",
  contact: "contato", vcard: "contato",
  localizacao: "local", "localização": "local", location: "local",
  pin: "fixar", unpin: "desfixar",
  deletar: "apagar", delete: "apagar"
};

export function normalizeZapAction(name = "") {
  const k = norm(name).replace(/\s+/g, "");
  return ALIASES[k] ?? ALIASES[norm(name)] ?? k;
}

/** Quanto tempo: "1h", "24h", "7d", "90d", "off". */
function parseEphemeral(v = "") {
  const t = norm(v);
  if (/^(off|desliga|nao|0)/.test(t)) return 0;
  if (/90/.test(t)) return 90 * 86400;
  if (/7|semana/.test(t)) return 7 * 86400;
  return 86400;
}

/** "2026-12-05 19:30", "05/12 19h", "amanhã 20:00" → Date (fuso de SP). */
export function parseWhen(raw = "", now = new Date()) {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return null;
  const tm = t.match(/(\d{1,2})(?:[:h](\d{2}))?\s*(?:h|$)/);
  const hour = tm ? Number(tm[1]) : 19;
  const min = tm?.[2] ? Number(tm[2]) : 0;
  let y = now.getFullYear();
  let mo;
  let d;
  let m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/))) {
    d = Number(m[1]);
    mo = Number(m[2]);
    if (m[3]) y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  } else {
    const base = new Date(now.getTime() + (/(depois de amanh)/.test(t) ? 2 : /amanh/.test(t) ? 1 : 0) * 86400_000);
    y = base.getFullYear();
    mo = base.getMonth() + 1;
    d = base.getDate();
  }
  const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00-03:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function ownerJid(runtime) {
  const fromEnv = runtime?.defaults?.ownerWaJids?.[0];
  if (fromEnv) return fromEnv.includes("@") ? fromEnv : `${digitsOf(fromEnv)}@s.whatsapp.net`;
  const phone = digitsOf(runtime?.defaults?.learningTargetUserId);
  return phone ? `${phone}@s.whatsapp.net` : null;
}

/** Acha um participante do grupo pelo que ela escreveu (@nome, nome, número). */
function findParticipant(meta, target, roster = []) {
  const parts = meta?.participants ?? [];
  const raw = String(target ?? "").trim();
  const digits = digitsOf(raw);
  const matchJid = (jid) =>
    parts.find((p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).some((x) => localOf(x) === localOf(jid)));
  if (digits.length >= 8) {
    const hit = parts.find((p) => [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean).some((x) => localOf(x).endsWith(digits.slice(-8))));
    if (hit) return hit;
  }
  const { mentions } = translateAtMentions(raw.startsWith("@") ? raw : `@${raw}`, roster);
  for (const jid of mentions) {
    const hit = matchJid(jid);
    if (hit) return hit;
  }
  const want = norm(raw);
  const byName = roster.find((m) => [m.name, m.displayName, ...(m.aliases ?? [])].some((n) => n && norm(n) === want));
  if (byName) {
    for (const k of [byName.mentionJid, byName.jid, byName.userId].filter(Boolean)) {
      const hit = matchJid(k);
      if (hit) return hit;
    }
  }
  return null;
}

const isAdminP = (p) => p?.admin === "admin" || p?.admin === "superadmin";

/** Pra onde mandar: "Gabbis"/"dona", nome de grupo, nome de contato, número. */
export async function resolveDestination(runtime, socket, target) {
  const raw = String(target ?? "").trim();
  const want = norm(raw);
  if (!want) return null;
  if (/^(gabbis|gabi|gabbrielly|dona|minha dona|a dona)$/.test(want)) {
    const jid = ownerJid(runtime);
    return jid ? { jid, label: "a Gabbis", kind: "owner" } : null;
  }
  if (/@(g\.us|s\.whatsapp\.net|lid)$/.test(raw)) return { jid: raw, label: raw, kind: raw.endsWith("@g.us") ? "group" : "person" };
  const groups = await socket?.groupFetchAllParticipating?.().catch(() => null);
  if (groups) {
    const list = Object.values(groups);
    const exact = list.find((g) => norm(g.subject) === want) ?? list.find((g) => norm(g.subject).includes(want) && want.length >= 4);
    if (exact) return { jid: exact.id, label: exact.subject, kind: "group" };
  }
  const index = buildIdentityIndex(runtime);
  for (const entry of index.values()) {
    const names = [entry.displayName, entry.preferredName, ...(entry.nicknames ?? [])].filter(Boolean).map(norm);
    if (!names.includes(want)) continue;
    const jid = entry.mentionJid ?? (entry.waPhone ? `${entry.waPhone}@s.whatsapp.net` : entry.waLid ? `${entry.waLid}@lid` : null);
    if (jid && !jid.endsWith("@g.us")) return { jid, label: entry.preferredName ?? entry.displayName, kind: "person" };
  }
  const digits = digitsOf(raw);
  if (digits.length >= 10) return { jid: `${digits}@s.whatsapp.net`, label: raw, kind: "person" };
  return null;
}

const sendLog = [];
function underSendLimit(now = Date.now()) {
  while (sendLog.length && now - sendLog[0] > 10 * 60_000) sendLog.shift();
  return sendLog.length < 6;
}

/**
 * enviar("destino", "texto"): manda num PV ou grupo. Dona: livre. Outros: só recado pra dona.
 * @returns {{ ok: boolean, note?: string }}
 */
export async function sendElsewhere({ runtime, socket, item, target, text }) {
  const msg = String(text ?? "").trim();
  if (!msg) return { ok: false, note: "faltou o que falar" };
  const requesterIsOwner = Boolean(item?.isOwner) || isOwnerContact(runtime, item?.remoteJid, item?.userId);
  const dest = await resolveDestination(runtime, socket, target);
  if (!dest) return { ok: false, note: `não achei quem é "${target}" nos meus contatos/grupos` };
  if (!requesterIsOwner && dest.kind !== "owner") {
    return { ok: false, note: "só a Gabbis pode me mandar falar com outras pessoas; recado pra ela eu levo" };
  }
  if (dest.jid === item?.remoteJid) return { ok: false, note: "é aqui mesmo" };
  if (!underSendLimit()) return { ok: false, note: "já mandei muita coisa pra fora agora, espera um pouco" };
  sendLog.push(Date.now());
  const from = item?.pushName || item?.speakerName || null;
  const body = dest.kind === "owner" && !requesterIsOwner && from ? `recado de ${from}: ${msg}` : msg;
  await socket.sendMessage(dest.jid, { text: body });
  return { ok: true, note: `mandei pra ${dest.label}` };
}

/** Evento do zap (o mesmo do botão "Evento" no app): não tem atalho no Baileys, monta na mão. */
async function sendEvent(socket, jid, { name, when, description = "", location = "" }) {
  const start = parseWhen(when) ?? new Date(Date.now() + 86400_000);
  const content = {
    messageContextInfo: { messageSecret: randomBytes(32) },
    eventMessage: {
      isCanceled: false,
      name: String(name).slice(0, 100),
      description: String(description ?? "").slice(0, 1000) || undefined,
      ...(location ? { location: { name: String(location).slice(0, 100) } } : {}),
      startTime: Math.floor(start.getTime() / 1000),
      extraGuestsAllowed: false
    }
  };
  const msg = generateWAMessageFromContent(jid, content, { userJid: socket?.user?.id });
  await socket.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return start;
}

/**
 * Executa zap("acao", ...args) vindo da resposta dela.
 * @returns {Promise<{ ok: boolean, note?: string }>}
 */
export async function runZapAction({ runtime, socket, item, action, args = [], roster = [] }) {
  const name = normalizeZapAction(action);
  const jid = item?.remoteJid;
  const isGroup = String(jid ?? "").endsWith("@g.us");
  const [a1, a2, a3, a4] = args.map((x) => (x == null ? "" : String(x)));

  if (name === "enquete") {
    const options = String(a2 || "").split(/\s*[|;\n]\s*|\s*,\s*(?=\S)/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
    if (!a1 || options.length < 2) return { ok: false, note: "enquete precisa de pergunta e 2+ opções" };
    const multi = /^(sim|true|multi|varias|várias|1)$/i.test(a3.trim());
    await socket.sendMessage(jid, { poll: { name: a1.slice(0, 255), values: options, selectableCount: multi ? 0 : 1 } });
    return { ok: true };
  }
  if (name === "evento") {
    if (!a1) return { ok: false, note: "evento precisa de nome" };
    await sendEvent(socket, jid, { name: a1, when: a2, description: a3, location: a4 });
    return { ok: true };
  }
  if (name === "contato") {
    const phone = digitsOf(a2);
    if (!a1 || phone.length < 8) return { ok: false, note: "contato precisa de nome e número" };
    const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${a1}\nTEL;type=CELL;waid=${phone}:+${phone}\nEND:VCARD`;
    await socket.sendMessage(jid, { contacts: { displayName: a1, contacts: [{ vcard }] } });
    return { ok: true };
  }
  if (name === "local") {
    const lat = Number(String(a2).replace(",", "."));
    const lng = Number(String(a3).replace(",", "."));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, note: "local precisa de latitude e longitude" };
    await socket.sendMessage(jid, { location: { degreesLatitude: lat, degreesLongitude: lng, name: a1 || undefined } });
    return { ok: true };
  }
  if (name === "fixar" || name === "desfixar") {
    const id = a1.trim();
    if (!id) return { ok: false, note: "fixar precisa do message id" };
    const time = /30|mes/.test(a2) ? 2592000 : /7|semana/.test(a2) ? 604800 : 86400;
    const fromMe = Boolean(runtime?.chatMessageIndex?.get?.(jid, id)?.fromMe);
    await socket.sendMessage(jid, { pin: { remoteJid: jid, id, fromMe }, type: name === "fixar" ? 1 : 2, time });
    return { ok: true };
  }

  if (!ADMIN_ACTIONS.has(name)) return { ok: false, note: `não sei fazer "${action}" no zap` };
  if (!isGroup) return { ok: false, note: "isso é coisa de grupo" };

  const meta = await socket.groupMetadata(jid);
  const me = meta.participants.find((p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).some((x) => localOf(x) === localOf(socket?.user?.id) || localOf(x) === localOf(socket?.user?.lid)));
  if (!isAdminP(me)) return { ok: false, note: "não sou admin desse grupo" };
  const requesterIsOwner = Boolean(item?.isOwner) || isOwnerContact(runtime, jid, item?.userId);
  const requester = findParticipant(meta, item?.participantJid || item?.participantId || item?.userId, roster);
  if (!requesterIsOwner && !isAdminP(requester)) return { ok: false, note: "só a Gabbis ou admin do grupo pode me pedir isso" };

  const ownerLocal = localOf(ownerJid(runtime));
  const guardTarget = (p) => {
    if (!p) return "não achei essa pessoa no grupo";
    const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean).map(localOf);
    if (ownerLocal && ids.includes(ownerLocal)) return "na Gabbis eu não mexo 😤";
    if (me && p.id === me.id) return "em mim mesma não";
    if (p.admin === "superadmin" && !requesterIsOwner) return "quem criou o grupo eu não tiro";
    return null;
  };

  switch (name) {
    case "remover":
    case "promover":
    case "rebaixar": {
      const target = findParticipant(meta, a1, roster);
      const err = guardTarget(target);
      if (err) return { ok: false, note: err };
      const op = { remover: "remove", promover: "promote", rebaixar: "demote" }[name];
      await socket.groupParticipantsUpdate(jid, [target.id], op);
      return { ok: true };
    }
    case "adicionar": {
      const phone = digitsOf(a1);
      if (phone.length < 10) return { ok: false, note: "pra adicionar preciso do número com DDD" };
      const res = await socket.groupParticipantsUpdate(jid, [`${phone}@s.whatsapp.net`], "add");
      const status = String(res?.[0]?.status ?? "200");
      if (status === "403") return { ok: false, note: "a pessoa não deixa ser adicionada; mandei não (precisa do link)" };
      if (status !== "200") return { ok: false, note: `o zap recusou (${status})` };
      return { ok: true };
    }
    case "nome":
      if (!a1) return { ok: false, note: "faltou o nome" };
      await socket.groupUpdateSubject(jid, a1.slice(0, 100));
      return { ok: true };
    case "descricao":
      await socket.groupUpdateDescription(jid, a1.slice(0, 2048));
      return { ok: true };
    case "fechar":
    case "abrir":
      await socket.groupSettingUpdate(jid, name === "fechar" ? "announcement" : "not_announcement");
      return { ok: true };
    case "trancar":
    case "destrancar":
      await socket.groupSettingUpdate(jid, name === "trancar" ? "locked" : "unlocked");
      return { ok: true };
    case "temporarias":
      await socket.groupToggleEphemeral(jid, parseEphemeral(a1));
      return { ok: true };
    case "aprovacao":
      await socket.groupJoinApprovalMode?.(jid, /^(off|desliga|nao)/i.test(a1) ? "off" : "on");
      return { ok: true };
    case "link": {
      const code = await socket.groupInviteCode(jid);
      await socket.sendMessage(jid, { text: `https://chat.whatsapp.com/${code}` });
      return { ok: true };
    }
    case "resetarlink":
      await socket.groupRevokeInvite(jid);
      return { ok: true };
    case "apagar": {
      const id = a1.trim();
      const row = runtime?.chatMessageIndex?.get?.(jid, id);
      if (!id || !row) return { ok: false, note: "não achei essa mensagem" };
      await socket.sendMessage(jid, { delete: { remoteJid: jid, id, fromMe: Boolean(row.fromMe), participant: row.participantJid ?? undefined } });
      return { ok: true };
    }
    case "foto":
      return { ok: false, note: "trocar foto do grupo ainda não sei por aqui" };
    default:
      return { ok: false, note: `não sei fazer "${action}"` };
  }
}
