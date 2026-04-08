export class ContextBuilder {
  constructor(longTerm) {
    this.longTerm = longTerm;
  }

  build(userMessage, limit = 5, userId = "default") {
    const message = String(userMessage ?? "").toLowerCase();
    const entries = this.longTerm.byUser
      ? this.longTerm.byUser(userId)
      : this.longTerm
          .all()
          .filter((entry) => String(entry?.userId ?? "default") === String(userId ?? "default"));

    const scored = entries.map((entry, index) => {
      const tags = Array.isArray(entry.tags)
        ? entry.tags.map((tag) => String(tag).toLowerCase())
        : [String(entry.tag ?? "").toLowerCase()].filter(Boolean);
      const content = String(entry.content ?? entry.value ?? "").toLowerCase();
      const tagHit = tags.some((tag) => tag && message.includes(tag)) ? 2 : 0;
      const contentHit = content
        ? Number(
            content
              .split(/\s+/)
              .filter((token) => token.length > 2)
              .some((token) => message.includes(token))
          )
        : 0;
      const recency = index / Math.max(entries.length - 1, 1);
      const score = tagHit + contentHit + recency;

      return { entry, score };
    });

    const longTerm = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);

    const mediumTerm = this.longTerm.getMediumTerm(userId).slice(-3);
    const profile = this.longTerm.getProfile(userId);

    return { longTerm, mediumTerm, profile };
  }
}
