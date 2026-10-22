import { requireSession } from "../auth/sessionAuth.js";
import { DEFAULTS } from "../../config/defaults.js";
import { readJson, writeJson } from "../../utils/fileStore.js";

/** Lido na hora (não no import) — assim TETOS_UI_SETTINGS_PATH definido depois também vale (ex.: testes). */
const settingsPath = () => process.env.TETOS_UI_SETTINGS_PATH ?? "./data/uiSettings.json";

const DEFAULT_SETTINGS = {
  locale: "pt-BR",
  theme: "system",
  voiceEnabled: true,
  voiceProfile: "default",
  llmModel: DEFAULTS.model,
  memoryPrivacy: "standard",
  automateConfirmByDefault: true,
  presencePublic: false,
};

const WRITABLE_KEYS = new Set([
  "locale",
  "theme",
  "voiceEnabled",
  "voiceProfile",
  "llmModel",
  "memoryPrivacy",
  "automateConfirmByDefault",
  "presencePublic",
]);

function loadSettings(deviceRegistry, deviceGateway) {
  const stored = readJson(settingsPath(), {});
  const devices = deviceRegistry?.list?.() ?? [];
  const anyOnline = devices.some((d) => deviceGateway?.isDeviceConnected?.(d.id));
  const automateConnectionStatus = anyOnline ? "connected" : devices.length ? "offline" : "unknown";

  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    llmModel: stored.llmModel ?? DEFAULTS.model,
    automateConnectionStatus,
  };
}

export function registerUiSettingsRoutes(app, deviceRegistry, deviceGateway) {
  app.get("/ui/settings", requireSession, (_req, res) => {
    return res.json({ settings: loadSettings(deviceRegistry, deviceGateway) });
  });

  app.patch("/ui/settings", requireSession, (req, res) => {
    const body = req.body ?? {};
    const current = readJson(settingsPath(), {});
    const next = { ...current };

    for (const key of Object.keys(body)) {
      if (!WRITABLE_KEYS.has(key)) continue;
      next[key] = body[key];
    }

    writeJson(settingsPath(), next);
    return res.json({
      settings: loadSettings(deviceRegistry, deviceGateway),
    });
  });
}
