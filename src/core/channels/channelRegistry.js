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
        participantJids: {},
        /** LID local → telefone (participantPn) */
        participantPhones: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    );
  }

  recordParticipantJid(channelId, phone = "", fullJid = "") {
    const id = String(phone ?? "").trim();
    const jid = String(fullJid ?? "").trim();
    if (!id || !jid || !jid.includes("@")) return this.get(channelId);
    const current = this.get(channelId);
    const participantJids = { ...(current.participantJids ?? {}), [id]: jid };
    return this.upsert(channelId, { participantJids });
  }

  /** Vincula LID do grupo ao telefone real quando o Baileys expõe participantPn. */
  recordParticipantLink(channelId, lidOrLocal = "", phone = "") {
    const lid = String(lidOrLocal ?? "").trim().replace(/@.+$/, "");
    const tel = String(phone ?? "").trim().replace(/@.+$/, "");
    if (!lid || !tel) return this.get(channelId);
    const current = this.get(channelId);
    const participantPhones = { ...(current.participantPhones ?? {}), [lid]: tel };
    const participantJids = {
      ...(current.participantJids ?? {}),
      [lid]: `${lid}@lid`,
      [tel]: `${tel}@s.whatsapp.net`
    };
    return this.upsert(channelId, { participantPhones, participantJids });
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

  syncGroupParticipants(remoteJid, participantIds = [], action = "add") {
    const id = normalizeChannelId(remoteJid);
    const current = this.get(id);
    let participants = [...(current.participants ?? [])];
    const incoming = (Array.isArray(participantIds) ? participantIds : [])
      .map((p) => String(p ?? "").replace(/@.+$/, "").replace(/:\d+$/, "").trim())
      .filter(Boolean);

    if (action === "remove") {
      participants = participants.filter((p) => !incoming.includes(p));
    } else {
      for (const p of incoming) {
        if (!participants.includes(p)) participants.push(p);
      }
    }

    return this.upsert(id, {
      isGroup: true,
      participants,
      participantCount: participants.length,
      mode: participants.length >= this.largeGroupSize ? "passive" : "active"
    });
  }

  shouldRespond({
    channelId,
    userId = "default",
    isDirectMention = false,
    isReply = false,
    isQuestion = false,
    groupEngagementActive = false
  } = {}) {
    const channel = this.get(channelId, userId);
    if (!channel.authorized || channel.mode === "blocked" || channel.muted) {
      return { allowed: false, reason: "blocked" };
    }

    if (channel.mode !== "passive") {
      return { allowed: true, reason: channel.mode, mode: "full" };
    }

    if (isDirectMention || isReply || groupEngagementActive) {
      return { allowed: true, reason: groupEngagementActive ? "passive-engagement" : "passive-direct", mode: "full" };
    }

    if (isQuestion) {
      return { allowed: true, reason: "passive-question", mode: "full" };
    }

    if (Math.random() < 0.18) {
      return { allowed: true, reason: "passive-random", mode: "react_only" };
    }

    return { allowed: false, reason: "passive-ignore" };
  }
}
