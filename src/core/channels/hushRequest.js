/**
 * Pedido explícito para a Teto ficar quieta ("fica quieta um minuto", "tô numa call", "para de falar").
 * O agente às vezes só ficava calado naquela msg sem chamar calar(), e respondia a seguinte.
 */
const HUSH = /(?<![\p{L}])(?:fica(?:r)?\s+(?:quieta|quietinha|calada|caladinha|em sil[eê]ncio)|cala(?:\s+a\s+boca)?(?:\s+a[ií])?|para\s+de\s+(?:falar|responder|mandar)|n[aã]o\s+(?:fala|responde|manda)\s+(?:nada|mais)|shh+|psiu|me\s+deixa\s+(?:quieta|em\s+paz))(?![\p{L}])/iu;
/** "silêncio" só como ordem ("silêncio, teto" / "teto silêncio"), não "que silêncio nesse grupo". */
const SILENCE_CMD = /^\s*(?:teto[,!\s]+)?sil[eê]ncio(?![\p{L}])|sil[eê]ncio[,!\s]+teto(?![\p{L}])/iu;
const BUSY = /(?<![\p{L}])(?:t[oô]|estou|tou)\s+(?:numa?|em)\s+(?:call|liga[cç][aã]o|reuni[aã]o|aula|prova)(?![\p{L}])/iu;
const NEGATED = /(?<![\p{L}])n[aã]o\s+(?:precisa\s+)?(?:fica(?:r)?\s+(?:quieta|calada)|se\s+cala)/iu;

export function detectHushRequest(text = "") {
  const t = String(text ?? "").trim();
  if (!t || t.length > 160) return false;
  if (NEGATED.test(t)) return false;
  return HUSH.test(t) || SILENCE_CMD.test(t) || (BUSY.test(t) && /(?<![\p{L}])(?:quieta|calada|depois|j[aá]\s+volto|para)(?![\p{L}])/iu.test(t));
}
