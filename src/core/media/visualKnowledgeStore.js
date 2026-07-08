import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import crypto from "node:crypto";
import {
  extractVisionKeywords,
  scoreVisionMatch
} from "./visualKnowledgeIntent.js";

const DEFAULT_DATA = { entries: [], meta: { lastUpdated: null } };
const MAX_PER_SCOPE = 24;

export class VisualKnowledgeStore {
  constructor(path = "./data/visualKnowledge.json") {
    this.path = path;
    this.data = readJson(path, DEFAULT_DATA) ?? structuredClone(DEFAULT_DATA);
    this.data.entries ??= [];
  }

  save() {
    this.data.meta ??= {};
    this.data.meta.lastUpdated = new Date().toISOString();
    writeJson(this.path, this.data);
  }

  scopeKey(userId, channelId = null) {
    const uid = String(userId ?? "default");
    const cid = String(channelId ?? "").trim();
    return cid ? `${uid}::${cid}` : uid;
  }

  learn({
    userId = "default",
    channelId = null,
    label = "referência visual",
    visionText = "",
    taughtByText = "",
    messageId = null,
    confidence = 0.7
  } = {}) {
    const vision = String(visionText ?? "").trim();
    if (!vision) return null;

    const entry = {
      id: crypto.randomUUID(),
      userId: String(userId ?? "default"),
      channelId: channelId ? String(channelId) : null,
      scope: this.scopeKey(userId, channelId),
      label: String(label ?? "referência visual").slice(0, 80),
      keywords: extractVisionKeywords(vision),
      visionSample: vision.slice(0, 280),
      taughtByText: String(taughtByText ?? "").slice(0, 240),
      messageId: messageId ? String(messageId) : null,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0.7)),
      learnedAt: new Date().toISOString(),
      hits: 0
    };

    this.data.entries.push(entry);
    this.pruneScope(entry.scope);
    this.save();
    return entry;
  }

  pruneScope(scope) {
    const scoped = this.data.entries.filter((e) => e.scope === scope);
    if (scoped.length <= MAX_PER_SCOPE) return;
    const drop = scoped.length - MAX_PER_SCOPE;
    let removed = 0;
    this.data.entries = this.data.entries.filter((e) => {
      if (removed >= drop) return true;
      if (e.scope === scope) {
        removed += 1;
        return false;
      }
      return true;
    });
  }

  match(visionText = "", { userId = null, channelId = null, limit = 3, minScore = 0.28 } = {}) {
    const uid = String(userId ?? "");
    const cid = String(channelId ?? "");
    const rows = this.data.entries.filter((e) => {
      if (uid && e.userId !== uid) return false;
      if (cid && e.channelId && e.channelId !== cid) return false;
      return true;
    });
    const scored = rows
      .map((entry) => ({ entry, score: scoreVisionMatch(visionText, entry) }))
      .filter((row) => row.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));

    for (const row of scored) {
      row.entry.hits = (row.entry.hits ?? 0) + 1;
    }
    if (scored.length) this.save();

    return scored.map(({ entry, score }) => ({ ...entry, matchScore: score }));
  }

  formatForPrompt(matches = []) {
    if (!matches.length) return null;
    return matches
      .map((m) => {
        const label =
          m.label === "kasane_teto"
            ? "Kasane Teto (você)"
            : m.label;
        return `- «${label}» (aprendido${m.taughtByText ? `: "${m.taughtByText.slice(0, 80)}"` : ""}) — sinais: ${(m.keywords ?? []).slice(0, 8).join(", ")}`;
      })
      .join("\n");
  }
}
