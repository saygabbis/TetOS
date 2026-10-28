import { randomInt } from "node:crypto";
import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";

/**
 * Contas da mesma pessoa em apps diferentes. A identidade "de verdade" é a do WhatsApp (o userId do PV,
 * `dm-<id>`): quem vincula o Discord passa a usar esse mesmo userId lá — mesma memória, mesmo caderno,
 * mesma confiança. Quem não vinculou fica como `discord:<id>`, separado.
 *
 * Vínculo: no Discord a pessoa pede um código (`/vincular`); manda esse código pra Teto no PV do zap
 * (`.vincular CÓDIGO`). Só quem tem as duas contas consegue fechar o vínculo.
 */

const CODE_TTL_MS = 10 * 60_000;
// Sem 0/O/1/I: código lido no celular e digitado no zap.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const discordUserKey = (discordId) => `discord:${String(discordId ?? "").trim()}`;

export class IdentityLinkStore {
  constructor(path = "./data/identityLinks.json", { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    this.data = readJson(path, { links: {}, pending: {} });
    this.data.links ??= {};
    this.data.pending ??= {};
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  prunePending() {
    const now = this.now();
    for (const [code, row] of Object.entries(this.data.pending)) {
      if ((row.expiresAt ?? 0) <= now) delete this.data.pending[code];
    }
  }

  /** Código novo pra essa conta do Discord (o anterior dela deixa de valer). */
  createCode({ discordId, discordName = null } = {}) {
    const id = String(discordId ?? "").trim();
    if (!id) throw new Error("discordId obrigatório");
    this.prunePending();
    for (const [code, row] of Object.entries(this.data.pending)) {
      if (row.discordId === id) delete this.data.pending[code];
    }
    let code;
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    } while (this.data.pending[code]);
    const expiresAt = this.now() + CODE_TTL_MS;
    this.data.pending[code] = { discordId: id, discordName, createdAt: this.now(), expiresAt };
    this.save();
    return { code, expiresAt };
  }

  /** Fecha o vínculo com o código vindo do zap. Retorna null se não existe ou expirou. */
  redeem(rawCode, { userId, waJid = null, name = null } = {}) {
    const code = String(rawCode ?? "").trim().toUpperCase();
    this.prunePending();
    const row = this.data.pending[code];
    if (!row || !userId) return null;
    delete this.data.pending[code];
    const link = {
      userId: String(userId),
      waJid,
      name,
      discordName: row.discordName ?? null,
      linkedAt: new Date(this.now()).toISOString()
    };
    this.data.links[discordUserKey(row.discordId)] = link;
    this.save();
    return { discordId: row.discordId, ...link };
  }

  get(discordId) {
    return this.data.links[discordUserKey(discordId)] ?? null;
  }

  unlink(discordId) {
    const key = discordUserKey(discordId);
    if (!this.data.links[key]) return false;
    delete this.data.links[key];
    this.save();
    return true;
  }

  /** Contas do Discord ligadas a esse userId do zap. */
  discordIdsFor(userId) {
    return Object.entries(this.data.links)
      .filter(([, link]) => link.userId === userId)
      .map(([key]) => key.replace(/^discord:/, ""));
  }
}

/** userId que a Teto usa pra essa conta do Discord: o do zap se vinculou, senão `discord:<id>`. */
export function resolveDiscordUserId(store, discordId, { ownerFallbackUserId = null, isOwner = false } = {}) {
  const linked = store?.get?.(discordId);
  if (linked?.userId) return { userId: linked.userId, linked: true };
  if (isOwner && ownerFallbackUserId) return { userId: ownerFallbackUserId, linked: true };
  return { userId: discordUserKey(discordId), linked: false };
}

/** Texto do comando no zap: ".vincular ABC123" (aceita "/vincular" e "vincular"). */
export function parseLinkCommand(text = "", prefix = ".") {
  const t = String(text ?? "").trim();
  const escaped = String(prefix || ".").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = t.match(new RegExp(`^(?:${escaped}|/)?(vincular|sync|desvincular)\\b\\s*([A-Za-z0-9]{4,10})?\\s*$`, "i"));
  if (!m) return null;
  // Sem prefixo, só vale se vier com código (senão "vincular" solto numa frase vira comando).
  if (!/^[./]/.test(t) && !m[2]) return null;
  return { action: m[1].toLowerCase() === "desvincular" ? "unlink" : "link", code: m[2]?.toUpperCase() ?? null };
}
