import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const EMPTY_SCOPE = {
  stickers: {},
  reactions: {},
  mediaTypes: { image: 0, video: 0, audio: 0, sticker: 0 },
  clusters: []
};

const DEFAULT_AFFINITIES = {
  scopes: {},
  stickers: {},
  reactions: {},
  mediaTypes: { image: 0, video: 0, audio: 0, sticker: 0 },
  clusters: []
};

const MAX_STICKERS_PER_SCOPE = 40;
const MAX_CLUSTERS_PER_SCOPE = 12;

export class MediaLearningHub {
  constructor(path, { bus = null, visionAdapter = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.visionAdapter = visionAdapter;
    this.data = readJson(path, DEFAULT_AFFINITIES) ?? structuredClone(DEFAULT_AFFINITIES);
    this.data.scopes ??= {};
    this.migrateLegacyGlobal();
  }

  migrateLegacyGlobal() {
    const legacyStickers = this.data.stickers ?? {};
    if (!Object.keys(legacyStickers).length) return;
    const legacy = this.ensureScope("__legacy_global__");
    for (const [hash, info] of Object.entries(legacyStickers)) {
      legacy.stickers[hash] = { ...info };
    }
    this.data.stickers = {};
    this.save();
  }

  scopeKey(context = {}) {
    const userId = String(context.userId ?? "default");
    const channelId = String(context.channelId ?? "").trim();
    const isGroup = Boolean(context.isGroup) || channelId.includes("@g.us");
    if (isGroup && channelId) return `group:${channelId}:user:${userId}`;
    return `user:${userId}`;
  }

  ensureScope(key) {
    if (!this.data.scopes[key]) {
      this.data.scopes[key] = structuredClone(EMPTY_SCOPE);
    }
    this.data.scopes[key].stickers ??= {};
    this.data.scopes[key].reactions ??= {};
    this.data.scopes[key].mediaTypes ??= { image: 0, video: 0, audio: 0, sticker: 0 };
    this.data.scopes[key].clusters ??= [];
    return this.data.scopes[key];
  }

  save() {
    writeJson(this.path, this.data);
  }

  learnFromMedia(media = {}, context = {}) {
    const scope = this.ensureScope(this.scopeKey(context));
    const type = media.type ?? "image";
    scope.mediaTypes[type] = (scope.mediaTypes[type] ?? 0) + 1;

    const perception = {
      type,
      tags: media.tags ?? media.semanticTags ?? [],
      emotionalTone: media.emotionalTone ?? "neutral",
      hash: media.hash ?? null,
      framesAnalyzed: media.framesAnalyzed ?? 1,
      userId: context.userId ?? null,
      channelId: context.channelId ?? null,
      scope: this.scopeKey(context),
      learnedAt: new Date().toISOString()
    };

    if (type === "sticker" && media.hash) {
      const key = media.hash;
      scope.stickers[key] = {
        count: (scope.stickers[key]?.count ?? 0) + 1,
        tags: perception.tags,
        lastSeen: perception.learnedAt
      };
      const stickerKeys = Object.keys(scope.stickers);
      if (stickerKeys.length > MAX_STICKERS_PER_SCOPE) {
        const sorted = stickerKeys.sort(
          (a, b) => (scope.stickers[a]?.count ?? 0) - (scope.stickers[b]?.count ?? 0)
        );
        for (const drop of sorted.slice(0, stickerKeys.length - MAX_STICKERS_PER_SCOPE)) {
          delete scope.stickers[drop];
        }
      }
    }

    if (perception.tags?.length) {
      const clusterKey = perception.tags.slice(0, 2).join("_");
      const existing = scope.clusters.find((c) => c.key === clusterKey);
      if (existing) {
        existing.count += 1;
      } else {
        scope.clusters.push({ key: clusterKey, tags: perception.tags, count: 1 });
      }
      if (scope.clusters.length > MAX_CLUSTERS_PER_SCOPE) {
        scope.clusters.sort((a, b) => b.count - a.count);
        scope.clusters = scope.clusters.slice(0, MAX_CLUSTERS_PER_SCOPE);
      }
    }

    this.save();
    this.bus?.emit("media.learned", { perception, context });
    return perception;
  }

  learnReaction(emoji, context = {}) {
    const scope = this.ensureScope(this.scopeKey(context));
    const key = String(emoji ?? "").trim();
    if (!key) return null;
    scope.reactions[key] = {
      count: (scope.reactions[key]?.count ?? 0) + 1,
      userId: context.userId ?? null,
      channelId: context.channelId ?? null,
      lastAt: new Date().toISOString()
    };
    this.save();
    return scope.reactions[key];
  }

  async analyzeMultiFrame(media = {}, context = {}) {
    const frames = media.frames ?? (media.path ? [media.path] : []);
    const slice = frames.slice(0, 5);
    const tags = new Set(media.tags ?? []);
    let emotionalTone = media.emotionalTone ?? "neutral";

    for (const frame of slice) {
      if (!this.visionAdapter?.analyze) continue;
      try {
        const result = await this.visionAdapter.analyze({ filePath: frame, mediaType: media.type ?? "image" });
        (result?.tags ?? result?.semanticTags ?? []).forEach((t) => tags.add(t));
        if (result?.emotionalTone) emotionalTone = result.emotionalTone;
      } catch {
        /* skip frame */
      }
    }

    return this.learnFromMedia(
      {
        ...media,
        tags: [...tags],
        emotionalTone,
        framesAnalyzed: slice.length || 1
      },
      context
    );
  }

  async analyze(media = {}, context = {}) {
    const hasFrames = (media.frames?.length ?? 0) > 1 || ["video", "gif"].includes(media.type);
    if (hasFrames) {
      return this.analyzeMultiFrame(media, context);
    }
    if (this.visionAdapter?.analyze && media.path) {
      try {
        const result = await this.visionAdapter.analyze(media);
        return this.learnFromMedia({ ...media, ...result }, context);
      } catch {
        /* fallback */
      }
    }
    return this.learnFromMedia(media, context);
  }

  getAffinities(context = {}) {
    const scopeKey =
      typeof context === "string"
        ? context
        : this.scopeKey(context);
    const scope = this.ensureScope(scopeKey);
    const topStickers = Object.entries(scope.stickers)
      .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
      .slice(0, 5)
      .map(([hash, info]) => ({ hash, ...info }));
    const topReactions = Object.entries(scope.reactions)
      .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
      .slice(0, 5)
      .map(([emoji, info]) => ({ emoji, ...info }));
    return {
      scope: scopeKey,
      userId: context?.userId ?? null,
      channelId: context?.channelId ?? null,
      topStickers,
      topReactions,
      mediaTypes: { ...scope.mediaTypes },
      clusters: [...(scope.clusters ?? [])].slice(0, 5)
    };
  }

  timingHint(context = {}) {
    const aff = this.getAffinities(context);
    const stickerHeavy = (aff.mediaTypes.sticker ?? 0) > (aff.mediaTypes.image ?? 0);
    return {
      readDelayBoost: stickerHeavy ? 400 : 1200,
      note: stickerHeavy ? "sticker_familiar" : "media_varied"
    };
  }

  preferredReactionEmoji(context = {}) {
    const aff = this.getAffinities(context);
    return aff.topReactions[0]?.emoji ?? null;
  }

  tick(context = {}) {
    return this.getAffinities(context);
  }
}
