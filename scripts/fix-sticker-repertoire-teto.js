#!/usr/bin/env node
/**
 * Renomeia figurinhas fwd-* e normaliza catálogo para Kasane Teto.
 *
 * Uso:
 *   node scripts/fix-sticker-repertoire-teto.js           # dry-run (só mostra)
 *   node scripts/fix-sticker-repertoire-teto.js --apply   # aplica renomeações + catalog.json
 */
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "../src/infra/utils/fileStore.js";
import { slugifyStickerKey } from "../src/integrations/whatsapp/stickerVisionNaming.js";

const STICKERS_DIR = process.env.TETOS_STICKERS_PATH ?? "./data/stickers";
const APPLY = process.argv.includes("--apply");

/** @type {Record<string, { key: string, visionDescription: string, displayName: string }>} */
const FWD_FIXES = {
  "fwd-6a6ee333": {
    key: "teto-chibi-chorando",
    visionDescription:
      "Kasane Teto chibi chorando com lágrimas azuis. Quando estiver triste ou emocionada",
    displayName: "Kasane Teto chorando (chibi)"
  },
  "fwd-9d416cb7": {
    key: "teto-3d-maos-juntas",
    visionDescription:
      "Kasane Teto 3D com língua de fora e mãos juntas pedindo. Tom fofo ou implorando",
    displayName: "Kasane Teto pedindo fofo"
  },
  "fwd-39bcd94c": {
    key: "teto-miku-meme-armpit",
    visionDescription:
      "Kasane Teto sorrindo enquanto Hatsune Miku encosta no sovaco dela. Meme absurdo entre as duas",
    displayName: "Teto e Miku meme"
  },
  "fwd-727fa8e9": {
    key: "teto-pixel-sorriso-marota",
    visionDescription:
      "Kasane Teto pixel art com sorriso marota e brocas rosas. Deboche leve ou confiança",
    displayName: "Kasane Teto marota (pixel)"
  },
  "fwd-904b021a": {
    key: "teto-pixel-comendo",
    visionDescription:
      "Kasane Teto pixel art comendo fatia de pizza com blush. Quando estiver com fome ou comendo",
    displayName: "Kasane Teto comendo"
  },
  "fwd-19530dbc": {
    key: "teto-feliz-pose",
    visionDescription:
      "Kasane Teto feliz de olhos fechados em pose animada. Alegria e energia",
    displayName: "Kasane Teto feliz"
  },
  "fwd-45859b76": {
    key: "teto-cosplay-lingua-fora",
    visionDescription:
      "Cosplay de Kasane Teto mostrando a língua em expressão brincalhona. Zoeira e deboche",
    displayName: "Kasane Teto cosplay língua"
  },
  "fwd-adbd72b2": {
    key: "teto-dois-baguettes",
    visionDescription:
      'Kasane Teto com casaco azul segurando dois baguetes — meme "Today I will eat two baguettes"',
    displayName: "Kasane Teto dois baguettes"
  },
  "fwd-b7dfd017": {
    key: "teto-chibi-perfil-sorriso",
    visionDescription: "Kasane Teto chibi de perfil sorrindo. Fofura discreta",
    displayName: "Kasane Teto chibi perfil"
  },
  "fwd-bc72ae48": {
    key: "teto-cansada-smug",
    visionDescription:
      "Kasane Teto com olhar cansado e smug no uniforme. Cansaço, deboche ou 'tanto faz'",
    displayName: "Kasane Teto cansada smug"
  },
  "fwd-bc608818": {
    key: "teto-passaro-meme",
    visionDescription:
      "Meme da Kasane Teto editada num passarinho com sorriso debochado. Absurdo e ironia",
    displayName: "Teto passarinho meme"
  },
  "fwd-db063666": {
    key: "teto-escudo-3d",
    visionDescription:
      "Kasane Teto 3D com escudo de madeira e língua de fora. Tom brincalhão ou defensivo",
    displayName: "Kasane Teto com escudo"
  },
  "fwd-dca67dbb": {
    key: "teto-3d-smug-closeup",
    visionDescription:
      "Close 3D da Kasane Teto com olhar smug e marquinhas sob os olhos. Confiança e deboche",
    displayName: "Kasane Teto smug 3D"
  },
  "fwd-e0de3006": {
    key: "teto-chibi-emocionada",
    visionDescription:
      "Kasane Teto chibi super emocionada com notas musicais. Felicidade extrema ou hype",
    displayName: "Kasane Teto emocionada"
  },
  "fwd-fc9d27bf": {
    key: "teto-its-peak",
    visionDescription:
      'Kasane Teto apontando para balão "It\'s Peak" impressionada. Quando algo for épico demais',
    displayName: "Kasane Teto It's Peak"
  }
};

