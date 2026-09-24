import { randomBytes } from "node:crypto";
import { readJson, writeJson } from "../../utils/fileStore.js";

const DEFAULT_PATH = "./data/deviceTokens.json";
const DEFAULT_TTL_MS = Number(process.env.TETOS_DEVICE_TOKEN_TTL_MS ?? 90 * 24 * 60 * 60 * 1000);

export class DeviceRegistry {
  constructor(filePath = process.env.TETOS_DEVICE_TOKENS_PATH ?? DEFAULT_PATH) {
    this.filePath = filePath;
    this.data = readJson(this.filePath, { devices: [] });
  }

  persist() {
    writeJson(this.filePath, this.data);
  }

  validate(token, deviceId) {
    const device = this.data.devices.find((d) => d.id === deviceId && d.token === token);
    if (!device) return { ok: false, reason: "token inválido" };
    if (device.revokedAt) return { ok: false, reason: "device revogado" };
    if (device.expiresAt && Date.parse(device.expiresAt) < Date.now()) {
      return { ok: false, reason: "token expirado" };
    }
    return { ok: true, device };
  }

  revoke(deviceId) {
    const device = this.data.devices.find((d) => d.id === deviceId);
    if (!device) return false;
    device.revokedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  issue(deviceId, userId = "default", ttlMs = DEFAULT_TTL_MS) {
    const token = `dev_${randomBytes(24).toString("hex")}`;
    const entry = {
      id: deviceId,
      userId,
      token,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    };
    this.data.devices = this.data.devices.filter((d) => d.id !== deviceId);
    this.data.devices.push(entry);
    this.persist();
    return entry;
  }

  list() {
    return this.data.devices.map(({ id, userId, createdAt, revokedAt, expiresAt }) => ({
      id,
      userId,
      createdAt,
      revoked: Boolean(revokedAt),
      expiresAt,
    }));
  }
}
