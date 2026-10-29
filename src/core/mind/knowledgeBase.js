import { readJson, writeJsonDeferred } from "../../infra/utils/fileStore.js";
import { clip, contentWords, hostOf, normText, shortId, similarity } from "./mindText.js";

/**
 * O que a Teto estudou sozinha (pesquisa na web + leitura de páginas) ou aprendeu porque alguém ensinou.
 * Cada entrada é um tema com resumo curto, fatos, palavras-chave e fontes. Entra no prompt só quando a
 * conversa toca no tema (busca por palavras) — ela "lembra" do que leu sem palestrar.
 */
export class KnowledgeBase {
  constructor(path = "./data/mind/knowledge.json", { max = 500, now = () => Date.now() } = {}) {
    this.path = path;
    this.max = max;
    this.now = now;
    this.data = path ? readJson(path, { entries: [] }) : { entries: [] };
    this.data.entries ??= [];
  }

  save() {
    if (this.path) writeJsonDeferred(this.path, this.data);
  }

  get entries() {
    return this.data.entries;
  }

  /** Tema já estudado (mesmo tema ou quase)? */
  find(topic = "") {
    const key = normText(topic);
    return this.entries.find((e) => normText(e.topic) === key) ?? this.entries.find((e) => similarity(e.topic, topic) >= 0.75) ?? null;
  }

  /**
   * Guarda (ou completa) um tema. Fatos e fontes repetidos não duplicam.
   * @returns a entrada salva
   */
  add({ topic, summary = "", facts = [], keywords = [], sources = [], opinion = null, by = "estudo", confidence = 0.7 } = {}) {
    const title = clip(topic, 90);
    if (!title) return null;
    const at = new Date(this.now()).toISOString();
    const cleanFacts = facts.map((f) => clip(f, 220)).filter(Boolean);
    const cleanSources = sources
      .map((s) => (typeof s === "string" ? { url: s } : s))
      .filter((s) => s?.url && /^https?:\/\//.test(s.url))
      .map((s) => ({ url: s.url, title: clip(s.title ?? hostOf(s.url), 100) }));
    let entry = this.find(title);
    if (entry) {
      if (summary) entry.summary = clip(summary, 600);
      for (const f of cleanFacts) if (!entry.facts.some((x) => similarity(x, f) >= 0.7)) entry.facts.push(f);
      entry.facts = entry.facts.slice(-12);
      for (const s of cleanSources) if (!entry.sources.some((x) => x.url === s.url)) entry.sources.push(s);
      entry.sources = entry.sources.slice(-6);
      entry.keywords = [...new Set([...(entry.keywords ?? []), ...keywords.map((k) => normText(k)).filter(Boolean)])].slice(0, 16);
      if (opinion) entry.opinion = clip(opinion, 200);
      entry.updatedAt = at;
      entry.confidence = Math.max(entry.confidence ?? 0, confidence);
    } else {
      entry = {
        id: shortId("k"),
        topic: title,
        summary: clip(summary, 600),
        facts: cleanFacts.slice(0, 12),
        keywords: [...new Set(keywords.map((k) => normText(k)).filter(Boolean))].slice(0, 16),
        sources: cleanSources.slice(0, 6),
        opinion: opinion ? clip(opinion, 200) : null,
        by,
        confidence,
        learnedAt: at,
        updatedAt: at,
        uses: 0
      };
      this.entries.push(entry);
      if (this.entries.length > this.max) {
        // Some o menos útil (menos usado, mais velho).
        this.entries.sort((a, b) => (b.uses ?? 0) - (a.uses ?? 0) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
        this.data.entries = this.entries.slice(0, this.max);
      }
    }
    this.save();
    return entry;
  }

  /** Temas que a mensagem toca, do mais relevante ao menos. */
  search(text = "", { limit = 3, minScore = 2 } = {}) {
    const words = new Set(contentWords(text));
    if (!words.size) return [];
    const scored = [];
    for (const e of this.entries) {
      let score = 0;
      for (const w of contentWords(e.topic)) if (words.has(w)) score += 3;
      for (const k of e.keywords ?? []) for (const w of k.split(" ")) if (w.length >= 3 && words.has(w)) score += 2;
      const factWords = new Set(contentWords(`${e.summary} ${(e.facts ?? []).join(" ")}`));
      for (const w of words) if (factWords.has(w)) score += 0.5;
      if (score >= minScore) scored.push({ entry: e, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  markUsed(ids = []) {
    let changed = false;
    for (const e of this.entries) {
      if (ids.includes(e.id)) {
        e.uses = (e.uses ?? 0) + 1;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  /** Bloco do prompt com o que ela sabe sobre o assunto da mensagem (vazio se nada bate). */
  promptLines(text = "", { limit = 3 } = {}) {
    const hits = this.search(text, { limit, minScore: 3 });
    if (!hits.length) return [];
    this.markUsed(hits.map((h) => h.entry.id));
    return [
      "[O QUE VOCÊ JÁ ESTUDOU SOBRE ISSO — você pesquisou e leu, é conhecimento seu]",
      ...hits.map(({ entry: e }) => {
        const facts = (e.facts ?? []).slice(0, 4).join(" · ");
        const src = e.sources?.[0]?.url ? ` (fonte: ${hostOf(e.sources[0].url)})` : "";
        return `- ${e.topic}: ${clip(e.summary, 320)}${facts ? ` | ${clip(facts, 360)}` : ""}${src}`;
      }),
      "Use se ajudar a responder, com suas palavras e sem palestrar. Se a pergunta for sobre algo mais novo que isso, diga que pode ter mudado."
    ];
  }

  recent(n = 5) {
    return [...this.entries].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, n);
  }
}
