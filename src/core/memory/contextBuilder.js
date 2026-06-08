function fixEncoding(text) {
  const s = String(text ?? "");
  if (!/Ã|Â|â€™|Ã©|Ã£/.test(s)) return s;
  try {
    return Buffer.from(s, "latin1").toString("utf8");
  } catch {
    return s;
  }
}

function normalizeContent(entry) {
  return fixEncoding(String(entry?.content ?? entry?.value ?? "")).toLowerCase().trim();
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.userId ?? "default"}|${normalizeContent(entry)}`;
    if (!normalizeContent(entry) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function recencyScore(entry, now = Date.now()) {
  const ts = entry.timestamp ? Date.parse(entry.timestamp) : 0;
  if (!ts || Number.isNaN(ts)) return 0.1;
  const ageMs = Math.max(0, now - ts);
  return 1 / (1 + ageMs / (7 * 24 * 3600000));
}

export class ContextBuilder {
  constructor(longTerm, { selectiveMemory = null, groupMemory = null } = {}) {
    this.longTerm = longTerm;
    this.selectiveMemory = selectiveMemory;
    this.groupMemory = groupMemory;
  }

  build(userMessage, limit = 5, userId = "default", options = {}) {
    const {
      channelId = null,
      sessionId = null,
      channelScope = channelId ? `group:${channelId}` : "direct",
      isGroup = false
    } = options;
    const message = String(userMessage ?? "").toLowerCase();
    const safeUserId = String(userId ?? "default");

    let entries = this.longTerm.byUser
      ? this.longTerm.byUser(safeUserId)
      : this.longTerm
          .all()
          .filter((entry) => String(entry?.userId ?? "default") === safeUserId);

    if (channelScope !== "direct") {
      entries = entries.filter(
        (entry) => !entry.channelScope || entry.channelScope === channelScope || entry.channelScope === "direct"
      );
    }

    const searchHits = this.longTerm.search?.({ query: message }) ?? [];
    const merged = dedupeEntries([...entries, ...searchHits.filter((e) => String(e.userId ?? "default") === safeUserId)]);

    const scored = merged.map((entry) => {
      const tags = Array.isArray(entry.tags)
        ? entry.tags.map((tag) => String(tag).toLowerCase())
        : [String(entry.tag ?? "").toLowerCase()].filter(Boolean);
      const content = normalizeContent(entry);
      const tagHit = tags.some((tag) => tag && message.includes(tag)) ? 2 : 0;
      const contentHit = content
        ? Number(
            content
              .split(/\s+/)
              .filter((token) => token.length > 2)
              .some((token) => message.includes(token))
          )
        : 0;
      const scopeHit = entry.channelScope === channelScope ? 0.5 : 0;
      const score = tagHit + contentHit + recencyScore(entry) + scopeHit;
      return { entry, score };
    });

    const longTerm = dedupeEntries(
      scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((item) => item.entry)
    );

    const mediumTerm = this.longTerm.getMediumTerm(safeUserId, channelScope).slice(-3);
    const profile = this.longTerm.getProfile(safeUserId, channelScope);

    const selective = this.selectiveMemory?.byScope
      ? this.selectiveMemory.byScope({ userId: safeUserId, channelId: channelId ?? `direct:${safeUserId}` }).slice(-4)
      : [];

    let groupContext = [];
    let reactivated = [];
    if (isGroup && channelId && this.groupMemory) {
      groupContext = this.groupMemory.byChannel(channelId, { limit: 8 });
      if (message) {
        reactivated = this.groupMemory.recall(channelId, message);
      }
    }

    return {
      longTerm,
      mediumTerm,
      profile,
      selective,
      groupContext,
      reactivated,
      channelScope,
      sessionId
    };
  }
}
