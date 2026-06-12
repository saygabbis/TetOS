/**
 * Subprocesso isolado — evita conflito de versões do sharp entre imgly e o projeto.
 * Uso: node removeBgWorker.mjs <inputPath> <outputPath> [model]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeBackground } from "@imgly/background-removal-node";

const [inputPath, outputPath, model = "small"] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: node removeBgWorker.mjs <input> <output> [model]");
  process.exit(2);
}

const IMGLY_DIST = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../node_modules/@imgly/background-removal-node/dist"
);
const publicPath = `${pathToFileURL(IMGLY_DIST).href}/`;

function resolveImglyModel(raw) {
  const m = String(raw ?? "small").toLowerCase();
  if (m === "large" || m === "forte") return "medium";
  if (m === "medium" || m === "media") return "medium";
  return "small";
}

const chain = [];
const primary = resolveImglyModel(model);
chain.push(primary);
if (primary !== "small") chain.push("small");

let lastError = null;
for (const imglyModel of chain) {
  try {
    const blob = await removeBackground(pathToFileURL(inputPath).href, {
      publicPath,
      model: imglyModel,
      output: { format: "image/png", quality: 0.9 }
    });
    writeFileSync(outputPath, Buffer.from(await blob.arrayBuffer()));
    process.exit(0);
  } catch (error) {
    lastError = error;
    const msg = String(error?.message ?? error);
    if (!/not found|publicPath/i.test(msg)) break;
  }
}

console.error(lastError?.message ?? lastError ?? "falha imgly");
process.exit(1);
