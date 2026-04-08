const CALM_KEYWORDS = [
  "para",
  "parar",
  "para isso",
  "estranho",
  "estranha",
  "não tá legal",
  "nao ta legal",
  "isso tá ruim",
  "isso ta ruim",
  "ruim",
  "calma",
  "menos",
  "devagar",
  "sem gritar",
  "mais de boa"
];

export function detectTone(message) {
  const normalized = message.toLowerCase();
  if (CALM_KEYWORDS.some((term) => normalized.includes(term))) {
    return "calm";
  }
  return "playful";
}
