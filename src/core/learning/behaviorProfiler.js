import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_STATE = {
  users: {}
};

function hourFromTs(ts) {
  return Number(new Date(ts).toISOString().slice(11, 13));
}

function ensureUser(state, userId) {
  state.users[userId] ??= {
    totals: {
      events: 0,
      messages: 0,
      reactions: 0,
      media: 0,
      links: 0
    },
    byHour: {},
    byChat: {},
    responseLatencyMs: []
  };
  return state.users[userId];
}

export class BehaviorProfiler {
  constructor(path, { targetUserId = "" } = {}) {
    this.path = path;
    this.targetUserId = String(targetUserId ?? "").trim();
    this.state = readJson(path, DEFAULT_STATE) ?? DEFAULT_STATE;
    this.lastInboundByChat = new Map();
  }

  record(event = {}) {
    const actorId = String(event.actorId ?? event.userId ?? "");
    if (!actorId) return;
    const user = ensureUser(this.state, actorId);
    user.totals.events += 1;
    const hour = hourFromTs(event.ts ?? Date.now());
    user.byHour[hour] = (user.byHour[hour] ?? 0) + 1;
    const chatKey = String(event.remoteJid ?? event.channelId ?? "unknown");
    user.byChat[chatKey] = (user.byChat[chatKey] ?? 0) + 1;

    if (event.eventType === "message.incoming") user.totals.messages += 1;
    if (event.eventType === "message.reaction") user.totals.reactions += 1;
    if (event.mediaType) user.totals.media += 1;
    if (Array.isArray(event.links) && event.links.length) user.totals.links += event.links.length;

    if (event.eventType === "message.incoming" && actorId !== this.targetUserId) {
      this.lastInboundByChat.set(chatKey, Date.parse(event.ts ?? new Date().toISOString()));
    }
    if (event.eventType === "message.incoming" && actorId === this.targetUserId) {
      const lastInbound = this.lastInboundByChat.get(chatKey);
      const at = Date.parse(event.ts ?? new Date().toISOString());
      if (Number.isFinite(lastInbound) && at >= lastInbound) {
        const latency = at - lastInbound;
        if (latency >= 0 && latency < 1000 * 60 * 60 * 24) {
          user.responseLatencyMs.push(latency);
          user.responseLatencyMs = user.responseLatencyMs.slice(-500);
        }
      }
    }
    writeJson(this.path, this.state);
  }

  snapshot() {
    const target = ensureUser(this.state, this.targetUserId || "default");
    const latencies = target.responseLatencyMs;
    const avgLatencyMs = latencies.length
      ? Math.round(latencies.reduce((acc, n) => acc + n, 0) / latencies.length)
      : null;
    return {
      targetUserId: this.targetUserId || null,
      totals: target.totals,
      byHour: target.byHour,
      byChat: target.byChat,
      avgLatencyMs
    };
  }
}
