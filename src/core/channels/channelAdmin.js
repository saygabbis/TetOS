export class ChannelAdminService {
  constructor(channelRegistry) {
    this.channelRegistry = channelRegistry;
  }

  execute({ channelId, userId = "default", action, patch = {} } = {}) {
    if (!channelId || !action) return null;

    if (action === "authorize") {
      return this.channelRegistry.upsert(channelId, { authorized: true, muted: false }, userId);
    }
    if (action === "block") {
      return this.channelRegistry.upsert(channelId, { authorized: false, muted: true, mode: "blocked" }, userId);
    }
    if (action === "mute") {
      return this.channelRegistry.upsert(channelId, { muted: true }, userId);
    }
    if (action === "unmute") {
      return this.channelRegistry.upsert(channelId, { muted: false }, userId);
    }
    if (action === "set_mode") {
      return this.channelRegistry.upsert(channelId, { mode: patch.mode ?? "active" }, userId);
    }
    return null;
  }
}
