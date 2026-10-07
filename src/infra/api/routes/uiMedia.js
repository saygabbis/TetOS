import { resolve } from "node:path";
import express from "express";
import { requireSession, requireSessionOrQueryToken } from "../auth/sessionAuth.js";
import {
  isValidUiMediaId,
  mimeFromExt,
  resolveUiMediaPath,
  saveUiMediaBuffer,
  toMediaRef
} from "../../../integrations/ui/uiMediaStore.js";
import { UI_MEDIA_COMMANDS } from "../../../integrations/ui/uiMediaService.js";
import {
  runUiGenerateImage,
  runUiMediaCommand,
  runUiSaveSticker,
  runUiUrlDownload
} from "../../../integrations/ui/uiMediaActions.js";
import { isUrlMediaCommand } from "../../../integrations/whatsapp/mediaCommandParser.js";

function uploadLimitBytes() {
  const mb = Number(process.env.TETOS_UI_UPLOAD_LIMIT_MB ?? 64);
  return Math.max(1, Number.isFinite(mb) ? mb : 64) * 1024 * 1024;
}

function decodeFileName(raw) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

/**
 * Rotas de mídia da interface: upload, download, repertório de figurinhas e ações sobre mídia
 * (os botões da UI equivalentes aos comandos `.sticker`, `.toimg`, `.removebg`... do WhatsApp).
 */
export function registerUiMediaRoutes(app, { service, threadStore, persistThreadStore, uiBus, runtime, ensureThread }) {
  app.post(
    "/ui/media",
    requireSession,
    express.raw({ type: () => true, limit: uploadLimitBytes() }),
    (req, res) => {
      const buffer = req.body;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return res.status(400).json({ error: "arquivo vazio" });
      }
      const fileName = decodeFileName(req.headers["x-file-name"]);
      const mimeType = String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0];
      const saved = saveUiMediaBuffer(buffer, { dir: service.dir, mimeType, fileName });
      return res.json({ media: toMediaRef(saved) });
    }
  );

  app.get("/ui/media/:id", requireSessionOrQueryToken, (req, res) => {
    const file = isValidUiMediaId(req.params.id) ? resolveUiMediaPath(service.dir, req.params.id) : null;
    if (!file) return res.status(404).json({ error: "mídia não encontrada" });
    res.setHeader("Content-Type", mimeFromExt(req.params.id.split(".").pop()));
    res.setHeader("Cache-Control", "private, max-age=86400");
    return res.sendFile(file);
  });

  app.get("/ui/stickers", requireSession, (_req, res) => {
    return res.json({ stickers: service.listStickers() });
  });

  app.get("/ui/stickers/:key/file", requireSessionOrQueryToken, (req, res) => {
    const file = service.stickerFilePath(req.params.key);
    if (!file) return res.status(404).json({ error: "figurinha não encontrada" });
    res.setHeader("Content-Type", "image/webp");
    res.setHeader("Cache-Control", "private, max-age=3600");
    return res.sendFile(resolve(file));
  });

  app.delete("/ui/stickers/:key", requireSession, (req, res) => {
    const result = service.removeSticker(req.params.key);
    if (!result.ok) {
      return res.status(result.reason === "builtin" ? 403 : 404).json({ error: result.reason });
    }
    return res.json({ ok: true, key: result.key });
  });

  /** Anexo pronto para enviar a figurinha do repertório como mensagem do usuário. */
  app.post("/ui/stickers/:key/use", requireSession, (req, res) => {
    const attachment = service.stickerAttachment(req.params.key);
    if (!attachment) return res.status(404).json({ error: "figurinha não encontrada" });
    return res.json({ media: attachment });
  });

  app.post("/ui/threads/:id/media-actions", requireSession, async (req, res) => {
    const thread = threadStore.get(req.params.id) ?? ensureThread(threadStore, req.params.id);
    const { command, args, mediaRef, url, prompt, key, label } = req.body ?? {};
    const cmd = String(command ?? "").toLowerCase();
    const userId = req.body?.userId ?? "ui-user";
    const ctx = { runtime, service, uiBus, thread, userId };
    const list = Array.isArray(args) ? args.map(String) : [];

    let ok;
    if (UI_MEDIA_COMMANDS.includes(cmd)) {
      ok = await runUiMediaCommand(ctx, { command: cmd, args: list, mediaRef });
    } else if (cmd === "save_sticker") {
      ok = await runUiSaveSticker(ctx, { mediaRef, key: key ?? null, label: label ?? null });
    } else if (cmd === "gerar") {
      if (!String(prompt ?? "").trim()) return res.status(400).json({ error: "prompt é obrigatório" });
      ok = await runUiGenerateImage(ctx, { prompt: String(prompt) });
    } else if (isUrlMediaCommand(cmd)) {
      if (!String(url ?? "").trim()) return res.status(400).json({ error: "url é obrigatória" });
      ok = await runUiUrlDownload(ctx, { command: cmd, url: String(url), args: list });
    } else {
      return res.status(400).json({ error: `comando desconhecido: ${command}` });
    }

    persistThreadStore(threadStore);
    return res.json({ ok: Boolean(ok) });
  });
}
