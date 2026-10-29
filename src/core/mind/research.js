import { askModel, clip, contentWords, hostOf, parseJsonLoose } from "./mindText.js";

/**
 * Pesquisa: decidir quando procurar sozinha antes de responder, e estudar um tema a fundo
 * (buscar → abrir as melhores páginas → resumir o que aprendeu com fonte).
 */

const ABOUT_HER_OR_YOU = /(?<![\p{L}])(voc[eê]|vc|tu|teu|tua|seu|sua|te\b|contigo|teto|tetozinha|eu|meu|minha|comigo|a gente|nós|nos)(?![\p{L}])/iu;
const FACT_WORDS = /(?<![\p{L}])(lança|lançamento|lançou|estreia|estreou|sai\s+quando|saiu|data|ano|preço|custa|valor|quanto\s+(custa|é|e|tá|ta)|cotação|placar|resultado|quem\s+ganhou|campeão|venceu|elenco|diretor|autor|criador|fundou|inventou|significa|significado|definição|capital|população|altura|idade|morreu|nasceu|aniversário\s+de|história\s+d[eoa]|o\s+que\s+(é|e|foi|significa)|quem\s+(é|e|foi)|quando\s+(é|e|foi|vai|sai|começa|lança)|onde\s+(fica|é|e)|qual\s+(é|e|foi)\s+(o|a)|versão|atualização|update|patch|notícia|novidade|temporada|episódio|capítulo)(?![\p{L}])/iu;
const PERSONAL_SMALLTALK = /(?<![\p{L}])(tudo\s+bem|como\s+(vai|voc[eê]\s+tá|vc\s+ta|cê\s+tá)|bom\s+dia|boa\s+(tarde|noite)|oi+|ol[aá]|e\s+a[ií]|saudade|te\s+amo|gosta\s+de\s+mim|acha\s+de\s+mim|tá\s+fazendo|ta\s+fazendo)(?![\p{L}])/iu;

/**
 * A mensagem é uma pergunta de fato (do mundo, não sobre ela/a pessoa) que vale pesquisar?
 * Devolve a busca ou null. Barato: só regex.
 */
export function lookupQuery(text = "") {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 300) return null;
  if (/https?:\/\//i.test(t)) return null; // link já é lido pelo leitor de links
  const isQuestion = /\?\s*$/.test(t) || /^(quem|quando|onde|qual|quais|quanto|quantos|quantas|como|o\s+que|por\s*que|sabe\s+(se|quem|quando|qual|o\s+que))\b/i.test(t);
  if (!isQuestion) return null;
  if (PERSONAL_SMALLTALK.test(t)) return null;
  const words = contentWords(t);
  if (words.length < 2) return null;
  const hasFactWord = FACT_WORDS.test(t);
  // Nome próprio no meio da frase (Pokémon, Hollow Knight…) ou número/ano.
  const properNoun = /\s[A-ZÁÉÍÓÚÂÊÔÃÕ][\p{L}\d]{2,}/u.test(t.slice(1)) || /\b(19|20)\d{2}\b|\d+/.test(t);
  const aboutPeopleHere = ABOUT_HER_OR_YOU.test(t) && !properNoun;
  if (aboutPeopleHere) return null;
  if (!hasFactWord && !properNoun) return null;
  return t
    .replace(/^(teto|tetozinha)[,\s]+/i, "")
    .replace(/\b(me\s+fala|me\s+diz|sabe\s+me\s+dizer|vc\s+sabe|voc[eê]\s+sabe)\b/gi, "")
    .replace(/[?!.]+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

/**
 * Estuda um tema: busca, abre até 2 páginas e pede ao modelo um resumo com fatos e fonte.
 * @returns {{ topic, summary, facts, keywords, sources, opinion, confidence } | null}
 */
export async function studyTopic({ topic, why = "", search, reader = null, llm, persona = "", timeoutMs = 120_000 }) {
  const query = clip(topic, 140);
  const results = (await search(query).catch(() => [])) ?? [];
  if (!results.length) return null;
  const pages = [];
  if (reader?.read) {
    for (const r of results.slice(0, 3)) {
      if (pages.length >= 2) break;
      if (/youtube\.com|youtu\.be|tiktok|instagram|twitter|x\.com|facebook/i.test(r.url)) continue;
      const page = await Promise.race([
        reader.read(r.url).catch(() => null),
        new Promise((resolve) => setTimeout(() => resolve(null), 15_000))
      ]);
      const body = page?.body || page?.text;
      if (body) pages.push({ url: r.url, title: page.title ?? r.title, body: clip(body, 2500) });
    }
  }
  const sourcesText = [
    ...results.slice(0, 5).map((r, i) => `[R${i + 1}] ${r.title} — ${r.snippet ?? ""} (${hostOf(r.url)})`),
    ...pages.map((p, i) => `[P${i + 1}] ${p.title} (${hostOf(p.url)}):\n${p.body}`)
  ].join("\n\n");
  const prompt = [
    "Você é a Kasane Teto estudando sozinha um assunto que te interessou, pra saber conversar sobre ele de verdade.",
    persona ? `Quem você é: ${persona}` : "",
    `Tema: ${query}`,
    why ? `Por que você quis aprender: ${why}` : "",
    "",
    "[O QUE VOCÊ ACHOU NA INTERNET]",
    sourcesText,
    "",
    "Leia com atenção e anote SÓ o que as fontes dizem (nada inventado; se as fontes discordam, diga). Responda só com JSON:",
    '{"tema":"nome curto do tema","resumo":"2 a 4 frases claras, em português","fatos":["fato curto e verificável", "..."],"palavras_chave":["..."],"fonte_principal":"url mais confiável","opiniao":"uma frase sua, do seu jeito, sobre o assunto","confianca":0.0 a 1.0}',
    "No máximo 6 fatos. Se as fontes não servirem pro tema, responda {\"tema\":\"\",\"confianca\":0}."
  ]
    .filter(Boolean)
    .join("\n");
  const json = parseJsonLoose(await askModel(llm, prompt, { timeoutMs }));
  if (!json?.tema || !(Number(json.confianca) > 0.2)) return null;
  const main = results.find((r) => r.url === json.fonte_principal) ?? results[0];
  return {
    topic: clip(json.tema || query, 90),
    summary: clip(json.resumo, 600),
    facts: (Array.isArray(json.fatos) ? json.fatos : []).map((f) => clip(f, 220)).filter(Boolean).slice(0, 6),
    keywords: (Array.isArray(json.palavras_chave) ? json.palavras_chave : []).map(String).slice(0, 12),
    sources: [main, ...pages.filter((p) => p.url !== main?.url), ...results.slice(0, 3)]
      .filter(Boolean)
      .map((r) => ({ url: r.url, title: r.title })),
    opinion: clip(json.opiniao, 200),
    confidence: Math.max(0.3, Math.min(1, Number(json.confianca) || 0.6))
  };
}
