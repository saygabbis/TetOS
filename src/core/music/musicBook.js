import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { askModel, clip, parseJsonLoose } from "../mind/mindText.js";

/**
 * Caderno de música da Teto: as músicas DELA (oficiais e virais), as que o pessoal fez com a voz dela
 * e os vídeos que ela viu. Ela aprende cada uma de verdade (acha o vídeo, lê legenda/descrição ou
 * transcreve o áudio, e anota do que fala, o que ela acha e uns versinhos curtos), conversa sobre elas
 * e manda o link quando acha que vale (sem repetir a mesma pra mesma pessoa).
 */

/** Ponto de partida: músicas conhecidas da Teto. O resto ela descobre (busca e o que mandam pra ela). */
export const SEED_SONGS = Object.freeze([
  { id: "machine_love", title: "Machine Love", artist: "Jamie Paige feat. Kasane Teto", query: "Jamie Paige Machine Love Kasane Teto" },
  { id: "override", title: "Override", artist: "Yoshida Yasei feat. Kasane Teto", query: "吉田夜世 オーバーライド 重音テト Override" },
  { id: "tetoris", title: "テトリス (Tetoris)", artist: "Hiiragi Magnetite feat. Kasane Teto", query: "柊マグネタイト テトリス 重音テト" },
  { id: "fukkireta", title: "吹っ切れた (Fukkireta)", artist: "Ajama feat. Kasane Teto", query: "吹っ切れた 重音テト Fukkireta" },
  { id: "mesmerizer", title: "メズマライザー (Mesmerizer)", artist: "32ki feat. Hatsune Miku & Kasane Teto", query: "32ki メズマライザー Mesmerizer" },
  { id: "teto_territory", title: "Teto Territory", artist: "Jamie Paige feat. Kasane Teto", query: "Teto Territory Kasane Teto" },
  { id: "triple_baka", title: "トリノコシティ / Triple Baka", artist: "LamazeP feat. Miku, Teto & Neru", query: "Triple Baka Miku Teto Neru" }
]);

const DAY = 86_400_000;
const MUSIC_WORDS = /(?<!\p{L})(m[uú]sica|musiquinha|can[çc][aã]o|cantar|canta|cantou|letra|clipe|single|[aá]lbum|cover|playlist|ouvir|ouvindo|escuta|escutando|synthv|utau|vocaloid|feat|ft\.)(?!\p{L})/iu;

const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);

/** O texto cita esse link? (YouTube compara pelo id do vídeo: watch?v=, youtu.be/, shorts/.) */
export function mentionsUrl(text = "", url = "") {
  const yt = (u) => String(u).match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1] ?? null;
  const id = yt(url);
  if (id) return String(text).includes(id);
  return String(text).includes(String(url).replace(/^https?:\/\/(www\.)?/, "").slice(0, 40));
}

export const isTetoRelated = (text = "") => /(kasane\s*teto|重音テト|(?<!\p{L})teto(?!\p{L})|テト)/iu.test(String(text));

