export function buildMultimodalContext(entries = [], limit = 3) {
  const picked = Array.isArray(entries) ? entries.slice(-limit) : [];
  if (!picked.length) return null;
  return picked
    .map((entry) => `- ${entry.mediaType ?? "media"}: ${entry.text || "(sem texto)"}`)
    .join("\n");
}
