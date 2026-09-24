import { requireSession } from "../auth/sessionAuth.js";
import { readJson, writeJson } from "../../utils/fileStore.js";
import { whatsAppStateStore } from "../whatsapp/WhatsAppStateStore.js";
import { publishChannelStatus } from "../ui/uiEventPublishers.js";

const PREFS_PATH = process.env.TETOS_UI_CHANNEL_PREFS_PATH ?? "./data/ui-channel-preferences.json";

const DEFAULT_PREFS = {
  whatsapp: {
    dm: true,
    groupsWhenMentioned: true,
    respondWithoutCall: false,
  },
};

function loadPrefs() {
  return { ...DEFAULT_PREFS, ...readJson(PREFS_PATH, DEFAULT_PREFS) };
}

function savePrefs(data) {
  writeJson(PREFS_PATH, data);
}

function mapWhatsAppStatus(raw) {
  const status = String(raw ?? "disconnected");
  if (status === "connected") return "online";
  if (status === "needs_qr") return "needs_auth";
  if (status === "connecting") return "connecting";
  return "offline";
}

export function registerUiChannelRoutes(app, runtime, uiBus) {
  app.get("/ui/channels", requireSession, (_req, res) => {
    const waState = whatsAppStateStore.get();
    const prefs = loadPrefs();
    const channels = [
      {
        id: "whatsapp",
        label: "WhatsApp",
        status: mapWhatsAppStatus(waState.status),
        rawStatus: waState.status,
        qrDataUrl: waState.qrDataUrl ?? null,
        lastUpdated: waState.lastUpdated,
        preferences: prefs.whatsapp ?? DEFAULT_PREFS.whatsapp,
      },
      {
        id: "ui-desktop",
        label: "App desktop",
        status: "online",
        preferences: { dm: true, groupsWhenMentioned: false, respondWithoutCall: true },
      },
    ];
    return res.json({ channels });
  });

  app.patch("/ui/channels/:id/preferences", requireSession, (req, res) => {
    const channelId = String(req.params.id ?? "");
    const patch = req.body ?? {};
    const prefs = loadPrefs();

    if (channelId === "whatsapp") {
      const current = { ...DEFAULT_PREFS.whatsapp, ...(prefs.whatsapp ?? {}) };
      const next = {
        dm: patch.dm !== undefined ? Boolean(patch.dm) : current.dm,
        groupsWhenMentioned:
          patch.groupsWhenMentioned !== undefined
            ? Boolean(patch.groupsWhenMentioned)
            : current.groupsWhenMentioned,
        respondWithoutCall:
          patch.respondWithoutCall !== undefined
            ? Boolean(patch.respondWithoutCall)
            : current.respondWithoutCall,
      };
      prefs.whatsapp = next;
      savePrefs(prefs);

      const { tetoActivation, channelRegistry, defaults } = runtime;
      if (tetoActivation?.isActivationRequired?.()) {
        const ownerId = defaults?.learningTargetUserId ?? "default";
        if (next.dm) {
          tetoActivation.activateDm(ownerId, { activatedBy: "ui-desktop" });
        } else {
          tetoActivation.deactivateDm(ownerId);
        }
      }

      if (patch.groupsWhenMentioned !== undefined) {
        const passivePatch = next.groupsWhenMentioned ? { mode: "passive" } : { mode: "active" };
        for (const key of Object.keys(channelRegistry.data?.channels ?? {})) {
          if (key.includes("@g.us") || key.startsWith("group:")) {
            channelRegistry.upsert(key, passivePatch);
          }
        }
      }

      publishChannelStatus(uiBus, {
        channelId: "whatsapp",
        status: mapWhatsAppStatus(whatsAppStateStore.get().status),
      });

      return res.json({ ok: true, preferences: next });
    }

    return res.status(404).json({ error: "canal não encontrado" });
  });
}
