export function buildMultimodalContext(entries = [], limit = 3) {
  const picked = Array.isArray(entries) ? entries.slice(-limit) : [];
  if (!picked.length) return null;
  return picked
    .map((entry) => {
      const kind = entry.mediaType === "sticker" ? "figurinha" : entry.mediaType ?? "mídia";
      const id = entry.messageId ? ` id ${entry.messageId}` : "";
      return `- ${kind}${id}: ${entry.text || "(sem descrição)"}`;
    })
    .join("\n");
}
