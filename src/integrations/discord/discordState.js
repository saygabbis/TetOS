import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";

/**
 * Estado do Discord que sobrevive a reinício: canais com "conversa livre" ligada (ela participa do
 * papo sem precisar ser marcada) e canais em que mandaram ela ficar quieta.
 */
export class DiscordStateStore {
  constructor(path = "./data/discord/state.json", { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    this.data = readJson(path, { freeChat: {}, muted: {} });
    this.data.freeChat ??= {};
    this.data.muted ??= {};
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  isFreeChat(channelId) {
    return Boolean(this.data.freeChat[String(channelId)]);
  }

  setFreeChat(channelId, on, { by = null, guildId = null, name = null } = {}) {
    const key = String(channelId);
    if (on) this.data.freeChat[key] = { by, guildId, name, at: new Date(this.now()).toISOString() };
    else delete this.data.freeChat[key];
    this.save();
  }

  freeChatChannels(guildId = null) {
    return Object.entries(this.data.freeChat)
      .filter(([, row]) => !guildId || row.guildId === guildId)
      .map(([id, row]) => ({ id, ...row }));
  }

  /** Quieta até `until` (ms). */
  mute(channelId, ms) {
    this.data.muted[String(channelId)] = this.now() + Math.max(0, ms);
    this.save();
  }

  unmute(channelId) {
    delete this.data.muted[String(channelId)];
    this.save();
  }

  mutedUntil(channelId) {
    const until = this.data.muted[String(channelId)] ?? 0;
    if (until && until <= this.now()) {
      delete this.data.muted[String(channelId)];
      this.save();
      return 0;
    }
    return until;
  }
}
