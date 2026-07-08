const VISUAL_MEDIA = new Set(["image", "sticker", "gif", "video"]);

export function describeMediaForPrompt(media, userText = "") {
  if (!media?.type) return null;
  const text = String(userText ?? "").trim();
  const hints = [];
  const isVisual = VISUAL_MEDIA.has(media.type);
  const hasTranscript = Boolean(String(media?.transcript ?? "").trim());
  const visionFailed = media.visionStatus === "failed" || (isVisual && media.visionAttempted && !hasTranscript);

  if (media.type === "image") hints.push("A mensagem veio com imagem.");
  if (media.type === "video") hints.push(media.isAnimated ? "A mensagem veio com mídia animada." : "A mensagem veio com vídeo.");
  if (media.type === "gif") hints.push("A mensagem veio com GIF.");
  if (media.type === "audio") {
    hints.push("A mensagem veio com áudio.");
    if (media.transcriptSource === "fallback") {
      hints.push("Transcrição automática indisponível — peça para repetir em texto se precisar do conteúdo exato.");
    }
  }
  if (media.type === "sticker") {
    hints.push(
      media.isAnimated ? "Figurinha animada recebida." : "Figurinha recebida."
    );
  }
  if (visionFailed) {
    hints.push(
      "Descrição visual falhou — comente o tipo de mídia, reaja com emoji/figurinha ou peça outra foto; não invente detalhes."
    );
  } else if (isVisual && !hasTranscript && !media.visionAttempted) {
    hints.push("Descrição visual ainda pendente — reaja ao tipo de mídia mesmo assim (comentário, emoji ou figurinha).");
  }
  if (media.caption) hints.push(`Legenda da mídia: ${media.caption}`);
  if (media.transcript) {
    hints.push(`Descrição visual da mídia (leitor de imagem): ${media.transcript}`);
    if (/kasane\s*teto|menina\s+(ruiva|rosa)|garota\s+(ruiva|rosa)|cabelo\s+(ruivo|rosa|vermelho)|twin\s*drill|brocas/i.test(media.transcript)) {
      hints.push("A figurinha/imagem parece ser a Kasane Teto (cabelo rosa/vermelho em brocas) — reaja como se estivesse vendo você ou seu meme.");
    }
  }
  if (text) hints.push(`Texto associado: ${text}`);
  if (media.path) hints.push(`Arquivo persistido: ${media.path}`);
  if (isVisual && !visionFailed) {
    hints.push(
      "Figurinha/imagem sem legenda ainda exige reação — comentário curto, reagir() ou figurinha do repertório; não fique em silêncio salvo spam óbvio."
    );
  }
  hints.push("Se faltar conteúdo real da mídia, não invente o que tem dentro; reconheça o tipo de mídia e responda com base apenas no texto associado, na transcrição disponível e no contexto da conversa.");
  return hints.join("\n");
}