/** Renomeia chaves genéricas (menina/garota…) para prefixo teto- */
/** @type {Record<string, { key: string, visionDescription?: string, displayName?: string }>} */
const KEY_MIGRATIONS = {
  "menina-ruiva-brava-irritada": {
    key: "teto-brava-irritada",
    visionDescription:
      "Kasane Teto brava e irritada gritando. Quando estiver muito irritada",
    displayName: "Kasane Teto brava"
  },
  "personagem-ruiva-expressao-triste": {
    key: "teto-triste",
    visionDescription:
      "Kasane Teto com expressão triste. Quando sentir tristeza ou decepção",
    displayName: "Kasane Teto triste"
  },
  "menina-ruiva-olhar-cansado": {
    key: "teto-olhar-cansado",
    visionDescription:
      "Kasane Teto com olhar cansado. Quando estiver exausta ou desanimada",
    displayName: "Kasane Teto cansada"
  },
  "menina-ruiva-confusa-duvida": {
    key: "teto-confusa",
    visionDescription:
      "Kasane Teto confusa com dúvida. Quando não entender algo",
    displayName: "Kasane Teto confusa"
  },
  "menina-ruiva-fofa-coracao": {
    key: "teto-fofa-coracao",
    visionDescription:
      "Kasane Teto fofa com coração. Para expressar amor e carinho",
    displayName: "Kasane Teto coração"
  },
  "menina-rosa-borrada-chapeu": {
    key: "teto-rosa-borrada-chapeu",
    visionDescription:
      "Kasane Teto rosa borrada com chapéu. Tom misterioso ou confuso",
    displayName: "Kasane Teto misteriosa"
  },
  "menina-ruiva-fofa-expressar": {
    key: "teto-fofa-animada",
    visionDescription:
      "Kasane Teto fofa e animada. Alegria e fofura",
    displayName: "Kasane Teto animada"
  },
  "menina-rosa-paes-franceses": {
    key: "teto-paes-franceses",
    visionDescription:
      "Kasane Teto com pães franceses. Para convidar alguém para comer",
    displayName: "Kasane Teto com pães"
  },
  "menina-ruiva-comendo-paozinho": {
    key: "teto-comendo-pao",
    visionDescription:
      "Kasane Teto comendo pãozinho. Quando estiver com fome",
    displayName: "Kasane Teto comendo pão"
  },
  "personagem-vermelha-pera-confusa": {
    key: "teto-pera-confusa",
    visionDescription:
      "Kasane Teto e uma pera confusas. Quando não reconhecer alguém online",
    displayName: "Kasane Teto pera confusa"
  },
  "garota-anime-rosa-timida": {
    key: "teto-timida-flerte",
    visionDescription:
      "Kasane Teto tímida em pose sugestiva. Flerte ou vergonha feliz",
    displayName: "Kasane Teto tímida"
  },
  "menina-anime-rosa-lingua": {
    key: "teto-lingua-fora-anime",
    visionDescription:
      "Kasane Teto com língua de fora. Brincadeira, deboche e diversão",
    displayName: "Kasane Teto língua fora"
  },
  "garota-anime-capacete-militar": {
    key: "teto-capacete-militar",
    visionDescription:
      "Kasane Teto com capacete militar. Choque, guerra ou drama exagerado",
    displayName: "Kasane Teto capacete"
  },
  "cosplayer-ruiva-fazendo-dois": {
    key: "teto-cosplay-joinha",
    visionDescription:
      "Cosplay de Kasane Teto fazendo dois joinhas. Concordar com alguém",
    displayName: "Kasane Teto cosplay joinha"
  },
  "cosplayer-ruiva-fazendo-careta": {
    key: "teto-cosplay-careta",
    visionDescription:
      "Cosplay de Kasane Teto fazendo careta engraçada. Zoeira online",
    displayName: "Kasane Teto cosplay careta"
  },
  "menina-rosa-texto-absolute": {
    key: "teto-absolute-cinema",
    visionDescription:
      'Kasane Teto com texto "Absolute Cinema". Quando algo for épico demais',
    displayName: "Kasane Teto Absolute Cinema"
  },
  "menina-rosa-recebendo-carinho": {
    key: "teto-carinho-cabeca",
    visionDescription:
      "Kasane Teto recebendo carinho na cabeça. Fofura e afeto",
    displayName: "Kasane Teto carinho"
  },
  "garota-ruiva-espiando-pela": {
    key: "teto-espiando-porta",
    visionDescription:
      "Kasane Teto espiando pela porta. Curiosidade, timidez ou vigilância",
    displayName: "Kasane Teto espiando"
  },
  "garota-anime-triste-cabelo": {
    key: "teto-triste-cabelo-vermelho",
    visionDescription:
      "Kasane Teto triste com cabelo vermelho. Tristeza ou decepção",
    displayName: "Kasane Teto triste anime"
  },
  "garota-acordando-bocejando-cama": {
    key: "teto-acordando-bocejo",
    visionDescription:
      "Kasane Teto acordando bocejando na cama. Sono ou preguiça matinal",
    displayName: "Kasane Teto acordando"
  },
  "menina-cabelo-rosa-rindo": {
    key: "teto-rindo-timida",
    visionDescription:
      "Kasane Teto de cabelo rosa rindo timidamente. Vergonha feliz",
    displayName: "Kasane Teto rindo tímida"
  },
  "garota-anime-vermelha-lingua": {
    key: "teto-lingua-fora-vermelha",
    visionDescription:
      "Kasane Teto com língua de fora. Deboche, ironia ou diversão",
    displayName: "Kasane Teto língua vermelha"
  },
  "rep-a2c71559": {
    key: "teto-mill-jardas",
    visionDescription:
      "Kasane Teto com olhar de mil jardas, cansada. Exaustão ou tédio profundo",
    displayName: "Kasane Teto mil jardas"
  }
};