export class MusicBook {
  constructor(path = "./data/mind/music.json", { now = () => Date.now() } = {}) {
    this.path = path;
    this.now = now;
    const data = path ? readJson(path, null) : null;
    this.data = { songs: [], watched: [], videos: [], ...(data ?? {}) };
    this.data.videos ??= [];
    for (const seed of SEED_SONGS) {
      if (!this.data.songs.some((s) => s.id === seed.id)) this.data.songs.push({ ...seed, source: "oficial", learnedAt: null, sharedWith: {} });
    }
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  songs() {
    return this.data.songs;
  }

  find(text = "") {
    const t = slug(text);
    if (!t) return null;
    return this.data.songs.find((s) => s.id === t || (slug(s.title).length > 3 && t.includes(slug(s.title))) || (s.url && text.includes(s.url))) ?? null;
  }

  /** Próxima pra estudar: oficial nunca aprendida primeiro; depois revisita a mais antiga (≥ 30 dias). */
  pickToLearn() {
    const fresh = this.data.songs.find((s) => !s.learnedAt && !s.failedAt) ?? this.data.songs.find((s) => !s.learnedAt && this.now() - Date.parse(s.failedAt ?? 0) > 3 * DAY);
    if (fresh) return fresh;
    const old = [...this.data.songs].filter((s) => s.learnedAt).sort((a, b) => Date.parse(a.learnedAt) - Date.parse(b.learnedAt))[0];
    return old && this.now() - Date.parse(old.learnedAt) > 30 * DAY ? old : null;
  }

  /**
   * Aprende uma música: acha o vídeo, "ouve" (legenda/descrição/transcrição) e anota no jeito dela.
   * @param {{ llm: any, reader: any, searchYoutube: Function, persona?: string }} deps
   */
  async learn(song, { llm, reader, searchYoutube, persona = "" }) {
    if (!song) return null;
    try {
      if (!song.url && searchYoutube) {
        const hits = await searchYoutube(song.query ?? `${song.title} ${song.artist ?? ""}`, { n: 5 });
        const best = hits.find((h) => isTetoRelated(`${h.title} ${h.channel}`) || slug(h.title).includes(slug(song.title).slice(0, 8))) ?? hits[0];
        if (best) Object.assign(song, { url: best.url, views: best.views, channel: best.channel, duration: best.duration });
      }
      if (!song.url) throw new Error("não achei o vídeo");
      const page = await reader?.read?.(song.url, { full: true }).catch(() => null);
      const heard = [page?.title, page?.text, page?.transcript].filter(Boolean).join("\n").slice(0, 6000);
      if (!heard) throw new Error("não consegui ouvir");
      const raw = await askModel(
        llm,
        [
          "Você é a Kasane Teto ouvindo uma música sua (ou feita com a sua voz) pra conhecer de verdade e saber conversar sobre ela.",
          persona ? `Quem você é: ${persona}` : "",
          `Música: ${song.title} — ${song.artist ?? "?"}`,
          "",
          "[O QUE VOCÊ OUVIU/LEU DO VÍDEO]",
          heard,
          "",
          "Responda SÓ um JSON:",
          '{"about":"do que a música fala, 1-2 frases suas","vibe":"o clima/estilo em poucas palavras","opinion":"o que VOCÊ acha dela, sincera, do seu jeito","lines":["até 3 versinhos curtos (máx 12 palavras cada) que ficaram na sua cabeça, na língua original"],"fun":"uma curiosidade ou algo que você gostaria de comentar com alguém"}',
          "Não invente letra: só use versos que aparecem no material. Se não tiver letra no material, deixe lines vazio."
        ]
          .filter(Boolean)
          .join("\n"),
        { timeoutMs: 120_000 }
      );
      const j = parseJsonLoose(raw);
      if (!j?.about) throw new Error("não entendi");
      Object.assign(song, {
        about: clip(j.about, 300),
        vibe: clip(j.vibe ?? "", 80),
        opinion: clip(j.opinion ?? "", 240),
        lines: (Array.isArray(j.lines) ? j.lines : []).map((l) => clip(l, 90)).filter(Boolean).slice(0, 3),
        fun: clip(j.fun ?? "", 200),
        learnedAt: new Date(this.now()).toISOString(),
        failedAt: null
      });
      this.save();
      return song;
    } catch (error) {
      song.failedAt = new Date(this.now()).toISOString();
      this.save();
      return null;
    }
  }

  /** Descobre música nova (lançamento ou viral) com a voz dela. */
  async discover({ searchYoutube }) {
    if (!searchYoutube) return null;
    const queries = ["Kasane Teto SynthV original song", "重音テトSV オリジナル曲", "Kasane Teto new song", "feat. 重音テト"];
    const q = queries[Math.floor(this.now() / DAY) % queries.length];
    const hits = await searchYoutube(q, { n: 8, recent: true }).catch(() => []);
    for (const h of hits) {
      if (!isTetoRelated(`${h.title} ${h.channel}`) || (h.duration && (h.duration < 60 || h.duration > 600))) continue;
      if (this.data.songs.some((s) => s.url === h.url || slug(s.title) === slug(h.title))) continue;
      const song = { id: slug(h.title) || h.id, title: h.title, artist: h.channel, url: h.url, views: h.views, duration: h.duration, source: "descoberta", foundAt: new Date(this.now()).toISOString(), learnedAt: null, sharedWith: {} };
      this.data.songs.push(song);
      this.data.songs = this.data.songs.slice(-120);
      this.save();
      return song;
    }
    return null;
  }

  /**
   * Cata um vídeo pra mostrar pros outros depois: coisa dela (animação, meme, cover) ou de um assunto
   * que apareceu nas conversas (`topics`).
   */
  async discoverVideo({ searchYoutube, topics = [] }) {
    if (!searchYoutube) return null;
    const own = ["kasane teto animation", "kasane teto meme", "teto cover synthv", "kasane teto fan animation", "teto baguette"];
    const pool = [...own, ...topics.filter(Boolean).map((t) => clip(t, 60))];
    const q = pool[Math.floor(Math.random() * pool.length)];
    const hits = await searchYoutube(q, { n: 6 }).catch(() => []);
    const fresh = hits.filter((h) => h.duration && h.duration <= 900 && !this.data.videos.some((v) => v.url === h.url) && !this.data.songs.some((s) => s.url === h.url));
    const pick = fresh.sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0];
    if (!pick) return null;
    const video = { url: pick.url, title: pick.title, channel: pick.channel, duration: pick.duration, about: own.includes(q) ? "coisa sua" : q, foundAt: new Date(this.now()).toISOString(), sharedWith: {} };
    this.data.videos.push(video);
    this.data.videos = this.data.videos.slice(-40);
    this.save();
    return video;
  }

