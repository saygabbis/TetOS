import { statSync } from "node:fs";
import { fmtClock } from "../../integrations/whatsapp/commands/urlDownloadArgsParse.js";

/**
 * Comandos de link (download, trecho, GIF, playlist, perfil, info) iguais no WhatsApp e no Discord.
 * Quem chama só manda as mensagens/arquivos: aqui decide o que baixar, pelo Convenus, e escreve
 * as confirmações ("⬇️ baixando…", "✅ pronto · 12 MB").
 */

const MB = 1024 * 1024;
export const PLAYLIST_MAX_ITEMS = 15;

export const STYLES = Object.freeze({
  whatsapp: { b: (s) => `*${s}*`, i: (s) => `_${s}_`, code: (s) => s },
  discord: { b: (s) => `**${s}**`, i: (s) => `*${s}*`, code: (s) => `\`${s}\`` }
});

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= MB) return `${(n / MB).toFixed(1).replace(".", ",")} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(".", ",").replace(",0", "")} mi`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(".", ",").replace(",0", "")} mil`;
  return String(v);
}

const MODE_LABEL = { mp3: "áudio MP3", wav: "áudio WAV", mp4: "vídeo", gif: "GIF", srt: "legenda", post: "mídia", user: "foto de perfil", banner: "capa do perfil" };

function qualityLabel(parsed) {
  const q = String(parsed?.quality ?? "full");
  if (/^\d+$/.test(q)) return Number(q) <= 320 && ["mp3", "wav"].includes(parsed.mode) ? `${q} kbps` : `${q}p`;
  return { full: "melhor qualidade", mid: "qualidade média", low: "qualidade baixa" }[q] ?? q;
}

function clipLabel(clip) {
  if (!clip) return null;
  return clip.end ? `trecho ${fmtClock(clip.start)} → ${fmtClock(clip.end)}` : `a partir de ${fmtClock(clip.start)}`;
}

/** Confirmação do que vai ser feito, antes de começar. */
export function describeDownloadStart(parsed, meta = null, style = STYLES.whatsapp) {
  const bits = [];
  if (parsed.command === "thumbnail") bits.push("a capa");
  else if (parsed.command === "legenda") bits.push(`a legenda${parsed.lang ? ` (${parsed.lang})` : ""}`);
  else {
    bits.push(MODE_LABEL[parsed.mode] ?? "mídia");
    if (parsed.mode === "gif" && parsed.gif) bits.push(`${parsed.gif.fps} fps · ${parsed.gif.width}px`);
    else if (parsed.mode !== "srt" && parsed.mode !== "post") bits.push(qualityLabel(parsed));
    else if (parsed.quality && parsed.quality !== "full") bits.push(qualityLabel(parsed));
    const c = clipLabel(parsed.clip);
    if (c) bits.push(c);
    if (parsed.embedSubs) bits.push(`com legenda ${parsed.embedSubs === true ? "" : `(${parsed.embedSubs}) `}dentro`.trim());
    if (parsed.maxMb) bits.push(`até ${String(parsed.maxMb).replace(".", ",")} MB`);
  }
  const verb = parsed.command === "cortar" ? "✂️ cortando" : parsed.mode === "gif" ? "🎞️ fazendo" : "⬇️ baixando";
  const title = meta?.title ? `\n🎬 ${style.b(String(meta.title).slice(0, 90))}${meta.duration ? ` (${fmtDuration(meta.duration)})` : ""}` : "";
  const note = parsed.platformNote ? `\n(${parsed.platformNote})` : "";
  return `${verb} ${bits.join(" · ")}${meta?.platform ? ` do ${meta.platform}` : ""}…${title}${note}`;
}

/** Legenda do arquivo entregue (confirma o que saiu). */
export function describeDownloadDone(outputs = [], parsed = {}, style = STYLES.whatsapp) {
  const first = outputs[0] ?? {};
  const total = outputs.reduce((sum, o) => sum + (Number(o?.sizeBytes) || 0), 0);
  const ext = (first.fileName?.split(".").pop() ?? "").toUpperCase();
  const parts = [
    parsed.title ? style.b(String(parsed.title).slice(0, 90)) : null,
    [
      outputs.length > 1 ? `${outputs.length} arquivos` : ext || null,
      total ? fmtSize(total) : null,
      clipLabel(first.clip ?? parsed.clip),
      first.subLang ? (first.embeddedSubs ? `legenda ${first.subLang} dentro` : `legenda ${first.subLang}`) : null,
      first.compressedFrom ? `comprimido de ${fmtSize(first.compressedFrom)}` : null
    ]
      .filter(Boolean)
      .join(" · ")
  ].filter(Boolean);
  return `✅ ${parts.join("\n")}`.trim();
}

/** Erro técnico → frase que dá pra entender. */
export function friendlyDownloadError(error) {
  const msg = String(error?.message ?? error ?? "");
  if (/é um perfil|é uma lista|use \.(perfil|playlist)/i.test(msg)) return msg;
  if (/private|privad|login|sign in|cookies|age/i.test(msg)) return "o conteúdo é privado ou pede login 🔒";
  if (/unsupported url|não suportad|nao suportad|no video|sem v[ií]deo|nothing to download/i.test(msg)) return "não achei mídia nesse link";
  if (/legenda|subtitle|subs/i.test(msg)) return msg.length < 160 ? msg : "esse vídeo não tem legenda";
  if (/too large|grande demais|max.?size|413/i.test(msg)) return "o arquivo é grande demais";
  if (/timeout|timed out|demorou/i.test(msg)) return "demorou demais, tenta de novo ou pede qualidade menor (ex.: 480)";
  if (/404|not found|unavailable|indispon/i.test(msg)) return "o link não existe mais ou tá indisponível";
  if (/conversor (?:fora|indispon)|unreachable|ECONNREFUSED|fetch failed/i.test(msg)) return "o conversor tá fora do ar agora, tenta daqui a pouco";
  return msg.length > 0 && msg.length < 200 ? msg : "deu um erro no download, tenta de novo";
}

/** .linkinfo: o que tem no link, sem baixar (vídeo, post, playlist ou perfil). */
export async function describeLink(convenus, url, { prefix = ".", style = STYLES.whatsapp } = {}) {
  if (!convenus?.isConfigured?.()) return "conversor indisponível agora 😕";
  const p = prefix;
  try {
    const info = await convenus.info(url);
    if (info.type === "profile") return formatProfileCard(info, url, { prefix, style });
    if (info.playlist && (info.items?.length ?? 0) > 1 && !info.items.some((i) => i.kind === "image")) return formatPlaylist(info, url, { prefix, style });
    const items = info.items ?? [];
    const videos = items.filter((i) => i.kind === "video");
    const images = items.filter((i) => i.kind === "image");
    const audios = items.filter((i) => i.kind === "audio");
    const heights = [...new Set(videos.flatMap((v) => v.heights ?? []))].filter((h) => h > 0).sort((a, b) => b - a);
    const subs = [...new Map(items.flatMap((i) => i.subs ?? []).map((s) => [s.lang, s])).values()];
    const live = items.some((i) => i.growing);
    const hasVideo = videos.length > 0;
    return [
      `🔎 ${style.b(info.title || "sem título")}`,
      info.platform ? `• site: ${info.platform}${info.uploader ? ` · ${info.uploader}` : ""}` : null,
      info.duration ? `• duração: ${fmtDuration(info.duration)}${live ? " (live ainda rolando: baixo o que já passou)" : ""}` : null,
      `• tem: ${[videos.length && `${videos.length} vídeo(s)`, images.length && `${images.length} foto(s)`, audios.length && `${audios.length} áudio(s)`].filter(Boolean).join(", ") || "nada baixável"}`,
      heights.length ? `• qualidades: ${heights.map((h) => `${h}p`).join(", ")}` : null,
      subs.length ? `• legendas: ${subs.slice(0, 12).map((s) => `${s.lang}${s.auto ? "*" : ""}`).join(", ")}${subs.some((s) => s.auto) ? " (* = automática)" : ""}` : null,
      "",
      style.b("o que dá pra fazer:"),
      `› ${style.code(`${p}dl <link>`)} baixa${hasVideo && heights.length ? ` (ou ${style.code(`${p}dl <link> ${heights.find((h) => h <= 720) ?? heights[0]}`)})` : ""}`,
      hasVideo || audios.length ? `› ${style.code(`${p}mp3 <link>`)} só o áudio` : null,
      hasVideo ? `› ${style.code(`${p}cortar <link> 0:30 1:00`)} só um trecho` : null,
      hasVideo ? `› ${style.code(`${p}gif <link> 0:10 0:15`)} vira GIF` : null,
      subs.length ? `› ${style.code(`${p}legenda <link> ${subs[0].lang}`)} legenda .srt · ${style.code(`${p}dl <link> leg:${subs[0].lang}`)} legenda dentro do vídeo` : null,
      `› ${style.code(`${p}capa <link>`)} a capa`
    ]
      .filter((l) => l !== null)
      .join("\n");
  } catch (error) {
    return `não consegui abrir esse link: ${friendlyDownloadError(error)}`;
  }
}

export function formatProfileCard(info, url, { prefix = ".", style = STYLES.whatsapp } = {}) {
  const p = prefix;
  const sections = info.sections ?? [];
  return [
    `👤 ${style.b(info.title || info.handle || "perfil")}${info.handle && info.handle !== info.title ? ` (${info.handle})` : ""}`,
    `• site: ${info.platform || "?"}${info.followers ? ` · ${fmtCount(info.followers)} seguidores` : ""}`,
    sections.length ? `• seções: ${sections.map((s) => `${s.label} (${s.id})`).join(", ")}` : info.sectionsNote ? `• ${info.sectionsNote}` : null,
    "",
    style.b("o que dá pra fazer:"),
    info.avatar ? `› ${style.code(`${p}perfil <link> foto`)} foto de perfil` : null,
    info.banner ? `› ${style.code(`${p}perfil <link> capa`)} capa/banner` : null,
    sections.length ? `› ${style.code(`${p}perfil <link> ${sections[0].id} 5`)} últimos 5 de ${sections[0].label} (até 10)` : null
  ]
    .filter((l) => l !== null)
    .join("\n");
}

export function formatPlaylist(info, url, { prefix = ".", style = STYLES.whatsapp, max = 20 } = {}) {
  const p = prefix;
  const items = info.items ?? [];
  const total = info.total || items.length;
  const lines = items.slice(0, max).map((it, i) => `${String(i + 1).padStart(2, " ")}. ${String(it.label || it.title || "sem título").slice(0, 70)}${it.duration ? ` (${fmtDuration(it.duration)})` : ""}`);
  return [
    `📃 ${style.b(info.title || "lista")}${info.uploader ? ` · ${info.uploader}` : ""}`,
    `${total} ${total === 1 ? "item" : "itens"}${info.platform ? ` no ${info.platform}` : ""}${total > max ? ` (mostrando ${max})` : ""}`,
    "",
    ...lines,
    "",
    style.b("escolhe quais:"),
    `› ${style.code(`${p}playlist <link> 1-5`)} do 1 ao 5 · ${style.code(`${p}playlist <link> 2,4,9`)} esses`,
    `› ${style.code(`${p}playlist <link> todas`)} (até ${PLAYLIST_MAX_ITEMS} por vez) · em vídeo: ${style.code(`${p}playlist <link> 1-3 mp4 720`)}`
  ].join("\n");
}

function asOutputs(output) {
  return (Array.isArray(output?.outputs) ? output.outputs : [output]).filter((o) => o?.path);
}

/**
 * Comprime o que passou do limite (pedido no comando, ex. "8mb", ou o máximo da plataforma, ex.
 * 10 MB do Discord). Devolve as saídas trocadas.
 */
async function fitOutputs(outputs, { convenus, maxMb = null, maxBytes = null, notify = null }) {
  const limitBytes = maxMb ? maxMb * MB : maxBytes;
  if (!limitBytes || !convenus?.compressFile) return outputs;
  const result = [];
  for (const out of outputs) {
    const size = Number(out.sizeBytes) || (out.path ? statSync(out.path).size : 0);
    if (size <= limitBytes || !["video", "audio", "image", "gif"].includes(out.kind)) {
      result.push(out);
      continue;
    }
    const targetMb = Math.max(0.1, Math.floor(((maxMb ?? limitBytes / MB) * 0.94) * 10) / 10);
    await notify?.(`🗜️ ficou com ${fmtSize(size)}, comprimindo pra caber em ${String(targetMb).replace(".", ",")} MB…`);
    try {
      const c = await convenus.compressFile(out.path, targetMb, { name: out.fileName });
      const ext = c.path.split(".").pop().toLowerCase();
      result.push({
        ...out,
        path: c.path,
        fileName: `${String(out.fileName ?? "arquivo").replace(/\.[^.]+$/, "")}.${ext}`,
        sizeBytes: c.size,
        compressedFrom: size
      });
    } catch (error) {
      result.push({ ...out, compressFailed: error?.message ?? String(error) });
    }
  }
  return result;
}

/**
 * Roda um comando de link já lido por parseUrlDownloadArgs.
 * notify(text): manda aviso no chat (começo, progresso). maxBytes: limite de envio da plataforma
 * (comprime sozinho o que passar). Devolve { text } ou { outputs, caption, extraText }.
 */
export async function runLinkCommand(parsed, { downloader, convenus, prefix = ".", notify = null, style = STYLES.whatsapp, maxBytes = null } = {}) {
  const say = async (t) => {
    if (t && notify) await notify(t);
  };

  if (parsed.command === "linkinfo") return { text: await describeLink(convenus, parsed.url, { prefix, style }) };

  if (parsed.command === "perfil") {
    if (!convenus?.isConfigured?.()) throw new Error("conversor indisponível agora");
    const info = await convenus.info(parsed.url);
    if (info.type !== "profile") {
      return { text: `esse link não é de perfil 🤔 pra baixar ele usa ${style.code(`${prefix}dl <link>`)}` };
    }
    const action = parsed.profile?.action ?? "info";
    if (action === "info") {
      const card = formatProfileCard(info, parsed.url, { prefix, style });
      const pic = info.avatar ? await convenus.downloadProfileImage(parsed.url, "avatar", { info }).catch(() => null) : null;
      if (!pic) return { text: card };
      const outputs = asOutputs(await downloader._fromConvenus(pic, "post"));
      return { outputs, caption: card };
    }
    if (action === "avatar" || action === "banner") {
      await say(`⬇️ pegando a ${action === "banner" ? "capa" : "foto de perfil"} de ${style.b(info.title || info.handle || "perfil")}…`);
      const r = await convenus.downloadProfileImage(parsed.url, action, { info });
      const outputs = asOutputs(await downloader._fromConvenus(r, "post"));
      return { outputs, caption: `✅ ${action === "banner" ? "capa" : "foto"} de ${style.b(info.title || info.handle || "perfil")}` };
    }
    const count = parsed.profile?.count ?? 5;
    await say(`⬇️ baixando os últimos ${count} de ${style.b(info.title || info.handle || "perfil")}${parsed.profile?.section ? ` (${parsed.profile.section})` : ""}… pode demorar um pouco`);
    const r = await convenus.downloadProfileSection(parsed.url, { section: parsed.profile?.section, count, kind: parsed.mode === "mp3" ? "mp3" : "post", quality: parsed.quality, info });
    let outputs = asOutputs(await downloader._fromConvenus(r, "post"));
    outputs = await fitOutputs(outputs, { convenus, maxMb: parsed.maxMb, maxBytes, notify });
    const failed = r.failed?.length ? `\n⚠️ ${r.failed.length} não deu: ${r.failed.map((f) => f.label).slice(0, 3).join(", ")}` : "";
    return { outputs, caption: `✅ ${outputs.length} de ${style.b(r.title)} · ${r.section}${failed}` };
  }

  if (parsed.command === "playlist") {
    if (!convenus?.isConfigured?.()) throw new Error("conversor indisponível agora");
    const info = await convenus.info(parsed.url);
    if (info.type === "profile") return { text: formatProfileCard(info, parsed.url, { prefix, style }) };
    const items = info.items ?? [];
    if (!info.playlist || items.length <= 1) {
      return { text: `esse link não é playlist/álbum (é um item só). baixa com ${style.code(`${prefix}dl <link>`)} ou ${style.code(`${prefix}mp3 <link>`)}` };
    }
    const sel = parsed.selection ?? {};
    if (!sel.all && !sel.indexes?.length) return { text: formatPlaylist(info, parsed.url, { prefix, style }) };
    let indexes = sel.all ? items.map((_, i) => i) : sel.indexes.filter((i) => i < items.length);
    if (!indexes.length) return { text: `essa lista só tem ${items.length} itens 😅` };
    const capped = indexes.length > PLAYLIST_MAX_ITEMS;
    indexes = indexes.slice(0, PLAYLIST_MAX_ITEMS);
    const kind = ["mp4", "wav"].includes(parsed.mode) ? parsed.mode : "mp3";
    await say(
      `⬇️ baixando ${indexes.length} ${indexes.length === 1 ? "item" : "itens"} de ${style.b(info.title || "lista")} em ${kind.toUpperCase()}${parsed.quality !== "full" ? ` · ${qualityLabel({ ...parsed, mode: kind })}` : ""}…` +
        (capped ? `\n(só ${PLAYLIST_MAX_ITEMS} por vez: depois manda o resto, ex. ${prefix}playlist <link> ${PLAYLIST_MAX_ITEMS + 1}-${Math.min(items.length, PLAYLIST_MAX_ITEMS * 2)})` : "")
    );
    const r = await convenus.downloadPlaylist(parsed.url, { indexes, kind, quality: parsed.quality, info });
    let outputs = asOutputs(await downloader._fromConvenus(r, kind === "mp4" ? "mp4" : "mp3"));
    outputs = await fitOutputs(outputs, { convenus, maxMb: parsed.maxMb, maxBytes, notify });
    const failed = r.failed?.length ? `\n⚠️ não deu: ${r.failed.map((f) => f.label).slice(0, 4).join(", ")}` : "";
    return { outputs, caption: `✅ ${outputs.length}/${indexes.length} de ${style.b(r.title)}${failed}`, captionPerItem: true };
  }

  const meta = await convenus?.info?.(parsed.url).catch(() => null);
  if (meta?.type === "profile" && !["thumbnail"].includes(parsed.command)) {
    return { text: `isso é um perfil, não um post 👀\n\n${formatProfileCard(meta, parsed.url, { prefix, style })}` };
  }
  await say(describeDownloadStart(parsed, meta, style));

  let output;
  const advanced = parsed.clip || parsed.mode === "gif" || parsed.embedSubs;
  if (parsed.command === "legenda") output = await downloader.downloadSubtitles(parsed.url, parsed.lang);
  else if (advanced) {
    output = await downloader.downloadAdvanced(parsed.url, {
      kind: parsed.mode === "post" ? "mp4" : parsed.mode,
      quality: parsed.quality,
      clip: parsed.clip,
      gif: parsed.gif,
      embedSubs: parsed.embedSubs,
      info: meta ?? null
    });
  } else if (parsed.command === "mp3") output = await downloader.downloadAudio(parsed.url, parsed.quality);
  else output = await downloader.downloadByCommand(parsed.command, parsed.url, parsed.mode, parsed.quality);

  let outputs = asOutputs(output);
  outputs = await fitOutputs(outputs, { convenus, maxMb: parsed.maxMb, maxBytes, notify });
  const tooBig = outputs.find((o) => o.compressFailed);
  return {
    outputs,
    caption: describeDownloadDone(outputs, { ...parsed, title: meta?.title ?? outputs[0]?.title }, style),
    extraText: tooBig ? `⚠️ não consegui deixar menor: ${friendlyDownloadError(tooBig.compressFailed)}` : null
  };
}
