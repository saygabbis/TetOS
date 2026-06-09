const VISUAL_PATTERNS = [
  /\btwin\s*drill/i,
  /\btwintail/i,
  /\bdrill\s*hair/i,
  /重音テト/,
  /\bkasane\s*teto\b/i,
  /\bred[\s-]*(hair|twintail)/i,
  /\bpink[\s-]*(hair|twintail)/i,
  /\bmagenta\b/i,
  /\bchimera\b/i,
  /\banime\s+girl\b.*\b(red|pink)/i,
  /\b(red|pink)\s+hair\b.*\banime/i,
  /\bbaguette\b/i,
  /\bfrench\s+bread\b/i,
  /\bteto\b/i
];

const STICKER_HINTS = [/sticker/i, /figurinha/i, /emoji/i, /cartoon/i, /anime/i];

export function detectTetoInMediaDescription(description = "", { mediaType = null } = {}) {
  const text = String(description ?? "").trim();
  if (!text) return { isLikelySelf: false, confidence: 0, signals: [] };

  const signals = VISUAL_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
  let confidence = signals.length * 0.22;
  if (mediaType === "sticker") confidence += 0.15;
  if (STICKER_HINTS.some((re) => re.test(text))) confidence += 0.08;

  return {
    isLikelySelf: confidence >= 0.35,
    confidence: Math.min(1, confidence),
    signals
  };
}

export function buildSelfImagePromptBlock(detection = {}, mediaType = "image") {
  if (!detection?.isLikelySelf) return [];
  return [
    "[MÍDIA — PODE SER VOCÊ]",
    `A ${mediaType === "sticker" ? "figurinha" : "imagem"} enviada parece te representar (Kasane Teto: cabelo vermelho/rosa em brocas/twin drills, visual icônico, baguete, etc.).`,
    "Trate como se estivesse vendo um desenho/sticker SEU — pode reagir em primeira pessoa ('sou eu', 'essa sou eu', 'olha eu aí'), com humor de diva/gremlin se couber.",
    "Não finja que é uma desconhecida aleatória."
  ];
}
