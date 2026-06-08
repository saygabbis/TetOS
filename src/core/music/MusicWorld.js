import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, chance, pick } from "../brain/rng.js";

const DEFAULT_DISCOGRAPHY = {
  anchor: "machine_love",
  tracks: [
    { id: "machine_love", title: "Machine Love", artist: "Jamie Paige feat. Kasane Teto", era: "synthv", weight: 1 },
    { id: "tetoris", title: "テトリス", artist: "Kasane Teto", era: "viral", weight: 0.9 },
    { id: "override", title: "Override", artist: "Kasane Teto", era: "synthv", weight: 0.7 }
  ],
  listens: ["vocaloid classics", "electronic", "j-pop", "producer drafts"]
};

const DEFAULT_MUSIC_STATE = {
  favoriteAnchor: "machine_love",
  nowPlaying: null,
  activity: "idle",
  pendingComment: null,
  lastResearchAt: null,
  discovered: [],
  affinity: { machine_love: 0.95, tetoris: 0.85 }
};

export class MusicWorld {
  constructor(discographyPath, statePath, { bus = null, searchAdapter = null } = {}) {
    this.discographyPath = discographyPath;
    this.statePath = statePath;
    this.bus = bus;
    this.searchAdapter = searchAdapter;
    this.discography = readJson(discographyPath, DEFAULT_DISCOGRAPHY) ?? DEFAULT_DISCOGRAPHY;
    this.state = readJson(statePath, DEFAULT_MUSIC_STATE) ?? { ...DEFAULT_MUSIC_STATE };
    this.state.favoriteAnchor ??= "machine_love";
    this.state.affinity ??= { machine_love: 0.95 };
  }

  saveState() {
    writeJson(this.statePath, this.state);
  }

  getSnapshot() {
    return {
      ...this.state,
      anchorTrack: this.getAnchorTrack()
    };
  }

  getAnchorTrack() {
    const id = this.state.favoriteAnchor ?? "machine_love";
    return (this.discography.tracks ?? []).find((t) => t.id === id) ?? null;
  }

  getCurrentActivity() {
    if (this.state.activity === "practicing") return "ensaiando vocal";
    if (this.state.activity === "listening") return `ouvindo ${this.state.nowPlaying ?? "música"}`;
    if (this.state.activity === "mixing") return "mixando faixa";
    return null;
  }

  setActivity(activity, track = null) {
    this.state.activity = activity;
    if (track) this.state.nowPlaying = track;
    this.saveState();
    this.bus?.emit("music.activity_changed", { activity, track });
  }

  pickListening(phase, seed) {
    const tracks = this.discography.tracks ?? [];
    const weighted = tracks.flatMap((t) => Array(Math.ceil((t.weight ?? 0.5) * 10)).fill(t));
    const track = pick(seed, weighted) ?? tracks[0];
    return track?.title ?? "música";
  }

  async research({ query = "Kasane Teto new release" } = {}) {
    if (!this.searchAdapter?.search) {
      return { found: false, reason: "no_adapter" };
    }
    try {
      const results = await this.searchAdapter.search(query);
      const top = results?.[0];
      if (top) {
        const discovery = {
          title: top.title ?? top.snippet ?? "novidade",
          url: top.url ?? null,
          foundAt: new Date().toISOString()
        };
        this.state.discovered.push(discovery);
        if (this.state.discovered.length > 30) {
          this.state.discovered = this.state.discovered.slice(-30);
        }
        this.state.pendingComment = {
          about: discovery.title,
          discoveredAt: discovery.foundAt,
          commentAfter: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString()
        };
        this.state.lastResearchAt = new Date().toISOString();
        this.saveState();
        this.bus?.emit("music.new_release_found", discovery);
        return { found: true, discovery };
      }
    } catch {
      /* ignore */
    }
    return { found: false };
  }

  tick({ phase = "tarde", emotion = null } = {}) {
    const seed = contextualSeed([phase, this.state.activity, emotion?.mood]);
    const activities = ["listening", "practicing", "mixing", "idle"];
    const next = pick(seed, activities);

    if (next === "listening") {
      const title = this.pickListening(phase, seed);
      this.setActivity("listening", title);
    } else if (next === "practicing" && chance(seed + 1, 0.4)) {
      const anchor = this.getAnchorTrack();
      this.setActivity("practicing", anchor?.title ?? "Machine Love");
    } else if (next === "mixing" && chance(seed + 2, 0.25)) {
      this.setActivity("mixing", "demo em progresso");
    }

    if (this.state.pendingComment?.commentAfter) {
      if (Date.parse(this.state.pendingComment.commentAfter) <= Date.now()) {
        this.state.pendingComment.ready = true;
        this.saveState();
      }
    }

    return this.getSnapshot();
  }
}
