import { contextualSeed, pick, seededRandom } from "../brain/rng.js";

function coerceImpulse(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => coerceImpulse(v)).filter(Boolean).join(" ").trim();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text.trim();
    if (typeof value.content === "string") return value.content.trim();
    if (typeof value.detail === "string") return value.detail.trim();
  }
  return String(value).trim();
}

const TOPIC_SEEDS = [
  "algo do seu dia que lembrou essa pessoa — sem repetir o papo anterior",
  "uma música ou som que você ouviu e quis comentar",
  "um pensamento aleatório engraçado ou bobo do momento",
  "curiosidade genuína sobre como a pessoa tá, sem cobrar resposta",
  "algo que viu online e achou que a pessoa ia rir",
  "lembrança leve de algo que vocês já falaram — assunto NOVO, não continuação literal",
  "vontade de mandar um oi seco sem drama",
  "comentário curto sobre clima, fome ou tédio — variado"
];

function recentAssistantTexts(history = [], limit = 4) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => m?.role === "assistant")
    .slice(-limit)
    .map((m) => String(m?.content ?? "").toLowerCase().trim())
    .filter(Boolean);
}

function isEchoOfRecent(impulse = "", history = []) {
  const needle = String(impulse ?? "").toLowerCase().trim().slice(0, 80);
  if (!needle) return true;
  return recentAssistantTexts(history).some(
    (prev) => prev.includes(needle.slice(0, 40)) || needle.includes(prev.slice(0, 40))
  );
}

/** Impulso variado — evita reenviar o mesmo tema da última bolha do assistente. */
export function buildInitiativeImpulse({ brain = null, history = [], userId = "default", mode = null } = {}) {
  const fromBrain =
    coerceImpulse(brain?.arbitration?.winner?.detail) ||
    coerceImpulse(brain?.blocks?.conscious) ||
    coerceImpulse(brain?.blocks?.subconscious) ||
    coerceImpulse(brain?.timingPlan?.distanceContext) ||
    "";

  if (fromBrain && !isEchoOfRecent(fromBrain, history)) {
    return fromBrain;
  }

  const lastUser = [...(history ?? [])].reverse().find((m) => m?.role === "user");
  const seed = contextualSeed([userId, mode, lastUser?.content?.slice(0, 40), new Date().toISOString().slice(0, 10)]);
  const topic = pick(seed, TOPIC_SEEDS);
  const rand = seededRandom(seed + 3);
  const style = rand() > 0.55 ? "curta e casual" : "só uma linha";
  return `${topic} — mensagem ${style}, assunto diferente do que você já mandou hoje`;
}