const TETO_KEY_PREFIX_RE =
  /^(menina|garota|personagem|cosplayer)-(ruiva|rosa|vermelha|anime|cabelo)/i;

/** Substitui "menina ruiva", "garota anime" etc. por Kasane Teto no texto. */
export function normalizeTetoText(text = "") {
  let s = String(text ?? "").trim();
  if (!s) return s;

  const rules = [
    [/^Cosplayer ruiva/gi, "Cosplay de Kasane Teto"],
    [/^Menina ruiva/gi, "Kasane Teto"],
    [/^Garota ruiva/gi, "Kasane Teto"],
    [/^Garota anime/gi, "Kasane Teto"],
    [/^Menina anime/gi, "Kasane Teto"],
    [/^Menina rosa/gi, "Kasane Teto"],
    [/^Menina cabelo rosa/gi, "Kasane Teto"],
    [/^Personagem ruiva/gi, "Kasane Teto"],
    [/^Personagem vermelha/gi, "Kasane Teto"],
    [/^Teto com olhar/gi, "Kasane Teto com olhar"],
    [/^Teto gato/gi, "Kasane Teto passarinho"],
    [/^Miku safada lambeando o suvaco da teto/gi, "Kasane Teto com Miku no meme do sovaco"]
  ];

  for (const [pattern, replacement] of rules) {
    s = s.replace(pattern, replacement);
  }
  return s;
}

function isTetoLikeEntry(entry) {
  const key = String(entry?.key ?? "");
  if (key.startsWith("teto-")) return true;
  if (FWD_FIXES[key] || KEY_MIGRATIONS[key]) return true;
  if (TETO_KEY_PREFIX_RE.test(key)) return true;
  if (key === "rep-a2c71559") return true;
  return false;
}

function stickerFile(basePath, key) {
  return join(basePath, `${key}.webp`);
}

