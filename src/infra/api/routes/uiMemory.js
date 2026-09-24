import { requireSession } from "../auth/sessionAuth.js";
import { DEFAULTS } from "../../config/defaults.js";
import { readJson } from "../../utils/fileStore.js";
import {
  CATEGORY_REGISTRY,
  deleteMemoryItem,
  listMemoryItems,
  resolveCategoryIds,
} from "../ui/memoryCategories.js";

const clampPercent = (value, fallback = 50) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 1 && n >= 0) return Math.round(n * 100);
  return Math.max(0, Math.min(100, Math.round(n)));
};

const MOOD_LABELS = {
  happy: "Alegre",
  playful: "Divertida",
  excited: "Animada",
  irritated: "Irritada",
  sad: "Melancólica",
  lonely: "Com saudade",
  bored: "Entediada",
  anxious: "Ansiosa",
  content: "Tranquila",
  neutral: "Neutra",
  low: "Baixa",
};

const SLEEP_LABELS = {
  deep_sleep: "Sono profundo",
  light_sleep: "Sono leve",
  drowsy: "Sonolenta",
  awake: "Acordada",
  wired: "Alerta",
  overslept: "Dormiu demais",
  underslept: "Pouco sono",
  jet_lagged: "Jet lag",
  nap: "Cochilando",
  insomnia: "Insônia",
  restless: "Inquieta",
  groggy: "Acordando",
};

function metric(percent, label, subtitle) {
  return {
    percent: clampPercent(percent),
    label: label ?? "—",
    subtitle: subtitle ?? "",
  };
}

function buildWellbeing(runtime) {
  const defaults = {
    energy: metric(70, "Estável", "Energia moderada"),
    mood: metric(60, "Neutra", "Humor equilibrado"),
    sleep: metric(65, "Disponível", "Ciclo regular"),
    trust: metric(50, "Em construção", "Vínculo inicial"),
    moodChip: "Neutra",
    description: "Teto está bem — dados parciais do runtime.",
  };

  try {
    const brain = runtime.brainOrchestrator;
    const emotionSnap = brain?.emotion?.getSnapshot?.() ?? readJson(DEFAULTS.emotionStatePath, {});
    const energyRaw = emotionSnap.energy ?? emotionSnap.body?.physicalComfort ?? 0.65;
    const moodKey = emotionSnap.mood ?? emotionSnap.dominant?.[0]?.name ?? "neutral";
    const moodLabel = MOOD_LABELS[moodKey] ?? String(moodKey);

    let sleepSnap = null;
    try {
      sleepSnap = brain?.life?.sleep?.getSnapshot?.();
    } catch {
      sleepSnap = null;
    }
    const sleepState = sleepSnap?.state ?? "awake";
    const sleepQuality = sleepSnap?.quality ?? 0.6;
    const sleepAvailable = sleepSnap?.isAvailable !== false;

    let trustBond = null;
    try {
      trustBond = brain?.trust?.getSnapshot?.("default", "direct");
    } catch {
      trustBond = readJson(DEFAULTS.trustBondsPath, { bonds: {} })?.bonds?.["default::direct"];
    }
    const trustScore = trustBond ? (Number(trustBond.trust ?? 0.45) + Number(trustBond.intimacy ?? 0.35)) / 2 : 0.45;

    const body = emotionSnap.body ?? readJson(DEFAULTS.bodyNeedsPath, {});
    const discomfort = Number(body.hunger ?? 0) + Number(body.thirst ?? 0);
    const energySubtitle =
      discomfort > 1.2 ? "Corpo pedindo pausa ou lanche" : energyRaw > 0.7 ? "Boa disposição" : "Energia moderada";

    const moodScore =
      emotionSnap.vector?.valence != null
        ? emotionSnap.vector.valence
        : moodKey === "happy" || moodKey === "content"
          ? 0.75
          : moodKey === "low" || moodKey === "sad"
            ? 0.35
            : 0.55;

    return {
      energy: metric(energyRaw, energyRaw > 0.65 ? "Alta" : "Moderada", energySubtitle),
      mood: metric(
        moodScore,
        moodLabel,
        emotionSnap.dominant?.[0]?.name ? `Tom: ${emotionSnap.dominant[0].name}` : "Humor estável"
      ),
      sleep: metric(
        sleepAvailable ? sleepQuality : sleepQuality * 0.5,
        SLEEP_LABELS[sleepState] ?? "Sono",
        sleepAvailable ? "Disponível para conversar" : "Descansando agora"
      ),
      trust: metric(
        trustScore,
        trustScore > 0.6 ? "Próxima" : "Crescendo",
        trustBond?.lastInteractionAt ? "Interação recente" : "Vínculo em formação"
      ),
      moodChip: moodLabel,
      description: `Energia ${energyRaw > 0.6 ? "boa" : "ok"}, humor ${moodLabel.toLowerCase()}, sono ${
        sleepAvailable ? "ok" : "em pausa"
      }.`,
    };
  } catch {
    return defaults;
  }
}

