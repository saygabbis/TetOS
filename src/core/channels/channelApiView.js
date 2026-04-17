export function buildChannelView(channel) {
  if (!channel) return null;
  return {
    id: channel.id,
    mode: channel.mode,
    authorized: channel.authorized,
    muted: channel.muted,
    isGroup: channel.isGroup,
    participantCount: channel.participantCount ?? 0,
    participants: channel.participants ?? [],
    updatedAt: channel.updatedAt,
    createdAt: channel.createdAt
  };
}
