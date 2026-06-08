import "dotenv/config";
import { appendFileSync } from "node:fs";
import { MiniMaxClient } from "../src/core/brain/minimaxClient.js";

const LOG_PATH = "debug-9518ce.log";
const apiKey = process.env.TETOS_MINIMAX_API_KEY ?? "";

function log(entry) {
  const line = JSON.stringify({ sessionId: "9518ce", runId: "minimax-compare", ...entry, timestamp: Date.now() });
  appendFileSync(LOG_PATH, `${line}\n`);
  console.log(`[${entry.hypothesisId ?? "?"}] ${entry.message}`);
  if (entry.data?.textPreview) console.log(`  → ${entry.data.textPreview}`);
  if (entry.data?.error) console.log(`  ✗ ${entry.data.error}`);
}

const scenarios = [
  {
    id: "persona",
    prompt:
      "Voce e a Teto, IA com personalidade propria no WhatsApp. Responda em portugues, maximo 2 frases curtas e naturais, sem emoji excessivo.\nUsuario: oi teto, como voce ta?"
  },
  {
    id: "reasoning",
    prompt: "Responda em uma frase: qual e maior, 9.11 ou 9.9? Explique brevemente."
  },
  {
    id: "code",
    prompt: "Em JavaScript, escreva uma funcao `isPalindrome(s)` em no maximo 6 linhas. So codigo, sem explicacao."
  }
];

const models = [
  { name: "MiniMax-M2.7", thinking: null },
  { name: "MiniMax-M2.7-highspeed", thinking: null },
  { name: "MiniMax-M3", thinking: { type: "enabled" } },
  { name: "MiniMax-M3-fast", thinking: { type: "disabled" } }
];

async function runModel(modelName, thinking, scenario) {
  const client = new MiniMaxClient({
    apiKey,
    model: modelName.replace("-fast", ""),
    temperature: 0.65,
    numPredict: 150,
    timeoutMs: 60000,
    thinking
  });
  const started = Date.now();
  try {
    const text = await client.generate(scenario.prompt);
    const ms = Date.now() - started;
    log({
      hypothesisId: "H3",
      location: "test-minimax-compare.js",
      message: "model scenario ok",
      data: {
        model: modelName,
        scenario: scenario.id,
        ms,
        chars: text.length,
        textPreview: text.replace(/\s+/g, " ").slice(0, 120)
      }
    });
    return { ok: true, ms, text };
  } catch (err) {
    const ms = Date.now() - started;
    log({
      hypothesisId: "H3",
      location: "test-minimax-compare.js",
      message: "model scenario failed",
      data: {
        model: modelName,
        scenario: scenario.id,
        ms,
        error: String(err?.message ?? err).slice(0, 200)
      }
    });
    return { ok: false, ms, error: err };
  }
}

async function main() {
  if (!apiKey) {
    console.error("TETOS_MINIMAX_API_KEY ausente no .env");
    process.exit(1);
  }

  log({
    hypothesisId: "H2",
    location: "test-minimax-compare.js",
    message: "benchmark start",
    data: { models: models.map((m) => m.name), scenarios: scenarios.map((s) => s.id) }
  });

  const summary = {};
  for (const model of models) {
    summary[model.name] = { ok: 0, fail: 0, totalMs: 0 };
    for (const scenario of scenarios) {
      const result = await runModel(model.name, model.thinking, scenario);
      if (result.ok) {
        summary[model.name].ok += 1;
        summary[model.name].totalMs += result.ms;
      } else {
        summary[model.name].fail += 1;
      }
    }
  }

  log({
    hypothesisId: "H4",
    location: "test-minimax-compare.js",
    message: "benchmark summary",
    data: summary
  });

  console.log("\nResumo (ms total nos cenários ok):");
  for (const [name, s] of Object.entries(summary)) {
    console.log(`  ${name}: ok=${s.ok} fail=${s.fail} ms=${s.totalMs}`);
  }
}

main().catch((err) => {
  log({
    hypothesisId: "H2",
    location: "test-minimax-compare.js",
    message: "benchmark crash",
    data: { error: String(err?.message ?? err) }
  });
  process.exit(1);
});
