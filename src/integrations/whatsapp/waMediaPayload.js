/** Detecta saída que deve ir como GIF animado no WhatsApp (videoMessage + gifPlayback). */
export function isGifLikeOutput(output = {}) {
  const mimetype = String(output.mimetype ?? "").toLowerCase();
  const fileName = String(output.fileName ?? output.path ?? "").toLowerCase();
  const kind = String(output.kind ?? "").toLowerCase();
  return kind === "gif" || mimetype === "image/gif" || fileName.endsWith(".gif");
}

/** Payload Baileys para GIF / vídeo curto com autoplay no chat. */
export function buildWaGifPlaybackPayload(
  buffer,
  { mimetype = "image/gif", seconds = undefined } = {}
) {
  const isMp4 = mimetype === "video/mp4";
  return {
    video: buffer,
    mimetype,
    gifPlayback: true,
    ...(isMp4 && typeof seconds === "number" ? { seconds } : {})
  };
}

/** Monta payload de envio WA para saídas de comandos de mídia. */
export function buildWaMediaPayload(buffer, output = {}) {
  const mimetype = output.mimetype ?? "application/octet-stream";
  const fileName = output.fileName ?? "arquivo";
  const kind = output.kind ?? "document";

  if (isGifLikeOutput(output)) {
    return buildWaGifPlaybackPayload(buffer, { mimetype: "image/gif" });
  }

  if (kind === "video") {
    const seconds = output.toimgPlaybackSeconds ?? output.seconds;
    if (output.gifPlayback === true) {
      return buildWaGifPlaybackPayload(buffer, {
        mimetype: mimetype === "video/mp4" ? "video/mp4" : mimetype,
        seconds
      });
    }
    return {
      video: buffer,
      mimetype,
      gifPlayback: false,
      ...(mimetype === "video/mp4" && typeof seconds === "number" ? { seconds } : {})
    };
  }

  if (kind === "audio") {
    return { audio: buffer, mimetype, ptt: false };
  }

  if (kind === "image") {
    return { image: buffer, mimetype };
  }

  return { document: buffer, mimetype, fileName };
}

/** Payload Baileys para envio como arquivo (documento). */
export function buildWaDocumentPayload(buffer, output = {}) {
  return {
    document: buffer,
    mimetype: output.mimetype ?? "application/octet-stream",
    fileName: output.fileName ?? "arquivo"
  };
}
