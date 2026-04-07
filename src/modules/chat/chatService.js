export class ChatService {
  constructor(agent) {
    this.agent = agent;
  }

  async handleMessage(message, meta = {}, history = null) {
    return this.agent.respond(message, meta, history);
  }
}
