/**
 * Gateway de PCs que fala com o AutoMate pelo hub (`/agent-link`, frames `call`).
 * Mesma interface usada pelo AutomateClient: `callTool(deviceId, name, args)`.
 */
export class HubDeviceGateway {
  constructor({ getLink }) {
    this.getLink = getLink;
  }

  /** Escolhe o PC: o pedido, se o hub o conhece online; senão o único/primeiro PC online. */
  resolveDeviceId(requested) {
    const link = this.getLink();
    if (!link?.isReady()) return null;
    const devices = link.listDevices();
    const hit = devices.find((d) => d.id === requested);
    if (hit) return hit.online ? hit.id : null;
    return devices.find((d) => d.online)?.id ?? null;
  }

  isDeviceConnected(deviceId) {
    return this.resolveDeviceId(deviceId) !== null;
  }

  async callTool(deviceId, name, args) {
    const link = this.getLink();
    if (!link?.isReady()) throw new Error("Hub offline");
    const target = this.resolveDeviceId(deviceId);
    if (!target) throw new Error("Device offline");
    const reply = await link.request({ t: "call", deviceId: target, tool: name, args: args ?? {} });
    const result = reply.result;
    if (result?.isError) {
      const msg = Array.isArray(result.content) && result.content[0]?.text ? result.content[0].text : "erro MCP";
      throw new Error(msg);
    }
    return result;
  }
}

/** Prefere o PC ligado direto ao `/device-link` da TetOS; cai para o hub quando não há. */
export class CompositeDeviceGateway {
  constructor({ local, hub }) {
    this.local = local;
    this.hub = hub;
  }

  attach(server) {
    return this.local.attach(server);
  }

  isDeviceConnected(deviceId) {
    return this.local.isDeviceConnected(deviceId) || this.hub.isDeviceConnected(deviceId);
  }

  closeDevice(deviceId) {
    this.local.closeDevice(deviceId);
  }

  callTool(deviceId, name, args) {
    if (this.local.isDeviceConnected(deviceId)) return this.local.callTool(deviceId, name, args);
    return this.hub.callTool(deviceId, name, args);
  }
}
