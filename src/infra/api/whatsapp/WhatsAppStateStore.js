import { watchFile, unwatchFile } from "node:fs";
import QRCode from "qrcode";
import { readJson, writeJson } from "../../utils/fileStore.js";

const STORE_PATH = process.env.TETOS_WHATSAPP_UI_STATE_PATH ?? "./data/whatsapp-ui-state.json";

const DEFAULT_STATE = {
  status: "disconnected",
  qrDataUrl: null,
  lastUpdated: null,
};

/** @type {Set<(state: object) => void>} */
const listeners = new Set();

function notify(state) {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {
      // listener opcional
    }
  }
}

function readState() {
  return { ...DEFAULT_STATE, ...readJson(STORE_PATH, DEFAULT_STATE) };
}

function writeState(patch) {
  const next = {
    ...readState(),
    ...patch,
    lastUpdated: new Date().toISOString(),
  };
  writeJson(STORE_PATH, next);
  notify(next);
  return next;
}

export const whatsAppStateStore = {
  path: STORE_PATH,
  get: readState,
  setStatus(status) {
    const patch = { status: String(status ?? "disconnected") };
    if (status === "connected") {
      patch.qrDataUrl = null;
    }
    return writeState(patch);
  },
  async setQr(qrString) {
    if (!qrString) {
      return writeState({ status: "needs_qr", qrDataUrl: null });
    }
    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(qrString, { margin: 1, width: 280 });
    } catch {
      qrDataUrl = null;
    }
    return writeState({ status: "needs_qr", qrDataUrl });
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

let watchStarted = false;

/** Publica mudanças de estado quando o runner WhatsApp atualiza o JSON (processo separado). */
export function attachWhatsAppStateFileWatcher(onChange) {
  if (watchStarted || typeof onChange !== "function") return;
  watchStarted = true;
  let lastSerialized = JSON.stringify(readState());
  watchFile(STORE_PATH, { interval: 1500 }, () => {
    const next = readState();
    const serialized = JSON.stringify(next);
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    onChange(next);
  });
}

export function detachWhatsAppStateFileWatcher() {
  if (!watchStarted) return;
  unwatchFile(STORE_PATH);
  watchStarted = false;
}
