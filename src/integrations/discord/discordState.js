import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { CHANNEL_MODES, DEFAULT_RATE } from "./discordPolicy.js";

/**
 * Estado do Discord que sobrevive a reinício: modo de cada canal (off / padrão / livre) com o ritmo da
 * conversa livre, canais em que mandaram ela ficar quieta e o "some do Discord" geral.
 */
export class DiscordStateStore {
  constructor(path = "./data/discord/state.json", { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    this.data = readJson(path, { channels: {}, muted: {}, mutedAll: 0 });
    this.data.channels ??= {};
    this.data.muted ??= {};
    // Versão antiga: { freeChat: { canal: {...} } } → modo livre.
    for (const [id, row] of Object.entries(this.data.freeChat ?? {})) {
      this.data.channels[id] ??= { mode: "livre", ...DEFAULT_RATE, by: row.by ?? null, guildId: row.guildId ?? null, name: row.name ?? null, at: row.at ?? null };
    }
    delete this.data.freeChat;
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  /** Configuração do canal (sem nada salvo: modo padrão). */
  channel(channelId) {
    const row = this.data.channels[String(channelId)];
    return { mode: "padrao", ...DEFAULT_RATE, ...(row ?? {}) };
  }

  modeOf(channelId) {
    return this.channel(channelId).mode;
  }

  configure(channelId, patch = {}, meta = {}) {
    const key = String(channelId);
    const next = { ...this.channel(key), ...meta, at: new Date(this.now()).toISOString() };
    if (patch.mode && CHANNEL_MODES.includes(patch.mode)) next.mode = patch.mode;
    const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
    if (Number.isFinite(patch.replies)) next.replies = int(patch.replies, 1, 100);
    if (Number.isFinite(patch.every)) next.every = int(patch.every, 1, 100);
    if (Number.isFinite(patch.tagReplies)) next.tagReplies = int(patch.tagReplies, 1, 100);
    if (Number.isFinite(patch.tagEvery)) next.tagEvery = int(patch.tagEvery, 1, 100);
    // "3 a cada 2" não existe: vira sempre.
    next.replies = Math.min(next.replies, next.every);
    next.tagReplies = Math.min(next.tagReplies, next.tagEvery);
    this.data.channels[key] = next;
    this.save();
    return next;
  }

  /** Volta o canal pro padrão (modo padrão, chances padrão). */
  reset(channelId) {
    delete this.data.channels[String(channelId)];
    this.save();
    return this.channel(channelId);
  }

  /** Quieta até `ms` a partir de agora. Escopo "discord" = todos os canais. */
  mute(channelId, ms, { scope = "channel" } = {}) {
    const until = this.now() + Math.max(0, ms);
    if (scope === "discord") this.data.mutedAll = until;
    else this.data.muted[String(channelId)] = until;
    this.save();
    return until;
  }

  unmute(channelId, { all = false } = {}) {
    delete this.data.muted[String(channelId)];
    if (all) this.data.mutedAll = 0;
    this.save();
  }

  /** Até quando está quieta nesse canal (0 = não está). Leva em conta o "some do Discord". */
  mutedUntil(channelId) {
    const now = this.now();
    const local = this.data.muted[String(channelId)] ?? 0;
    if (local && local <= now) {
      delete this.data.muted[String(channelId)];
      this.save();
    }
    const all = this.data.mutedAll ?? 0;
    return Math.max(local > now ? local : 0, all > now ? all : 0);
  }
}
