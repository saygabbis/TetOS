/**
 * Catálogo único dos comandos da Teto no WhatsApp: nome, apelidos, categoria, uso e onde vale.
 * Daqui saem o .help (geral, por categoria e por comando), a correção de erro de digitação
 * (".stiker" → .sticker) e os avisos de "esse é só no PV" / "só a dona" — antes cada comando era
 * lido num canto do código e o que não batia certinho era ignorado em silêncio.
 *
 * scope: "any" (PV e grupo) | "pv" (só no privado) | "owner" (só a dona, no privado)
 */

export const CATEGORIES = Object.freeze([
  { id: "basico", emoji: "✨", title: "Básico" },
  { id: "ativar", emoji: "⚡", title: "Ligar e desligar a Teto" },
  { id: "figurinhas", emoji: "🎨", title: "Figurinhas e imagem" },
  { id: "baixar", emoji: "📥", title: "Baixar de links" },
  { id: "converter", emoji: "✂️", title: "Converter e editar" },
  { id: "acessibilidade", emoji: "♿", title: "Acessibilidade" },
  { id: "utilidades", emoji: "🧰", title: "Utilidades" },
  { id: "diversao", emoji: "🎲", title: "Diversão" },
  { id: "preco", emoji: "💸", title: "Monitor de preço" },
  { id: "teto", emoji: "💭", title: "Coisas da Teto" }
]);

const Q = "[full|mid|low]";

