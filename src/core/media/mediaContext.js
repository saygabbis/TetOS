export function buildMediaContext(media) {
  if (!media?.type) return null;
  const parts = [`mediaType: ${media.type}`];
  if (media.path) {
    parts.push(`mediaPath: ${media.path}`);
  }
  if (media.caption) {
    parts.push(`mediaCaption: ${media.caption}`);
  }
  if (media.isAnimated) {
    parts.push("mediaAnimated: true");
  }
  if (media.transcript) {
    parts.push(`mediaTranscript: ${media.transcript}`);
  }
  return parts.join("\n");
}
