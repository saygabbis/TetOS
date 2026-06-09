export class MemoryOrchestrator {
  constructor({
    shortTerm = null,
    longTerm = null,
    selectiveMemory = null,
    groupMemory = null,
    episodicMemory = null,
    multimodalMemory = null,
    visualAnalyses = null,
    contextBuilder = null,
    bus = null
  } = {}) {
    this.shortTerm = shortTerm;
    this.longTerm = longTerm;
    this.selectiveMemory = selectiveMemory;
    this.groupMemory = groupMemory;
    this.episodicMemory = episodicMemory;
    this.multimodalMemory = multimodalMemory;
    this.visualAnalyses = visualAnalyses;
    this.contextBuilder = contextBuilder;
    this.bus = bus;
  }

  buildRetrievalContext({ message, userId, channelId, sessionId, isGroup = false, query = null } = {}) {
    const channelScope = isGroup ? `group:${channelId}` : "direct";
    const retrieved = {
      working: [],
      episodic: [],
      semantic: [],
      selective: [],
      group: [],
      multimodal: [],
      reactivated: []
    };

    if (this.shortTerm?.getAll) {
      retrieved.working = this.shortTerm.getAll(sessionId).slice(-16);
    } else if (this.shortTerm?.all) {
      retrieved.working = this.shortTerm.all().slice(-16);
    }

    if (this.episodicMemory) {
      retrieved.episodic = this.episodicMemory.retrieve({
        userId,
        channelScope,
        query: query ?? message,
        limit: 8
      });
    }

    if (this.contextBuilder) {
      const built = this.contextBuilder.build(message, 6, userId, {
        channelId,
        sessionId,
        channelScope,
        isGroup
      });
      retrieved.semantic = built.longTerm ?? [];
      if (built.reactivated?.length) {
        retrieved.reactivated = [...retrieved.reactivated, ...built.reactivated];
      }
    } else if (this.longTerm?.byUser) {
      retrieved.semantic = this.longTerm.byUser(userId, channelScope).slice(-6);
    }

    if (this.selectiveMemory?.byScope) {
      retrieved.selective = this.selectiveMemory.byScope({ userId, channelId }).slice(-6);
    }

    if (isGroup && this.groupMemory) {
      retrieved.group = this.groupMemory.byChannel(channelId, { limit: 12 });
      if (message) {
        const recalled = this.groupMemory.recall(channelId, message);
        if (recalled.length) {
          retrieved.reactivated = recalled;
          this.bus?.emit("memory.triggered_recall", { channelId, recalled });
        }
      }
    }

    if (this.multimodalMemory?.list) {
      retrieved.multimodal = this.multimodalMemory.list(userId, channelId, 3) ?? [];
    }

    if (this.visualAnalyses?.latestByScope) {
      const visual = this.visualAnalyses.latestByScope(userId, channelId, 4) ?? [];
      retrieved.multimodal = [...retrieved.multimodal, ...visual.map((v) => ({
        type: "visual_analysis",
        summary: v.summary ?? v.description ?? v.tags?.join(", "),
        ts: v.timestamp ?? v.ts
      }))].slice(-6);
    }

    return {
      retrieved,
      buckets: this.episodicMemory?.byBuckets({ userId, channelScope }) ?? {},
      promptHints: this.formatPromptHints(retrieved)
    };
  }

  formatPromptHints(retrieved) {
    const blocks = [];
    const today = retrieved.episodic?.filter((e) => e.bucket === "hoje") ?? [];
    const week = retrieved.episodic?.filter((e) => e.bucket === "semana") ?? [];
    const salient = retrieved.selective?.slice(0, 4) ?? [];

    if (today.length) {
      blocks.push(`[MEMORY — HOJE]\n${today.map((e) => `- ${e.summary}`).join("\n")}`);
    }
    if (week.length) {
      blocks.push(`[MEMORY — SEMANA]\n${week.slice(0, 4).map((e) => `- ${e.summary}`).join("\n")}`);
    }
    if (salient.length) {
      blocks.push(`[MARCANTES]\n${salient.map((e) => `- ${e.content ?? e.summary}`).join("\n")}`);
    }
    if (retrieved.group?.length) {
      blocks.push(
        `[GRUPO — CONTEXTO RECENTE]\n${retrieved.group
          .slice(0, 12)
          .map((e) => {
            const who = e.speakerName || e.userId || "?";
            const mark = e.addressedToTeto ? "" : " (não era pra você)";
            return `- ${who}${mark}: ${e.text}`;
          })
          .join("\n")}`
      );
    }
    if (retrieved.reactivated?.length) {
      blocks.push(`[REATIVADO]\n${retrieved.reactivated.map((e) => `- ${e.text ?? e.summary}`).join("\n")}`);
    }
    return blocks;
  }

  recordEpisode(event = {}) {
    if (!this.episodicMemory) return null;
    const saved = this.episodicMemory.save(event);
    this.bus?.emit("memory.episode_saved", saved);
    return saved;
  }

  recordGroupMessage(entry) {
    if (!this.groupMemory) return null;
    return this.groupMemory.append(entry);
  }

  tick() {
    this.selectiveMemory?.cleanupExpired?.();
    return {
      episodic: this.episodicMemory?.cache?.length ?? 0,
      group: this.groupMemory?.cache?.length ?? 0
    };
  }
}
