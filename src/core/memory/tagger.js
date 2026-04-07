const STOPWORDS = new Set([
  "a",
  "o",
  "os",
  "as",
  "um",
  "uma",
  "de",
  "do",
  "da",
  "dos",
  "das",
  "e",
  "ou",
  "para",
  "por",
  "com",
  "sem",
  "na",
  "no",
  "nos",
  "nas",
  "que",
  "se",
  "em",
  "ao",
  "à",
  "é",
  "ser",
  "vai",
  "foi",
  "eu",
  "você",
  "vc",
  "tu",
  "tá",
  "ta"
]);

export function autoTag(content) {
  const tokens = String(content)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length > 2)
    .filter((token) => !STOPWORDS.has(token));

  if (tokens.length === 0) {
    return "note";
  }

  return tokens[0];
}
