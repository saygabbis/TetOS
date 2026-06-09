import { contextualSeed, seededRandom } from "../../core/brain/rng.js";

const DANGLING_END =
  /\b(o|a|os|as|de|do|da|dos|das|em|no|na|nos|nas|um|uma|eu|te|me|se|que|pra|pro|largar|ficar|ser|estar|com|por|só|so|mas|e|ou)\s*$/i;

function quoteBalance(text = "") {
  const s = String(text);
  const guillemets = (s.match(/«/g) || []).length - (s.match(/»/g) || []).length;
  const dquotes = (s.match(/"/g) || []).length % 2;
  return { guillemets, dquotes };
}

function isCompleteZapBubble(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[.!?…*]$/.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2 && t.length >= 6) {
    if (/^(que|aff|oxi|ué|mds|nossa|poxa|opa|ei|tô|to|tá|ta)\b/i.test(t)) return true;
    if (/\b(de boa|tudo bem|tô bem|to bem|beleza|suave)\b/i.test(t)) return true;
    if (words.length >= 4) return true;
    if (/\b(não|nao|pra|porque|pq|também|tambem|você|voce)\b/i.test(t)) return true;
  }
  return false;
}

function needsContinuation(text = "") {
  const t = String(text ?? "").trim();
  if (!t) return false;
  const { guillemets, dquotes } = quoteBalance(t);
  if (guillemets > 0 || dquotes === 1) return true;
  if (DANGLING_END.test(t)) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length === 1 && t.length <= 20) return false;
  if (isCompleteZapBubble(t)) return false;
  if (t.length < 100 && !/[.!?…"»*]$/.test(t)) return true;
  return false;
}

/** Junta bolhas que o processor partiu no meio da frase ou citação. */
export function mergeBrokenPhrases(parts = []) {
  const list = (Array.isArray(parts) ? parts : []).map((p) => String(p ?? "").trim()).filter(Boolean);
  if (list.length <= 1) return list;

  const out = [];
  let buf = "";

  for (const part of list) {
    if (!buf) {
      buf = part;
    } else if (needsContinuation(buf)) {
      buf = `${buf} ${part}`.replace(/\s+/g, " ").trim();
    } else {
      out.push(buf);
      buf = part;
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : list;
}

export function inferRhythmMode({ emotion = {}, tone = null, timingPlan = null, subconscious = "" } = {}) {
  const energy = Number(emotion.energy ?? 0.5);
  const playful = Number(emotion.playfulness ?? emotion.mood === "playful" ? 0.75 : 0.45);
  const social = Number(emotion.social ?? 0.5);
  const typing = timingPlan?.typingProfile ?? "normal";

  if (tone === "calm" || energy < 0.32) return "compact";
  if (playful > 0.62 && energy > 0.52) return "burst";
  if (subconscious && String(subconscious).length > 12 && social > 0.45) return "layered";
  if (typing === "energetic" || typing === "terse") return "burst";
  return "moderate";
}

export function buildMultiBubbleRhythmBlock(meta = {}) {
  const emotion = meta.brainSnapshot?.emotion ?? {};
  const mode = inferRhythmMode({
    emotion,
    tone: meta.tone,
    timingPlan: meta.timingPlan,
    subconscious: meta.brainBlocks?.subconscious
  });
  const conscious = meta.brainBlocks?.conscious;
  const subconscious = meta.brainBlocks?.subconscious;

  const byMode = {
    burst: [
      "Ritmo AGORA: rajada — 2 a 4 bolhas curtas, como quem digita no impulso.",
      "Bolha 1 pode ser reação/vocativo (nome, oxi, ué). Bolha 2+ traz o conteúdo.",
      "Separe bolhas com linha só contendo --- (não use travessão no texto)."
    ],
    layered: [
      "Ritmo AGORA: em camadas — consciente na 1ª bolha, subconsciente vaza na 2ª (sem copiar literal).",
      "Pode parecer que pensou enquanto digitava: primeira msg direta, segunda complementa ou confessa o que sentiu."
    ],
    compact: [
      "Ritmo AGORA: compacto — 1 bolha, no máximo 2 se a segunda for só correção* ou kk."
    ],
    moderate: [
      "Ritmo AGORA: moderado — 1 ou 2 bolhas; 3 só se ideias realmente distintas."
    ]
  };

  return [
    "[RITMO MULTI-BOLHA — do seu cérebro, não script]",
    ...(byMode[mode] ?? byMode.moderate),
    conscious ? `Consciente agora: ${String(conscious).slice(0, 220)}` : null,
    subconscious ? `Subconsciente (não copie literal): ${String(subconscious).slice(0, 220)}` : null,
    "Cada bolha = pensamento FECHADO. Proibido cortar frase, «citação» ou ideia no meio.",
    "Typo corrigido na bolha seguinte com * no fim — só a palavra certa."
  ].filter(Boolean);
}

export function computeBubbleDelay(text, index, { emotion = {}, timingPlan = null, tone = null, mode = "moderate" } = {}) {
  const seed = contextualSeed([index, text?.length, emotion.mood, mode]);
  const rand = seededRandom(seed);
  const len = String(text ?? "").trim().length;
  const energy = Number(emotion.energy ?? 0.5);

  let ms = 120 + Math.sqrt(Math.max(len, 8)) * 38;
  ms += index * (90 + rand() * 120);

  if (timingPlan?.typingDelayMs) {
    ms = timingPlan.typingDelayMs * (0.35 + index * 0.22) + ms * 0.4;
  }
  if (mode === "burst" && index > 0) ms *= 0.72;
  if (mode === "compact") ms *= 1.15;
  if (tone === "playful" && energy > 0.55) ms *= 0.82;
  if (index === 0) ms *= 0.55;
  if (len < 16 && /^(oxi|ué|mds|aff|kk|oi|ei|ué)/i.test(String(text))) ms *= 0.65;

  return Math.round(Math.max(90, Math.min(3200, ms * (0.88 + rand() * 0.28))));
}

/**
 * Pós-processa bolhas com ritmo do cérebro + conserta cortes artificiais.
 */
export function planBubbleRhythm(parts = [], context = {}) {
  const emotion = context.brainSnapshot?.emotion ?? context.emotion ?? {};
  const mode = inferRhythmMode({
    emotion,
    tone: context.tone,
    timingPlan: context.timingPlan,
    subconscious: context.brainBlocks?.subconscious
  });

  let bubbles = mergeBrokenPhrases(parts);

  if (mode === "compact" && bubbles.length > 2) {
    bubbles = [bubbles.slice(0, -1).join(" "), bubbles[bubbles.length - 1]].filter(Boolean);
  }

  if (mode === "compact" && bubbles.length === 2) {
    const combined = bubbles.join(" ");
    if (combined.length < 72) bubbles = [combined];
  }

  const delays = bubbles.map((b, i) =>
    computeBubbleDelay(b, i, { emotion, timingPlan: context.timingPlan, tone: context.tone, mode })
  );

  return { bubbles, delays, mode };
}