/** @type {ReadonlyArray<{ name: string, aliases?: string[], category: string, usage?: string, desc: string, details?: string[], examples?: string[], scope?: "any"|"pv"|"owner", hidden?: boolean }>} */
export const COMMANDS = Object.freeze([
  // Básico
  { name: "help", aliases: ["ajuda", "comandos", "commands", "menu", "h", "socorro"], category: "basico", usage: "[comando|categoria]", desc: "esta lista; .help sticker explica um comando", examples: ["help", "help baixar", "help sticker"] },
  { name: "ping", aliases: ["oi", "teste", "online"], category: "basico", desc: "vê se eu tô respondendo e quanto demoro" },
  { name: "status", aliases: ["estado", "info-bot"], category: "basico", desc: "como eu tô: ligada aqui? dormindo? quanto tempo online" },
  { name: "sobre", aliases: ["about", "quemsoueu", "teto"], category: "basico", desc: "quem eu sou e como falar comigo" },

  // Ativar
  { name: "teto-ativar", aliases: ["ativar", "teto-on", "ligar", "acordar"], category: "ativar", desc: "me liga no seu PV (no grupo, liga o grupo)" },
  { name: "teto-desativar", aliases: ["desativar", "teto-off", "desligar"], category: "ativar", desc: "me desliga no seu PV (no grupo, desliga o grupo)" },
  { name: "teto-grupo-ativar", aliases: ["grupo-ativar", "ativar-grupo"], category: "ativar", desc: "me liga no grupo (respondo com @ ou reply)" },
  { name: "teto-grupo-desativar", aliases: ["grupo-desativar", "desativar-grupo"], category: "ativar", desc: "me desliga no grupo" },

  // Figurinhas
  { name: "sticker", aliases: ["s", "fig", "figu", "figurinha", "stiker", "stick", "f"], category: "figurinhas", usage: "[10s]", desc: "foto/vídeo/GIF vira figurinha (estica pra caber)", details: ["responda a mídia ou mande na legenda", "vídeo: .sticker 5s corta nos 5 primeiros segundos"], examples: ["sticker", "sticker 5s"] },
  { name: "fsticker", aliases: ["ffig", "ffigurinha", "fstiker", "fs", "figinteira"], category: "figurinhas", usage: "[10s]", desc: "figurinha sem cortar nada (com borda)" },
  { name: "csticker", aliases: ["cfig", "cfigurinha", "cstiker", "cs", "figcorte"], category: "figurinhas", usage: "[10s]", desc: "figurinha recortando o centro (quadrada)" },
  { name: "toimg", aliases: ["img", "toimage", "paraimg", "figparaimg", "desfig"], category: "figurinhas", desc: "figurinha vira imagem (ou GIF/vídeo se for animada)" },
  { name: "optimize", aliases: ["otimizar", "optimizar", "opt", "figleve"], category: "figurinhas", desc: "deixa a figurinha mais leve" },
  { name: "removebg", aliases: ["rmbg", "remove-bg", "semfundo", "tirarfundo", "nobg"], category: "figurinhas", usage: "[cor] [leve|media|forte]", desc: "tira o fundo da imagem/figurinha", examples: ["removebg", "removebg verde", "removebg forte"] },
  {
    name: "gerar",
    aliases: ["imagem", "generate", "draw", "desenhar", "criarimagem", "gerarimagem"],
    category: "figurinhas",
    usage: "[16:9|9:16|3:2|2:3] <descrição>",
    desc: "gera uma imagem com IA (modo econômico, na hora)",
    details: ["formato opcional no começo: 16:9, 9:16, 3:2, 2:3, 4:3, 3:4", "quer caprichado? use .gerarhd (mostra o custo e pede confirmação)"],
    examples: ["gerar gato astronauta em aquarela", "gerar 16:9 paisagem de cyberpunk à noite"]
  },
  {
    name: "gerarhd",
    aliases: ["gerar-hd", "gerarbom", "gerarpro", "imagemhd", "hd", "desenharhd"],
    category: "figurinhas",
    usage: "[alta|ultra|max] [16:9|9:16|2k] <descrição>",
    desc: "gera no modo bom (mais detalhe): diz o custo e pede seu sim",
    details: [
      "qualidade: alta (padrão), ultra ou max · formato: 16:9, 9:16, 3:2, 2:3… · 2k = resolução maior",
      "eu mando a estimativa (tokens, US$ e tempo) e só faço quando você responder sim",
      "só a dona usa o modo bom; pros outros sai no econômico"
    ],
    examples: ["gerarhd teto tocando guitarra num palco, estilo anime", "gerarhd ultra 16:9 2k cidade flutuante ao pôr do sol"]
  },
  {
    name: "editar",
    aliases: ["editarimagem", "edit", "editimg", "mudar", "alterar"],
    category: "figurinhas",
    usage: "<o que mudar>",
    desc: "edita a imagem marcada com IA (econômico)",
    details: ["responda a foto (ou mande na legenda) dizendo o que mudar", "quer caprichado? .editarhd"],
    examples: ["editar troca o fundo por uma praia", "editar deixa no estilo ghibli"]
  },
  {
    name: "editarhd",
    aliases: ["editar-hd", "editarbom", "editarpro", "edithd"],
    category: "figurinhas",
    usage: "[alta|ultra|max] <o que mudar>",
    desc: "edita a imagem no modo bom: diz o custo e pede seu sim",
    details: ["responda a foto dizendo o que mudar · qualidade: alta (padrão), ultra ou max"],
    examples: ["editarhd tira as pessoas do fundo", "editarhd ultra transforma em pintura a óleo"]
  },
  { name: "repertorio", aliases: ["rep", "repertório"], category: "figurinhas", usage: "on|off|remover", desc: "salvo sozinha as figurinhas que você me mandar; remover tira a marcada" },

  // Baixar
  {
    name: "download",
    aliases: ["dl", "baixar", "down", "baixa"],
    category: "baixar",
    usage: `<link> [mp4|mp3|wav|gif] [qualidade] [opções]`,
    desc: "baixa de quase qualquer site (YouTube, Insta, TikTok, X, Spotify, Twitch, Pixiv, ArtStation…)",
    details: [
      "qualidade: full · mid · low · 1080 · 720 · 480 · 4k (vídeo) · 128–320 (mp3)",
      "trecho: 1:20-2:05 (só esse pedaço)",
      "leg ou leg:pt → legenda gravada dentro do vídeo",
      "8mb → comprime se passar desse tamanho",
      "post com várias fotos manda todas"
    ],
    examples: ["dl https://youtu.be/xxx", "dl <link> 720", "dl <link> 1:00-1:30", "dl <link> leg:pt", "dl <link> 8mb"]
  },
  { name: "youtube", aliases: ["yt", "ytb", "youtubemp4"], category: "baixar", usage: `<link> [mp3|mp4] [qualidade] [opções]`, desc: "vídeo ou música do YouTube (aceita trecho, leg:pt, 8mb)", examples: ["yt <link> 1080", "yt <link> 2:00-2:30 mp3"] },
  { name: "mp3", aliases: ["audio", "musica", "música", "ytmp3", "som"], category: "baixar", usage: "<link> [128|192|256|320|wav] [trecho]", desc: "só o áudio de qualquer link (YouTube, Spotify, Deezer, Apple Music, TikTok…)", examples: ["mp3 https://youtu.be/xxx", "mp3 <link spotify>", "mp3 <link> wav", "mp3 <link> 0:30-1:10"] },
  { name: "instagram", aliases: ["insta", "ig", "reels"], category: "baixar", usage: `<link> [mp3|mp4|post] [qualidade]`, desc: "post, reels ou carrossel do Instagram" },
  { name: "tiktok", aliases: ["tk", "ttok", "tiktk"], category: "baixar", usage: `<link> [mp3|mp4] [qualidade]`, desc: "vídeo do TikTok sem marca d'água (ou as fotos)" },
  { name: "twitter", aliases: ["x", "tt", "tw", "tweet"], category: "baixar", usage: `<link> [mp3|mp4|post] [qualidade]`, desc: "vídeo/fotos de post do X (Twitter)" },
  { name: "reddit", aliases: ["rd"], category: "baixar", usage: `<link> [mp3|mp4|post] [qualidade]`, desc: "vídeo ou imagem do Reddit" },
  { name: "facebook", aliases: ["fb", "face"], category: "baixar", usage: `<link> [mp3|mp4|post] [qualidade]`, desc: "vídeo do Facebook" },
  { name: "playlist", aliases: ["album", "álbum", "lista", "pl", "faixas", "tracks"], category: "baixar", usage: "<link> [1-5|2,4,9|todas] [mp3|mp4|wav] [qualidade]", desc: "playlist/álbum (YouTube, Spotify, Deezer, SoundCloud…): sem número eu mostro a lista pra escolher", details: [`até ${15} por vez`, "sem escolher: mostro as faixas numeradas"], examples: ["playlist <link>", "playlist <link> 1-5", "playlist <link> 3,7 mp4 720", "playlist <link> todas 320"] },
  { name: "perfil", aliases: ["profile", "canal", "usuario", "usuário", "pfp", "avatar"], category: "baixar", usage: "<link> [foto|capa|<seção> [quantos]]", desc: "perfil/canal (Insta, X, TikTok, YouTube, Pixiv, ArtStation, DeviantArt…): foto, capa e últimos posts", details: ["sem nada: mostro o perfil e as seções", "foto = foto de perfil · capa = banner", "seção + número: últimos posts (até 10)"], examples: ["perfil <link>", "perfil <link> foto", "perfil <link> capa", "perfil <link> shorts 3", "perfil <link> reels 5"] },
  { name: "thumbnail", aliases: ["thumb", "capa", "miniatura", "cover"], category: "baixar", usage: "<link>", desc: "capa/miniatura do vídeo ou post" },
  { name: "legenda", aliases: ["legendas", "srt", "sub", "subs"], category: "baixar", usage: "<link> [idioma]", desc: "legenda do vídeo em .srt (pt, en, es…); dentro do vídeo é .dl <link> leg:pt", examples: ["legenda https://youtu.be/xxx pt"] },
  { name: "linkinfo", aliases: ["infolink", "verlink", "oquee", "info"], category: "baixar", usage: "<link>", desc: "o que tem no link (vídeo, playlist ou perfil) e o que dá pra fazer com ele" },

  // Converter e editar
  { name: "convert", aliases: ["converter", "conv", "cv", "para"], category: "converter", usage: "<formato>", desc: "converte a mídia/arquivo marcado (mp4, mp3, gif, png, webp, avif, pdf, docx→pdf, xlsx→csv, zip…)", details: ["responda o arquivo (ou mande na legenda)", "use .formatos pra ver o que dá pra virar"], examples: ["convert mp3", "convert pdf", "convert png", "convert zip"] },
  { name: "formatos", aliases: ["formats", "convertepra", "vira"], category: "converter", desc: "diz em que formatos o arquivo marcado pode virar" },
  { name: "cortar", aliases: ["corte", "trecho", "cut", "clip", "recortar", "aparar"], category: "converter", usage: "[link] <início> <fim> [mp3] [qualidade]", desc: "corta um pedaço do vídeo/áudio marcado (ou de um link)", details: ["tempo: 1:20 · 90s · 1m30s · 1:20-1:45", "mp3 no fim = só o áudio do trecho"], examples: ["cortar 0:10 0:30", "cortar 1:00-1:30 mp3", "cortar https://youtu.be/xxx 2:00 2:20 720"] },
  { name: "gif", aliases: ["togif", "fazergif", "gifar", "virargif"], category: "converter", usage: "[link] [início fim] [fps] [largura]", desc: "transforma vídeo (marcado ou link) em GIF de até 60 s", details: ["sem trecho: os primeiros segundos", "fps: 10 · 12 · 15 · 20 · 24 · 30", "largura: 240px · 320px · 480px · 640px · 720px"], examples: ["gif", "gif 2 8", "gif 0:05 0:12 20fps 320px", "gif https://youtu.be/xxx 1:00 1:06"] },
  { name: "comprimir", aliases: ["compress", "comprime", "diminuir", "reduzir", "encolher", "zipar-tamanho"], category: "converter", usage: "[MB] | <link> [MB]", desc: "deixa vídeo/áudio/imagem/PDF menor, até o tamanho que você falar (padrão 8 MB)", examples: ["comprimir", "comprimir 5", "comprimir 500kb", "comprimir https://youtu.be/xxx 15"] },

  // Acessibilidade
  { name: "transcrever", aliases: ["transcreve", "transcricao", "transcrição", "texto", "tr", "legendar"], category: "acessibilidade", desc: "escreve o que foi falado no áudio/vídeo marcado" },
  { name: "ler", aliases: ["descrever", "descreve", "oqtem", "ocr", "lerimagem", "alt"], category: "acessibilidade", desc: "descreve a imagem marcada e lê o texto dela (pra quem não enxerga bem)" },
  { name: "falar", aliases: ["fala", "voz", "tts", "lerauto", "narrar"], category: "acessibilidade", usage: "<texto>", desc: "transformo texto (ou a mensagem marcada) em áudio", examples: ["falar bom dia gente", "falar (respondendo uma mensagem)"] },
  { name: "traduzir", aliases: ["traduz", "translate", "tradução", "traducao"], category: "acessibilidade", usage: "[idioma] <texto>", desc: "traduz o texto (ou a mensagem marcada); padrão: português", examples: ["traduzir en bom dia", "traduzir (respondendo uma mensagem)"] },
  { name: "resumir", aliases: ["resume", "resumo", "tldr"], category: "acessibilidade", desc: "resume o texto marcado em poucas linhas" },

  // Utilidades
  { name: "clima", aliases: ["tempo", "previsao", "previsão", "weather"], category: "utilidades", usage: "[cidade]", desc: "previsão do tempo de agora e amanhã", examples: ["clima recife"] },
  { name: "hora", aliases: ["horas", "data", "agora", "dia"], category: "utilidades", desc: "data e hora de Brasília" },
  { name: "calc", aliases: ["calcular", "conta", "calcula", "math"], category: "utilidades", usage: "<conta>", desc: "faz a conta (+ - * / ^ % e parênteses)", examples: ["calc (12+8)*3", "calc 15% de 80"] },
  { name: "lembrete", aliases: ["lembrar", "lembra", "remind", "alarme"], category: "utilidades", usage: "<quando> <o quê>", desc: "te lembro de algo (em 10min, 2h, amanhã 9h, 18:30…)", examples: ["lembrete 30min tirar o bolo", "lembrete amanhã 9h reunião"] },
  { name: "vincular", aliases: ["link-discord", "discord", "sync"], category: "utilidades", usage: "<código>", desc: "liga sua conta do Discord comigo (código vem do /vincular de lá)", scope: "pv" },
  { name: "desvincular", aliases: ["unlink"], category: "utilidades", desc: "desliga o Discord vinculado", scope: "pv", hidden: true },

  // Diversão
  { name: "dado", aliases: ["rolar", "roll", "d20", "dados"], category: "diversao", usage: "[NdM]", desc: "rola dado (padrão 1d6; ex.: 2d20)", examples: ["dado", "dado 3d6", "dado d20"] },
  { name: "moeda", aliases: ["caraoucoroa", "coin", "flip"], category: "diversao", desc: "cara ou coroa" },
  { name: "escolher", aliases: ["escolhe", "decide", "choose", "qual"], category: "diversao", usage: "a, b, c", desc: "escolho uma das opções pra você", examples: ["escolher pizza, hambúrguer, sushi"] },
  { name: "sortear", aliases: ["sorteio", "sorteia", "random", "numero"], category: "diversao", usage: "[min] [max] | a, b, c", desc: "sorteia número ou um item da lista", examples: ["sortear 1 100", "sortear ana, bia, caio"] },

  // Preço
  { name: "monitorarpreco", aliases: ["preco", "preço", "monitorar", "monitorarpreço", "precos"], category: "preco", usage: "<produto> | lista | parar <n>", desc: "procura o produto em vários sites e te aviso quando o preço mudar", examples: ["monitorarpreco elegoo saturn 4 ultra", "monitorarpreco lista"] },

  // Teto
  { name: "tetos", aliases: ["perguntar", "pergunta", "ask"], category: "teto", usage: "<pergunta>", desc: "pergunta rápida pra mim sem abrir conversa" },
  { name: "sentimentos", aliases: ["sentimento", "humor", "comovc"], category: "teto", usage: "[historico|assunto]", desc: "como eu tô me sentindo", scope: "pv" },
  { name: "mente", aliases: ["mind"], category: "teto", usage: "[estudar X|pausar|avisos …]", desc: "o que eu ando estudando e pensando", scope: "owner" },
  { name: "gastos", aliases: ["gasto", "custo", "custos"], category: "teto", desc: "quanto a API gastou hoje", scope: "owner" },
  { name: "viewunica", aliases: ["viewonce", "view-unica"], category: "teto", usage: "on|off", desc: "espelha visualização única no seu PV", scope: "owner" }
]);

