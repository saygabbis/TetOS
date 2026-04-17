export class ChatCommandRouter {
  constructor({ operationRouter, documentModule } = {}) {
    this.operationRouter = operationRouter;
    this.documentModule = documentModule;
  }

  parse(text) {
    const raw = String(text ?? "").trim();
    if (!raw.startsWith("/")) return null;
    const [command, ...rest] = raw.split(/\s+/);
    const args = rest.join(" ").trim();

    if (command === "/docs") {
      return { type: "document_list", payload: {} };
    }
    if (command === "/doc-read") {
      return { type: "document_read", payload: { id: args } };
    }
    if (command === "/doc-write") {
      const match = args.match(/^([^\s]+)\s+([\s\S]+)$/);
      if (!match) return { error: "usage: /doc-write <id> <content>" };
      return {
        type: "document_write",
        payload: {
          id: match[1],
          content: match[2]
        }
      };
    }
    if (command === "/channel-mute") {
      return { type: "channel_admin", payload: { channelId: args, action: "mute" } };
    }
    if (command === "/channel-unmute") {
      return { type: "channel_admin", payload: { channelId: args, action: "unmute" } };
    }
    if (command === "/channel-authorize") {
      return { type: "channel_admin", payload: { channelId: args, action: "authorize" } };
    }
    if (command === "/channel-block") {
      return { type: "channel_admin", payload: { channelId: args, action: "block" } };
    }
    if (command === "/channel-mode") {
      const match = args.match(/^([^\s]+)\s+(active|passive|blocked)$/i);
      if (!match) return { error: "usage: /channel-mode <id> <active|passive|blocked>" };
      return {
        type: "channel_admin",
        payload: {
          channelId: match[1],
          action: "set_mode",
          mode: match[2].toLowerCase()
        }
      };
    }

    return { error: `unknown command: ${command}` };
  }

  execute({ text, userId } = {}) {
    const parsed = this.parse(text);
    if (!parsed) return null;
    if (parsed.error) return parsed;
    return this.operationRouter.execute({
      type: parsed.type,
      userId,
      payload: parsed.payload
    });
  }
}
