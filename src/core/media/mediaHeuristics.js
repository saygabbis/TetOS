export function describeMediaForPrompt(media, userText = "") {
  if (!media?.type) return null;
  const text = String(userText ?? "").trim();
  const hints = [];
  if (media.type === "image") hints.push("A mensagem veio com imagem.");
  if (media.type === "video") hints.push(media.isAnimated ? "A mensagem veio com mídia animada." : "A mensagem veio com vídeo.");
  if (media.type === "audio") hints.push("A mensagem veio com áudio.");
  if (media.type === "sticker") hints.push(media.isAnimated ? "A mensagem veio com sticker animado." : "A mensagem veio com sticker.");
  if (media.caption) hints.push(`Legenda da mídia: ${media.caption}`);
  if (media.transcript) hints.push(`Transcrição/descrição disponível: ${media.transcript}`);
  if (text) hints.push(`Texto associado: ${text}`);
  if (media.path) hints.push(`Arquivo persistido: ${media.path}`);
  hints.push("Se faltar conteúdo real da mídia, não invente o que tem dentro; reconheça o tipo de mídia e responda com base apenas no texto associado, na transcrição disponível e no contexto da conversa.");
  return hints.join("\n");
}
