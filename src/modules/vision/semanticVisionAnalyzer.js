import { spawn } from "node:child_process";

function normalizeText(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function runSemanticVision(filePath) {
  const script = `
from transformers import BlipProcessor, BlipForConditionalGeneration
from PIL import Image, ImageSequence
import json, sys
path = sys.argv[1]
img = Image.open(path)
frame_count = getattr(img, 'n_frames', 1)
if frame_count > 1:
    image = next(ImageSequence.Iterator(img)).convert('RGB')
else:
    image = img.convert('RGB')
processor = BlipProcessor.from_pretrained('Salesforce/blip-image-captioning-base')
model = BlipForConditionalGeneration.from_pretrained('Salesforce/blip-image-captioning-base')
inputs = processor(images=image, return_tensors='pt')
out = model.generate(**inputs, max_new_tokens=60)
caption = processor.decode(out[0], skip_special_tokens=True)
print(json.dumps({'caption': caption, 'frames': frame_count}))
`.trim();

  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-c", script, filePath], { stdio: ["ignore", "pipe", "pipe"] });
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

export class SemanticVisionAnalyzer {
  async analyze({ filePath, mediaType = "image", isAnimated = false } = {}) {
    if (!filePath) return null;
    try {
      const result = await runSemanticVision(filePath);
      const caption = normalizeText(result?.caption ?? "");
      const frames = Number(result?.frames ?? 1);
      if (caption) {
        return normalizeText(`${mediaType === "sticker" ? "Sticker" : "Imagem"}${isAnimated || frames > 1 ? " animada" : ""}: ${caption}`);
      }
    } catch {
      // fallback below
    }
    return null;
  }
}
