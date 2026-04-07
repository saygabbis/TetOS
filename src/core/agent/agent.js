export class Agent {
  constructor({ personality, shortTerm, longTerm, brain, contextBuilder }) {
    this.personality = personality;
    this.shortTerm = shortTerm;
    this.longTerm = longTerm;
    this.brain = brain;
    this.contextBuilder = contextBuilder;
  }

  buildPrompt(userMessage, longTermEntries, meta = {}, history = null) {
    const memoryText = longTermEntries
      .map((entry) => {
        const tags = Array.isArray(entry.tags)
          ? entry.tags.join(", ")
          : entry.tag;
        return `- ${tags}: ${entry.content}`;
      })
      .join("\n");

    const sessionKey = meta.sessionId ?? "default";
    const historySource = Array.isArray(history)
      ? history
      : this.shortTerm.getAll(sessionKey);
    const conversationText = historySource
      .map((msg) => {
        const metaText = msg.meta
          ? ` (${Object.entries(msg.meta)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ")})`
          : "";
        return `${msg.role}${metaText}: ${msg.content}`;
      })
      .join("\n");

    const metaBlock = Object.keys(meta).length
      ? ["[META]", Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")]
      : [];

    const systemBlock = [
      "[SYSTEM]",
      `Identity: ${this.personality.identity?.join(" ") ?? ""}`,
      `Tone: ${this.personality.tone}.`,
      `Style: ${this.personality.style?.join("; ") ?? ""}.`,
      `Traits: ${this.personality.traits?.join("; ") ?? ""}.`,
      `Quirks: ${this.personality.quirks?.join("; ") ?? ""}.`,
      `Social: ${this.personality.social?.join("; ") ?? ""}.`,
      `Communication: ${this.personality.communication?.join("; ") ?? ""}.`,
      `Intelligence: ${this.personality.intelligence?.join("; ") ?? ""}.`,
      `Restrictions: ${this.personality.restrictions?.join(" ") ?? ""}.`
    ].filter(Boolean);

    const memoryBlock = memoryText
      ? ["[MEMORY]", memoryText]
      : [];

    const conversationBlock = conversationText
      ? ["[RECENT CONVERSATION]", conversationText]
      : [];

    return [
      ...systemBlock,
      ...memoryBlock,
      ...conversationBlock,
      ...metaBlock,
      "[INPUT]",
      `User: ${userMessage}`,
      "[OUTPUT]",
      "Reply as the assistant:"
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async respond(userMessage, meta = {}, history = null) {
    const relevant = this.contextBuilder
      ? this.contextBuilder.build(userMessage)
      : this.longTerm.all().slice(-5);
    const prompt = this.buildPrompt(userMessage, relevant, meta, history);
    const reply = await this.brain.generate(prompt);

    const sessionKey = meta.sessionId ?? "default";
    this.shortTerm.add({ role: "user", content: userMessage, meta }, sessionKey);
    this.shortTerm.add({ role: "assistant", content: reply, meta }, sessionKey);

    return reply;
  }
}
