import { spawn } from "node:child_process";

function normalizeText(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function runPythonImageInspection(filePath, mediaType = "image") {
  const script = [
    "from PIL import Image, ImageSequence",
    "import json, sys",
    "path = sys.argv[1]",
    "media_type = sys.argv[2]",
    "img = Image.open(path)",
    "frame_count = getattr(img, 'n_frames', 1)",
    "if frame_count > 1:",
    "    frame = next(ImageSequence.Iterator(img)).convert('RGB')",
    "else:",
    "    frame = img.convert('RGB')",
    "w, h = frame.size",
    "small = frame.resize((1, 1))",
    "r, g, b = small.getpixel((0, 0))",
    "brightness = (r + g + b) / 3",
    "tone = 'escura' if brightness < 85 else 'clara' if brightness > 170 else 'média'",
    "dominant = 'avermelhada' if r >= g and r >= b else 'esverdeada' if g >= r and g >= b else 'azulada'",
    "animated = frame_count > 1",
    "parts = [f'Mídia {media_type}', f'{w}x{h}', f'tonalidade {tone}', f'cor predominante {dominant}']",
    "if animated:",
    "    parts.append(f'animada com {frame_count} frames')",
    "print(json.dumps({'description': '; '.join(parts)}))"
  ].join("; ");

  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", script, filePath, mediaType], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `python exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(error);
      }
    });
  });
}

export class VisualAnalyzer {
  async analyze({ filePath, mediaType = "image", isAnimated = false } = {}) {
    if (!filePath) return null;
    try {
      const result = await runPythonImageInspection(filePath, mediaType);
      const normalized = normalizeText(result?.description ?? "");
      if (normalized) return normalized;
    } catch {
      // fallback below
    }
    return normalizeText(
      `${mediaType === "sticker" ? "Sticker" : "Imagem"} analisada localmente${isAnimated ? " e animada" : ""}. Arquivo persistido em ${filePath}. A análise semântica não ficou disponível, então use apenas pistas básicas desta mídia.`
    );
  }
}
