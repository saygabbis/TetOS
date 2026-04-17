import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

function normalizeTranscript(text = "") {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function runPythonTranscription(filePath) {
  const script = [
    "from faster_whisper import WhisperModel",
    "import json, sys",
    "model = WhisperModel('tiny', device='cpu', compute_type='int8')",
    "segments, info = model.transcribe(sys.argv[1], vad_filter=True)",
    "text = ' '.join((segment.text or '').strip() for segment in segments).strip()",
    "print(json.dumps({'text': text, 'language': getattr(info, 'language', None)}))"
  ].join("; ");

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

export class AudioTranscriber {
  async transcribe({ filePath, mimetype = "audio/ogg", seconds = null } = {}) {
    if (!filePath) return null;
    try {
      const result = await runPythonTranscription(filePath);
      const normalized = normalizeTranscript(result?.text ?? "");
      if (normalized) {
        return normalized;
      }
    } catch {
      // fallback below
    }

    const size = readFileSync(filePath).byteLength;
    const hints = [];
    hints.push("Áudio recebido por WhatsApp.");
    hints.push(`Arquivo: ${filePath}`);
    hints.push(`Tipo: ${mimetype}`);
    if (seconds) hints.push(`Duração aproximada: ${seconds}s`);
    hints.push(`Tamanho: ${size} bytes`);
    hints.push("Não foi possível transcrever automaticamente; trate como áudio recebido e peça confirmação breve se o conteúdo for necessário.");
    return normalizeTranscript(hints.join(" "));
  }
}
