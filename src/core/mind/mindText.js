/** Utilidades de texto da mente: normalizar, palavras-chave, semelhança e JSON solto vindo do modelo. */

const STOPWORDS = new Set(
  "a o e é de da do das dos em no na nos nas um uma uns umas que se por pra para pro com sem como mais menos muito muita muitos muitas ja já nao não sim eu tu ele ela eles elas voce você vc vcs me te lhe nos vos meu minha seu sua teu tua isso isto aquilo esse essa este esta aquele aquela ou mas tambem também so só ate até quando onde qual quais quem porque pq por que tipo ta tá to tô ai aí la lá aqui ali entao então tem ter foi era ser estar estou esta está sao são vai vou fazer faz fiz the of and to in is on for it you".split(
    /\s+/
  )
);

export function normText(s = "") {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Palavras com conteúdo (sem stopwords, 3+ letras ou números). */
export function contentWords(s = "") {
  return normText(s)
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w) && (w.length >= 3 || /\d/.test(w)));
}

/** Jaccard entre os conjuntos de palavras (0–1). */
export function similarity(a = "", b = "") {
  const A = new Set(contentWords(a));
  const B = new Set(contentWords(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * JSON vindo do modelo: tira cerca de código, pega do primeiro { (ou [) ao último } (ou ]),
 * conserta vírgula sobrando. null se não der.
 */
export function parseJsonLoose(raw = "") {
  let t = String(raw ?? "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const firstObj = t.indexOf("{");
  const firstArr = t.indexOf("[");
  const start = firstObj < 0 ? firstArr : firstArr < 0 ? firstObj : Math.min(firstObj, firstArr);
  if (start < 0) return null;
  const close = t[start] === "{" ? "}" : "]";
  const end = t.lastIndexOf(close);
  if (end <= start) return null;
  const body = t.slice(start, end + 1);
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1"), body.replace(/[“”]/g, '"')]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* tenta a próxima */
    }
  }
  return null;
}

export const clip = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function hostOf(url = "") {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Gera um id curto legível (ex.: "k7f3a"). */
export function shortId(prefix = "") {
  return `${prefix}${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 5)}`;
}

/** Chama o modelo com tempo-limite; devolve texto ou lança. */
export async function askModel(llm, prompt, { timeoutMs = 90_000 } = {}) {
  if (!llm?.generate) throw new Error("sem modelo");
  let timer;
  try {
    return await Promise.race([
      llm.generate(prompt),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("tempo esgotado")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