/** Categorias do app desktop (`@tetos/agent-protocol`) → armazenamento TetOS. */
const DESKTOP_TO_BACKEND_CATEGORY = {
  fact: "fatos",
  preference: "eu",
  episode: "episodios",
};

const BACKEND_TO_DESKTOP_CATEGORY = {
  eu: "preference",
  fatos: "fact",
  episodios: "episode",
  multimodal: "fact",
  aprendizado: "fact",
  vida: "preference",
};

function resolveDesktopCategoryParam(categoryParam) {
  if (!categoryParam) return null;
  const parts = String(categoryParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => DESKTOP_TO_BACKEND_CATEGORY[id] ?? id);
  return parts.length ? parts : null;
}

function toDesktopMemoryEntry(item) {
  return {
    id: item.id,
    category: BACKEND_TO_DESKTOP_CATEGORY[item.category] ?? "fact",
    text: item.content ?? "",
    createdAt: item.createdAt ?? new Date(0).toISOString(),
    salience: item.salience,
  };
}

function toDesktopWellbeing(raw) {
  const moodPercent = raw.mood?.percent ?? 55;
  const energyPercent = raw.energy?.percent ?? 65;
  let mood = "good";
  if (moodPercent >= 78) mood = "great";
  else if (moodPercent < 38 || energyPercent < 30) mood = "low";
  else if (energyPercent < 45) mood = "tired";

  return {
    mood,
    energy: energyPercent,
    message: raw.description ?? raw.moodChip,
    lastCheckInAt: new Date().toISOString(),
  };
}

export function registerUiMemoryRoutes(app, runtime) {
  app.get("/ui/wellbeing", requireSession, (_req, res) => {
    return res.json({ wellbeing: toDesktopWellbeing(buildWellbeing(runtime)) });
  });

  app.get("/ui/memories", requireSession, (req, res) => {
    const categoryIds =
      resolveDesktopCategoryParam(req.query.category) ?? resolveCategoryIds(req.query.category);
    const qRaw = req.query.q ?? req.query.query;
    const q = qRaw ? String(qRaw) : null;
    let items = [];
    if (categoryIds) {
      for (const category of categoryIds) {
        items = items.concat(listMemoryItems(runtime, { category, q }));
      }
    } else {
      items = listMemoryItems(runtime, { q });
    }
    let memories = items.map(toDesktopMemoryEntry);
    memories.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const defaultLimit = 24;
    const maxLimit = 200;
    const limitRaw = Number.parseInt(String(req.query.limit ?? defaultLimit), 10);
    const limit =
      Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, maxLimit) : defaultLimit;
    const offsetRaw = Number.parseInt(String(req.query.offset ?? 0), 10);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const page = memories.slice(offset, offset + limit);
    const hasMore = offset + page.length < memories.length;

    return res.json({ memories: page, hasMore, items, categories: CATEGORY_REGISTRY });
  });

  app.delete("/ui/memories/:id", requireSession, (req, res) => {
    const rawCategory = req.query.category ? String(req.query.category) : "";
    const category = DESKTOP_TO_BACKEND_CATEGORY[rawCategory] ?? rawCategory;
    if (!category) {
      return res.status(400).json({ error: "category é obrigatório" });
    }
    const removed = deleteMemoryItem(runtime, { id: req.params.id, category });
    if (!removed) {
      return res.status(404).json({ error: "memória não encontrada" });
    }
    return res.json({ ok: true });
  });
}