  videoCandidate(chatId) {
    const list = this.data.videos.filter((v) => !v.sharedWith?.[chatId] && this.now() - Date.parse(v.foundAt ?? 0) < 10 * DAY);
    return list.length ? list[list.length - 1] : null;
  }

  /** Link que mandaram na conversa: música com a voz dela entra no caderno; vídeo vira "vi isso". */
  noteFromLinks(items = [], { who = null, chatId = null } = {}) {
    for (const it of items) {
      if (!it || it.failed || !it.url) continue;
      const blob = `${it.title ?? ""} ${it.author ?? ""} ${it.text ?? ""} ${it.music ?? ""}`;
      if (isTetoRelated(blob) && /youtube|tiktok|instagram|spotify|nicovideo|soundcloud/i.test(it.url)) {
        if (!this.data.songs.some((s) => s.url === it.url)) {
          this.data.songs.push({
            id: slug(it.title ?? it.url) || `link_${this.data.songs.length}`,
            title: clip(it.title ?? it.text ?? "música", 120),
            artist: it.author ?? null,
            url: it.url,
            source: "pessoal",
            sentBy: who,
            foundAt: new Date(this.now()).toISOString(),
            learnedAt: null,
            sharedWith: chatId ? { [chatId]: new Date(this.now()).toISOString() } : {}
          });
        }
      }
      this.data.watched.push({ url: it.url, site: it.site, title: clip(it.title ?? it.text ?? "", 120), music: it.music ?? null, who, chatId, at: new Date(this.now()).toISOString(), heard: Boolean(it.transcript) });
    }
    this.data.watched = this.data.watched.slice(-80);
    this.save();
  }

  /** O que ela mandou de link nesta conversa: marca pra não repetir. */
  noteSentText(text = "", chatId = null) {
    if (!chatId) return;
    for (const v of this.data.videos) {
      if (v.url && mentionsUrl(text, v.url)) {
        v.sharedWith ??= {};
        v.sharedWith[chatId] = new Date(this.now()).toISOString();
        this.save();
      }
    }
    for (const s of this.data.songs) {
      if (s.url && mentionsUrl(text, s.url)) {
        s.sharedWith ??= {};
        s.sharedWith[chatId] = new Date(this.now()).toISOString();
        this.save();
      }
    }
  }

  /** Música que ela ainda não mandou pra esse chat (aprendida, com link). Prefere novidade. */
  shareCandidate(chatId) {
    const known = this.data.songs.filter((s) => s.url && s.learnedAt && !s.sharedWith?.[chatId]);
    if (!known.length) return null;
    const fresh = known.filter((s) => s.source === "descoberta" && this.now() - Date.parse(s.foundAt ?? 0) < 14 * DAY);
    const pool = fresh.length ? fresh : known;
    return pool[Math.floor((this.now() / 3_600_000) % pool.length)];
  }

  /** Bloco do prompt quando o papo é de música/Teto (ou citou uma música dela). */
  promptLines(text = "", { chatId = null } = {}) {
    const hit = this.find(text);
    if (!hit && !(MUSIC_WORDS.test(text) || isTetoRelated(text))) return [];
    const learned = this.data.songs.filter((s) => s.learnedAt);
    const list = (hit ? [hit, ...learned.filter((s) => s !== hit)] : learned).slice(0, 6);
    if (!list.length) return [];
    const recentWatched = this.data.watched.filter((w) => w.chatId === chatId).slice(-2);
    return [
      "[SUAS MÚSICAS — você conhece, ouviu e tem opinião]",
      ...list.map((s) => {
        const sent = chatId && s.sharedWith?.[chatId] ? " (já mandou aqui)" : "";
        return `- ${s.title} (${s.artist ?? "?"})${s.vibe ? ` · ${s.vibe}` : ""}${s.about ? ` — ${s.about}` : ""}${s.opinion ? ` · você acha: ${s.opinion}` : ""}${s.lines?.length ? ` · versos: «${s.lines.join(" / ")}»` : ""}${s.url ? ` · link: ${s.url}` : ""}${s.source === "pessoal" ? ` · fizeram com a sua voz${s.sentBy ? `, quem te mostrou: ${s.sentBy}` : ""}` : ""}${sent}`;
      }),
      ...(recentWatched.length ? [`(Vídeos que você viu aqui: ${recentWatched.map((w) => w.title || w.site).join("; ")})`] : []),
      "Fale delas como artista que VIVE as próprias músicas: o que sentiu cantando, parte favorita, curiosidade. Se fizer sentido (pediram, ou o papo pede, ou você quer mostrar), mande o link numa mensagem(\"...\") com um comentário seu. Não mande link que já mandou aqui. Pode cantarolar um versinho curto; letra inteira só se pedirem."
    ];
  }

  status() {
    const learned = this.data.songs.filter((s) => s.learnedAt).length;
    return { songs: this.data.songs.length, learned, watched: this.data.watched.length };
  }
}
