import { readJson, writeJson } from "../../infra/utils/fileStore.js";

function normalizeChannelId(channelId, userId = "default") {
  const raw = String(channelId ?? "").trim();
  if (raw) return raw;
  return `direct:${String(userId ?? "default").trim() || "default"}`;
}

export class ChannelRegistry {
  constructor(path, { largeGroupSize = 4 } = {}) {
    this.path = path;
    this.largeGroupSize = largeGroupSize;
    this.data = readJson(this.path, { channels: {} });
    this.data.channels ??= {};
  }

  get(channelId, userId = "default") {
    const id = normalizeChannelId(channelId, userId);
    return (
      this.data.channels[id] ?? {
        id,
        mode: "active",
        authorized: true,
        muted: false,
        isGroup: id.includes("@g.us") || id.startsWith("group:"),
        participants: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    );
  }

  upsert(channelId, patch = {}, userId = "default") {
    const current = this.get(channelId, userId);
    const next = {
      ...current,
      ...patch,
      id: current.id,
      updatedAt: new Date().toISOString()
    };
    this.data.channels[current.id] = next;
    writeJson(this.path, this.data);
    return next;
  }

  applyMessageContext({ channelId, userId = "default", isGroup = false, participants = [] } = {}) {
    const current = this.get(channelId, userId);
    const safeParticipants = Array.isArray(participants)
      ? [...new Set(participants.map((item) => String(item ?? "").trim()).filter(Boolean))]
      : current.participants ?? [];

    const nextMode = isGroup && safeParticipants.length >= this.largeGroupSize
      ? current.mode === "muted" || current.mode === "blocked"
        ? current.mode
        : "passive"
      : current.mode === "passive"
        ? "active"
        : current.mode;

    return this.upsert(channelId, {
      isGroup,
      participants: safeParticipants,
      participantCount: safeParticipants.length,
      mode: nextMode
    }, userId);
  }

  shouldRespond({ channelId, userId = "default", isDirectMention = false, isReply = false, isQuestion = false } = {}) {
    const channel = this.get(channelId, userId);
    if (!channel.authorized || channel.mode === "blocked" || channel.muted) {
      return { allowed: false, reason: "blocked" };
    }

    if (channel.mode !== "passive") {
      return { allowed: true, reason: channel.mode, mode: "full" };
    }

    if (isDirectMention || isReply) {
      return { allowed: true, reason: "passive-direct", mode: "full" };
    }

    if (isQuestion && Math.random() < 0.55) {
      return {
        allowed: true,
        reason: "passive-question",
        mode: Math.random() < 0.25 ? "react_only" : "full"
      };
    }

    if (Math.random() < 0.18) {
      return { allowed: true, reason: "passive-random", mode: "react_only" };
    }

    return { allowed: false, reason: "passive-ignore" };
  }
}