const STRIP_ACCENTS = /[̀-ͯ]/g;
/** ".kkkk", ".hahaha", ".rsrs": risada, não comando. */
const LAUGH_RE = /^(?:k{2,}\w*|(?:ha|he|hi|hu|ah|rs|ks|sk){2,}\w*|lol|kek|aff)$/i;

export function normalizeCommandToken(token = "") {
  return String(token ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(STRIP_ACCENTS, "")
    .replace(/_/g, "-");
}

const BY_TOKEN = new Map();
for (const cmd of COMMANDS) {
  for (const t of [cmd.name, ...(cmd.aliases ?? [])]) {
    const key = normalizeCommandToken(t);
    if (!BY_TOKEN.has(key)) BY_TOKEN.set(key, cmd);
    const compact = key.replace(/-/g, "");
    if (!BY_TOKEN.has(compact)) BY_TOKEN.set(compact, cmd);
  }
}

export function findCommand(token) {
  const key = normalizeCommandToken(token);
  return BY_TOKEN.get(key) ?? BY_TOKEN.get(key.replace(/-/g, "")) ?? null;
}

/** Distância de edição com troca de letras vizinhas (Damerau). */
export function editDistance(a = "", b = "") {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** Quanto erro aceitar: palavra curta só 1 letra; longa até 2. */
function tolerance(len) {
  if (len <= 2) return 0;
  if (len <= 6) return 1;
  return 2;
}

/**
 * Comando parecido com o que foi digitado. Devolve { cmd, distance, ambiguous } ou null.
 * Ignora apelidos de 1–2 letras (".s", ".x") pra não corrigir qualquer coisa pra eles.
 */
export function closestCommand(token) {
  const key = normalizeCommandToken(token).replace(/-/g, "");
  if (key.length < 3 || key.length > 24 || !/^[a-z0-9]+$/.test(key)) return null;
  let best = null;
  let second = null;
  for (const [t, cmd] of BY_TOKEN) {
    const cand = t.replace(/-/g, "");
    if (cand.length < 3) continue;
    const dist = editDistance(key, cand);
    if (best && dist > best.distance) {
      if (!second || dist < second.distance) second = { cmd, distance: dist };
      continue;
    }
    if (!best || dist < best.distance) {
      if (best && best.cmd !== cmd) second = best;
      best = { cmd, distance: dist };
    } else if (best.cmd !== cmd && (!second || dist <= second.distance)) {
      second = { cmd, distance: dist };
    }
  }
  if (!best || best.distance > tolerance(key.length)) return null;
  const ambiguous = Boolean(second && second.cmd !== best.cmd && second.distance === best.distance);
  return { cmd: best.cmd, distance: best.distance, ambiguous };
}

function stripLeadingMentionsAndMarks(text = "") {
  return String(text ?? "")
    .replace(/^[‎‏‪-‮⁦-⁩\s]+/, "")
    .replace(/^(?:@(?:teto|kasane(?:\s+teto)?|\d{5,}|\S+)\s+)+/i, "")
    .trim();
}

/**
 * Lê ".algo args" (ou "/teto-ativar"). Resultado:
 *  - { kind: "known", cmd, token, args, rest }               comando exato ou apelido
 *  - { kind: "corrected", cmd, token, args, rest }            erro de digitação corrigido sozinho
 *  - { kind: "suggest", token, suggestion }                   parecido, mas não dá pra ter certeza
 *  - { kind: "unknown", token }                               cara de comando, mas não existe
 *  - null                                                     não é comando
 */
export function resolveCommand(text = "", prefix = ".") {
  const p = prefix || ".";
  const raw = stripLeadingMentionsAndMarks(text);
  const usesSlash = raw.startsWith("/") && p !== "/";
  if (!raw.startsWith(p) && !usesSlash) return null;
  const body = raw.slice(usesSlash ? 1 : p.length);
  if (!body || /^\s/.test(body)) return null;
  const m = body.match(/^(\S+)([\s\S]*)$/);
  if (!m) return null;
  const token = m[1];
  const rest = m[2].trim();
  const args = rest ? rest.split(/\s+/) : [];
  // "..." / ".5" / ".kkkk": não é comando.
  if (!/^[\p{L}][\p{L}\p{N}_-]*$/u.test(token)) return null;
  const exact = findCommand(token);
  // Com barra só vale o nome oficial ("/sticker", "/teto-ativar"): "/s" pode ser de outro bot.
  if (usesSlash) return exact && normalizeCommandToken(token) === exact.name ? { kind: "known", cmd: exact, token, args, rest, viaSlash: true } : null;
  if (exact) return { kind: "known", cmd: exact, token, args, rest };
  const near = closestCommand(token);
  if (near && !near.ambiguous && near.distance <= 1) return { kind: "corrected", cmd: near.cmd, token, args, rest };
  if (near && !near.ambiguous && near.distance === 2 && normalizeCommandToken(token).length >= 8) {
    return { kind: "corrected", cmd: near.cmd, token, args, rest };
  }
  if (near) return { kind: "suggest", token, suggestion: near.cmd, args, rest };
  if (/^\p{L}{2,20}$/u.test(token) && !LAUGH_RE.test(token)) return { kind: "unknown", token, args, rest };
  return null;
}

/** Reescreve o texto com o nome oficial do comando (os leitores antigos só entendem o oficial). */
export function canonicalCommandText(resolved, prefix = ".") {
  if (!resolved?.cmd) return null;
  return `${prefix || "."}${resolved.cmd.name}${resolved.rest ? ` ${resolved.rest}` : ""}`;
}

export function commandsInCategory(categoryId, { includeOwner = false } = {}) {
  return COMMANDS.filter((c) => c.category === categoryId && !c.hidden && (includeOwner || c.scope !== "owner"));
}

export function findCategory(token) {
  const key = normalizeCommandToken(token);
  if (!key) return null;
  const synonyms = {
    figurinha: "figurinhas", sticker: "figurinhas", stickers: "figurinhas", imagem: "figurinhas",
    download: "baixar", downloads: "baixar", baixar: "baixar", links: "baixar",
    conversao: "converter", converter: "converter", converte: "converter", editar: "converter", edicao: "converter", edit: "converter",
    acessibilidade: "acessibilidade", acesso: "acessibilidade",
    util: "utilidades", utilidade: "utilidades", utilidades: "utilidades",
    diversao: "diversao", jogos: "diversao", brincadeira: "diversao",
    preco: "preco", precos: "preco",
    teto: "teto", ativar: "ativar", basico: "basico"
  };
  const id = synonyms[key] ?? key;
  return CATEGORIES.find((c) => c.id === id) ?? null;
}
