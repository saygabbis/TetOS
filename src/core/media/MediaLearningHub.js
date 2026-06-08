import { readJson, writeJson } from "../../infra/utils/fileStore.js";

const DEFAULT_AFFINITIES = {
  stickers: {},
  reactions: {},
  mediaTypes: { image: 0, video: 0, audio: 0, sticker: 0 },
  clusters: []
};

export class MediaLearningHub {
  constructor(path, { bus = null, visionAdapter = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.visionAdapter = visionAdapter;
    this.data = readJson(path, DEFAULT_AFFINITIES) ?? structuredClone(DEFAULT_AFFINITIES);
    this.data.stickers ??= {};
    this.data.reactions ??= {};
    this.data.mediaTypes ??= { image: 0, video: 0, audio: 0, sticker: 0 };
  }

  save() {
    writeJson(this.path, this.data);
  }

  learnFromMedia(media = {}, context = {}) {
    const type = media.type ?? "image";
    this.data.mediaTypes[type] = (this.data.mediaTypes[type] ?? 0) + 1;

    const perception = {
      type,
      tags: media.tags ?? media.semanticTags ?? [],
      emotionalTone: media.emotionalTone ?? "neutral",
      hash: media.hash ?? null,
      framesAnalyzed: media.framesAnalyzed ?? 1,
      userId: context.userId ?? null,
      learnedAt: new Date().toISOString()
    };

    if (type === "sticker" && media.hash) {
      const key = media.hash;
      this.data.stickers[key] = {
        count: (this.data.stickers[key]?.count ?? 0) + 1,
        tags: perception.tags,
        lastSeen: perception.learnedAt
      };
    }

    if (perception.tags?.length) {
      const clusterKey = perception.tags.slice(0, 2).join("_");
      const existing = this.data.clusters.find((c) => c.key === clusterKey);
      if (existing) {
        existing.count += 1;
      } else {
        this.data.clusters.push({ key: clusterKey, tags: perception.tags, count: 1 });
      }
      if (this.data.clusters.length > 30) {
        this.data.clusters.sort((a, b) => b.count - a.count);
        this.data.clusters = this.data.clusters.slice(0, 30);
      }
    }

    this.save();
    this.bus?.emit("media.learned", { perception, context });
    return perception;
  }

  learnReaction(emoji, context = {}) {
    const key = String(emoji ?? "").trim();
    if (!key) return null;
    this.data.reactions[key] = {
      count: (this.data.reactions[key]?.count ?? 0) + 1,
      userId: context.userId ?? null,
      lastAt: new Date().toISOString()
    };
    this.save();
    return this.data.reactions[key];
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

    return this.learnFromMedia({
      ...media,
      tags: [...tags],
      emotionalTone,
      framesAnalyzed: slice.length || 1
    }, context);
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

  getAffinities(userId = null) {
    const topStickers = Object.entries(this.data.stickers)
      .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
      .slice(0, 5)
      .map(([hash, info]) => ({ hash, ...info }));
    const topReactions = Object.entries(this.data.reactions)
      .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
      .slice(0, 5)
      .map(([emoji, info]) => ({ emoji, ...info }));
    return {
      userId,
      topStickers,
      topReactions,
      mediaTypes: { ...this.data.mediaTypes },
      clusters: [...(this.data.clusters ?? [])].slice(0, 5)
    };
  }

  timingHint() {
    const stickerHeavy = (this.data.mediaTypes.sticker ?? 0) > (this.data.mediaTypes.image ?? 0);
    return {
      readDelayBoost: stickerHeavy ? 400 : 1200,
      note: stickerHeavy ? "sticker_familiar" : "media_varied"
    };
  }

  preferredReactionEmoji() {
    const top = Object.entries(this.data.reactions)
      .sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))[0];
    return top?.[0] ?? null;
  }

  tick() {
    return this.getAffinities();
  }
}
