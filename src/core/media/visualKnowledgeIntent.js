const TEACHING_PATTERNS = [
  /\b(isso|essa|este|esta)\s+(sou|é)\s+(eu|a?\s*teto|você|voce|minha|meu)\b/i,
  /\b(sou|sou a)\s+(eu|teto)\b/i,
  /\b(isso|essa)\s+(é|e)\s+(a\s+)?teto\b/i,
  /\b(guarda|salva|aprende|lembra|anota|registra)\s+(que\s+)?(isso|essa)\b/i,
  /\b(isso|essa)\s+(é|e)\s+(.{2,80})\b/i,
  /\b(foto|imagem|figurinha|desenho)\s+(minha|da teto|sua|de você|de voce)\b/i
];

const DESCRIBE_PATTERNS = [
  /\b(descreve|descrever|detalha|detalhar|analisa|analise|explica|explicar)\b/i,
  /\bo que (tem|você vê|vc vê|voce ve|está|esta)\b/i,
  /\b(me )?fala (tudo|o que) (tem|vê|ve|você vê)\b/i,
  /\b(descreve|detalha|analisa)\s+(essa|esta|a)\s+(imagem|foto|figurinha|gif|vídeo|video)\b/i
];

export function isMediaDescribeRequest(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  return DESCRIBE_PATTERNS.some((re) => re.test(t));
}

export function detectVisualTeaching(text = "") {
  const raw = String(text ?? "").trim();
  if (!raw || raw.length < 4) return null;

  for (const re of TEACHING_PATTERNS) {
    const m = raw.match(re);
    if (!m) continue;

    let label = "referência visual";
    const lower = raw.toLowerCase();
    if (/\b(sou eu|sou a teto|é a teto|é você|é voce|minha|meu|sua)\b/i.test(lower)) {
      label = "kasane_teto";
    } else if (m[3]) {
      label = String(m[3]).trim().slice(0, 64);
    }

    return {
      label,
      sourceText: raw.slice(0, 240),
      confidence: label === "kasane_teto" ? 0.9 : 0.65
    };
  }

  return null;
}

export function extractVisionKeywords(text = "") {
  const stop = new Set([
    "uma",
    "um",
    "com",
    "para",
    "por",
    "que",
    "the",
    "and",
    "image",
    "imagem",
    "figurinha",
    "sticker",
    "video",
    "vídeo",
    "gif",
    "audio",
    "mídia",
    "media"
  ]);
  return [
    ...new Set(
      String(text ?? "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !stop.has(w))
    )
  ].slice(0, 24);
}

export function scoreVisionMatch(visionText = "", entry = {}) {
  const keywords = entry.keywords ?? [];
  if (!keywords.length) return 0;
  const hay = String(visionText ?? "").toLowerCase();
  if (!hay) return 0;
  let hits = 0;
  for (const kw of keywords) {
    if (hay.includes(String(kw).toLowerCase())) hits += 1;
  }
  const base = hits / keywords.length;
  if (entry.label === "kasane_teto") {
    if (/teto|twin drill|drill|ruiv|rosa|vermelh|baguete|chimera|utau/i.test(hay)) {
      return Math.min(1, base + 0.35);
    }
  }
  return base;
}