function ensureUniqueKey(basePath, catalog, desiredKey, exceptKey = null) {
  let candidate = slugifyStickerKey(desiredKey);
  if (!candidate) return null;
  const used = new Set(
    (catalog.entries ?? [])
      .map((e) => e.key)
      .filter((k) => k && k !== exceptKey)
  );
  if (!used.has(candidate) && !existsSync(stickerFile(basePath, candidate))) {
    return candidate;
  }
  for (let n = 2; n < 100; n += 1) {
    const alt = `${candidate}-${n}`;
    if (!used.has(alt) && !existsSync(stickerFile(basePath, alt))) return alt;
  }
  return candidate;
}

function renameStickerFile(basePath, fromKey, toKey, dryRun) {
  const from = stickerFile(basePath, fromKey);
  const to = stickerFile(basePath, toKey);
  if (!existsSync(from)) {
    console.warn(`  [skip] arquivo ausente: ${from}`);
    return false;
  }
  if (existsSync(to) && from !== to) {
    console.warn(`  [skip] destino já existe: ${to}`);
    return false;
  }
  if (from === to) return true;
  console.log(`  rename ${fromKey}.webp → ${toKey}.webp`);
  if (!dryRun) renameSync(from, to);
  return true;
}

function applyMigration(basePath, catalog, oldKey, spec, dryRun) {
  const newKey = ensureUniqueKey(basePath, catalog, spec.key, oldKey);
  if (!newKey) {
    console.warn(`  [skip] chave inválida para ${oldKey}`);
    return;
  }

  const idx = catalog.entries.findIndex((e) => e.key === oldKey);
  if (idx < 0) {
    console.warn(`  [skip] entrada não encontrada no catálogo: ${oldKey}`);
    return;
  }

  renameStickerFile(basePath, oldKey, newKey, dryRun);

  const entry = { ...catalog.entries[idx] };
  entry.key = newKey;
  if (spec.visionDescription) entry.visionDescription = spec.visionDescription;
  if (spec.displayName) entry.displayName = spec.displayName;
  entry.autoNamed = false;
  entry.renamedAt = new Date().toISOString();
  catalog.entries[idx] = entry;

  console.log(`  catalog ${oldKey} → ${newKey}`);
}

function normalizeRemainingTetoEntries(catalog) {
  let touched = 0;
  for (let i = 0; i < (catalog.entries ?? []).length; i += 1) {
    const entry = catalog.entries[i];
    if (!isTetoLikeEntry(entry)) continue;

    const nextVision = normalizeTetoText(entry.visionDescription);
    const nextDisplay = normalizeTetoText(entry.displayName);

    if (nextVision !== entry.visionDescription || nextDisplay !== entry.displayName) {
      catalog.entries[i] = {
        ...entry,
        visionDescription: nextVision || entry.visionDescription,
        displayName: nextDisplay || entry.displayName
      };
      touched += 1;
      console.log(`  normalize texto: ${entry.key}`);
    }
  }
  return touched;
}

function main() {
  const basePath = STICKERS_DIR;
  const catalogPath = join(basePath, "catalog.json");
  const catalog = readJson(catalogPath, { entries: [] });
  const dryRun = !APPLY;

  console.log(dryRun ? "=== DRY-RUN (use --apply para gravar) ===" : "=== APLICANDO ===");
  console.log(`Pasta: ${basePath}\n`);

  console.log("1) Renomear fwd-* …");
  for (const [oldKey, spec] of Object.entries(FWD_FIXES)) {
    applyMigration(basePath, catalog, oldKey, spec, dryRun);
  }

  console.log("\n2) Migrar chaves genéricas → teto-* …");
  for (const [oldKey, spec] of Object.entries(KEY_MIGRATIONS)) {
    applyMigration(basePath, catalog, oldKey, spec, dryRun);
  }

  console.log("\n3) Normalizar textos restantes (Kasane Teto) …");
  const normalized = normalizeRemainingTetoEntries(catalog);

  if (!dryRun) {
    writeJson(catalogPath, catalog);
  }

  console.log(
    `\nConcluído: ${Object.keys(FWD_FIXES).length} fwd, ${Object.keys(KEY_MIGRATIONS).length} migrações, ${normalized} textos normalizados.`
  );
  if (dryRun) {
    console.log("\nNada foi alterado. Rode com --apply para aplicar.");
  }
}

main();
