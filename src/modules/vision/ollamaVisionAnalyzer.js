import { existsSync, unlinkSync } from "node:fs";
import { extname } from "node:path";
import { extractFramesSellyeStyle } from "./mediaVisionEnrich.js";

const VIDEO_LIKE_EXT = new Set([".mp4", ".webm", ".mov", ".mkv", ".m4v", ".gif", ".avi"]);

function mediaKindLabel(mediaType, isAnimated) {
  if (mediaType === "sticker") return isAnimated ? "Sticker animada" : "Sticker";
  if (mediaType === "gif" || isAnimated) return "GIF/vídeo animado";
  if (mediaType === "video") return "Vídeo";
  return "Imagem";
}

/**
 * Visão via Ollama multimodal — mesmo fluxo da Sellye (OllamaMediaEnricher).
 * POST /api/chat com frames em base64; stickers usam 2 screenshots ffmpeg.
 */
export class OllamaVisionAnalyzer {
  constructor({ client = null, enabled = true } = {}) {
    this.client = client;
    this.enabled = Boolean(enabled);
  }

  isEnabled() {
    return this.enabled && Boolean(this.client?.chat);
  }

  async analyze({ filePath, mediaType = "image", isAnimated = false } = {}) {
    if (!this.isEnabled()) {
      console.log(
        "[repertorio:vision] ollama_skip",
        JSON.stringify({ reason: "analyzer_disabled_or_no_client", filePath, mediaType })
      );
      return null;
    }
    if (!filePath || !existsSync(filePath)) {
      console.log(
        "[repertorio:vision] ollama_skip",
        JSON.stringify({
          reason: !filePath ? "no_filePath" : "file_missing",
          filePath,
          mediaType
        })
      );
      return null;
    }

    const isSticker = mediaType === "sticker";
    const ext = extname(filePath).toLowerCase();
    const needsFrames =
      isSticker ||
      mediaType === "video" ||
      mediaType === "gif" ||
      isAnimated ||
      VIDEO_LIKE_EXT.has(ext);

    let frames = [filePath];
    let disposable = [];

    if (needsFrames) {
      const extracted = await extractFramesSellyeStyle(filePath);
      frames = extracted.frames ?? [];
      disposable = extracted.disposable ?? [];
    }

    if (!frames.length) {
      console.log(
        "[repertorio:vision] ollama_skip",
        JSON.stringify({ reason: "no_frames", filePath, mediaType, needsFrames })
      );
      return null;
    }

    console.log(
      "[repertorio:vision] ollama_analyze",
      JSON.stringify({
        filePath,
        mediaType,
        isSticker,
        frameCount: frames.length,
        needsFrames
      })
    );

    const textPrompt = isSticker
      ? "Descreva este sticker ou sticker animado em 5 palavras e diga em mais 5 quando usá-lo. Sem formatação."
      : needsFrames
        ? "Descreva brevemente o que acontece neste vídeo analisando estes frames, em uma frase natural."
        : "Descreva brevemente esta imagem em português, em uma frase natural.";

    try {
      const caption = await this.client.chat([{ role: "user", content: textPrompt }], {
        imagePaths: frames
      });
      if (!caption) {
        console.log(
          "[repertorio:vision] ollama_empty_caption",
          JSON.stringify({ filePath, mediaType, frameCount: frames.length })
        );
        return null;
      }

      const kind = mediaKindLabel(mediaType, isAnimated);
      const result =
        isSticker
          ? `${kind}: ${caption}`
          : needsFrames && frames.length > 1
            ? `${kind} (${frames.length} quadros): ${caption}`
            : `${kind}: ${caption}`;

      console.log(
        "[repertorio:vision] ollama_ok",
        JSON.stringify({
          filePath,
          mediaType,
          preview: result.slice(0, 120)
        })
      );
      return result;
    } catch (error) {
      const msg = error?.message ?? String(error);
      if (/model.*not found/i.test(msg)) {
        console.warn(
          "[repertorio:vision] Modelo de visão não encontrado no Ollama. " +
            "Cloud: defina TETOS_VISION_MODEL=gemma4:31b:cloud (ou outro multimodal da cloud). " +
            "Local: ollama pull llava (ou llama3.2-vision:11b) e use TETOS_VISION_MODEL correspondente."
        );
      }
      console.warn(
        "[repertorio:vision] ollama_error",
        JSON.stringify({
          filePath,
          mediaType,
          error: msg
        })
      );
      console.warn("[OllamaVisionAnalyzer] Falha ao descrever mídia:", msg);
      return null;
    } finally {
      for (const p of disposable) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
