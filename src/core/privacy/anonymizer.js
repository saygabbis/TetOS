import crypto from "node:crypto";

function hashToken(value) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 12);
}

function matchesOwnerIdentity(value, ownerIds = []) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  for (const id of ownerIds) {
    const needle = String(id ?? "").trim();
    if (needle && (raw === needle || raw.includes(needle))) return true;
  }
  return false;
}

export class PrivacyAnonymizer {
  constructor({ mode = "strong", targetUserId = "", ownerIds = [] } = {}) {
    this.mode = mode;
    this.targetUserId = String(targetUserId ?? "").trim();
    this.ownerIds = new Set(
      [this.targetUserId, ...ownerIds].map((id) => String(id ?? "").trim()).filter(Boolean)
    );
  }

  anonymizeIdentity(value) {
    const raw = String(value ?? "");
    if (!raw) return raw;
    if (matchesOwnerIdentity(raw, this.ownerIds)) return raw;
    if (this.mode === "none") return raw;
    return `anon_${hashToken(raw)}`;
  }

  anonymizeEvent(event = {}) {
    const out = { ...event };
    out.userId = this.anonymizeIdentity(out.userId);
    out.actorId = this.anonymizeIdentity(out.actorId);
    out.remoteJid = this.anonymizeIdentity(out.remoteJid);
    out.participantId = this.anonymizeIdentity(out.participantId);
    if (Array.isArray(out.participants)) {
      out.participants = out.participants.map((id) => this.anonymizeIdentity(id));
    }
    if (typeof out.pushName === "string" && out.pushName.trim()) {
      out.pushName = this.mode === "none" ? out.pushName : `anon_name_${hashToken(out.pushName)}`;
    }
    return out;
  }
}
