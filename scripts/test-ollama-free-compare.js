import "dotenv/config";
import { appendFileSync } from "node:fs";

const LOG_PATH = "debug-9518ce.log";
const apiKey = process.env.TETOS_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY ?? "";
const baseUrl = (process.env.TETOS_OLLAMA_CLOUD_URL ?? "https://ollama.com").replace(/\/$/, "");

const models = [
  "gpt-oss:120b-cloud",
  "gemma4:31b-cloud",
  "gpt-oss:20b-cloud"
];

const prompt =
  "Voce e a Teto, IA com personalidade propria no WhatsApp. Responda em portugues, maximo 2 frases curtas e naturais.\nUsuario: oi teto, como voce ta?";

function log(entry) {
  const line = JSON.stringify({ sessionId: "9518ce", runId: "ollama-free-compare", ...entry, timestamp: Date.now() });
  appendFileSync(LOG_PATH, `${line}\n`);
  console.log(`[${entry.message}] ${entry.data?.model ?? ""} ${entry.data?.ms ?? ""}ms`);
  if (entry.data?.textPreview) console.log(`  → ${entry.data.textPreview}`);
  if (entry.data?.error) console.log(`  ✗ ${entry.data.error}`);
}

async function testModel(model) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.65, num_predict: 120 }
      }),
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    const ms = Date.now() - started;
    const text = await response.text();
    if (!response.ok) {
      log({
        hypothesisId: "H5",
        location: "test-ollama-free-compare.js",
        message: "model failed",
        data: { model, ms, status: response.status, error: text.slice(0, 180) }
      });
      return { ok: false, ms };
    }
    const data = JSON.parse(text);
    const reply = String(data.response ?? "").replace(/\s+/g, " ").trim();
    log({
      hypothesisId: "H5",
      location: "test-ollama-free-compare.js",
      message: "model ok",
      data: { model, ms, chars: reply.length, textPreview: reply.slice(0, 120) }
    });
    return { ok: true, ms, reply };
  } catch (err) {
    const ms = Date.now() - started;
    log({
      hypothesisId: "H5",
      location: "test-ollama-free-compare.js",
      message: "model error",
      data: { model, ms, error: String(err?.message ?? err).slice(0, 180) }
    });
    return { ok: false, ms };
  }
}

async function main() {
  if (!apiKey) {
    console.error("TETOS_OLLAMA_API_KEY ausente");
    process.exit(1);
  }
  log({
    hypothesisId: "H5",
    location: "test-ollama-free-compare.js",
    message: "benchmark start",
    data: { models, baseUrl }
  });

  const summary = {};
  for (const model of models) {
    const r = await testModel(model);
    summary[model] = r;
  }

  log({
    hypothesisId: "H6",
    location: "test-ollama-free-compare.js",
    message: "benchmark summary",
    data: Object.fromEntries(
      Object.entries(summary).map(([k, v]) => [k, { ok: v.ok, ms: v.ms, preview: v.reply?.slice(0, 80) }])
    )
  });
}

main();
