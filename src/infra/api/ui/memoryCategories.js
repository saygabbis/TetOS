import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../../utils/fileStore.js";

/** @typedef {{ id: string, label: string, source: string }} MemoryCategoryDef */

/** @type {MemoryCategoryDef[]} */
export const CATEGORY_REGISTRY = [
  { id: "eu", label: "Eu", source: "profiles" },
  { id: "fatos", label: "Fatos", source: "longTerm" },
  { id: "episodios", label: "Episódios", source: "EpisodicMemoryStore" },
  { id: "multimodal", label: "Multimodal", source: "multimodal" },
  { id: "aprendizado", label: "Aprendizado", source: "learningLedger" },
  { id: "vida", label: "Vida", source: "selective" },
];

function categoryDef(id) {
  return CATEGORY_REGISTRY.find((c) => c.id === id) ?? null;
}

function matchesQuery(text, q) {
  if (!q) return true;
  return String(text ?? "").toLowerCase().includes(String(q).toLowerCase());
}

function listProfileItems(longTerm) {
  const items = [];
  const profiles = longTerm.data?.profiles ?? {};
  for (const [profileKey, profile] of Object.entries(profiles)) {
    const facts = profile?.facts ?? {};
    for (const [factKey, value] of Object.entries(facts)) {
      if (value == null || value === "") continue;
      const content = `${factKey}: ${typeof value === "object" ? JSON.stringify(value) : value}`;
      items.push({
        id: `profile:${profileKey}::${factKey}`,
        content,
        category: "eu",
      });
    }
  }
  return items;
}

function listLedgerItems(eventLedger, limit = 200) {
  const basePath = eventLedger?.basePath;
  if (!basePath || !existsSync(basePath)) return [];
  const files = readdirSync(basePath)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .reverse()
    .slice(0, 14);
  const items = [];
  for (const file of files) {
    const raw = readFileSync(join(basePath, file), "utf-8").trim();
    if (!raw) continue;
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (items.length >= limit) return items;
      try {
        const row = JSON.parse(lines[i]);
        const content = row.summary ?? row.detail ?? row.eventType ?? JSON.stringify(row).slice(0, 240);
        const id = row.id ?? `ledger:${row.ts ?? file}:${row.eventType ?? "event"}:${i}`;
        items.push({ id: String(id), content: String(content), category: "aprendizado" });
      } catch {
        // linha inválida
      }
    }
  }
  return items;
}

export function listMemoryItems(runtime, { category = null, q = null } = {}) {
  const { longTerm, episodicMemory, multimodalMemory, selectiveMemory, eventLedger } = runtime;
  const categories = category ? [category].filter((id) => categoryDef(id)) : CATEGORY_REGISTRY.map((c) => c.id);

  let items = [];
  for (const cat of categories) {
    switch (cat) {
      case "eu":
        items = items.concat(listProfileItems(longTerm));
        break;
      case "fatos":
        items = items.concat(
          longTerm.all().map((entry) => ({
            id: entry.id,
            content: entry.content ?? "",
            category: "fatos",
          }))
        );
        break;
      case "episodios":
        items = items.concat(
          (episodicMemory?.cache ?? []).map((entry) => ({
            id: entry.id,
            content: entry.summary ?? entry.content ?? "",
            category: "episodios",
          }))
        );
        break;
      case "multimodal":
        items = items.concat(
          (multimodalMemory?.data?.entries ?? []).map((entry) => ({
            id: entry.id,
            content: entry.text || entry.mediaPath || entry.mediaType || "(mídia)",
            category: "multimodal",
          }))
        );
        break;
      case "aprendizado":
        items = items.concat(listLedgerItems(eventLedger));
        break;
      case "vida":
        items = items.concat(
          selectiveMemory.all().map((entry) => ({
            id: entry.id,
            content: entry.content ?? "",
            category: "vida",
          }))
        );
        break;
      default:
        break;
    }
  }

  if (q) {
    items = items.filter((item) => matchesQuery(item.content, q));
  }

  return items;
}

function deleteProfileFact(longTerm, compositeId) {
  const raw = compositeId.startsWith("profile:") ? compositeId.slice(8) : compositeId;
  const sep = raw.indexOf("::");
  if (sep < 0) return false;
  const profileKey = raw.slice(0, sep);
  const factKey = raw.slice(sep + 2);
  const profile = longTerm.data.profiles?.[profileKey];
  if (!profile?.facts || !(factKey in profile.facts)) return false;
  delete profile.facts[factKey];
  writeJson(longTerm.path, longTerm.data);
  return true;
}

function deleteEpisodic(episodicMemory, id) {
  const before = episodicMemory.cache.length;
  episodicMemory.cache = episodicMemory.cache.filter((entry) => entry.id !== id);
  if (episodicMemory.cache.length === before) return false;
  const body = episodicMemory.cache.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(episodicMemory.path, body ? `${body}\n` : "");
  return true;
}

function deleteMultimodal(multimodalMemory, id) {
  const entries = multimodalMemory.data?.entries ?? [];
  const next = entries.filter((entry) => entry.id !== id);
  if (next.length === entries.length) return false;
  multimodalMemory.data.entries = next;
  writeJson(multimodalMemory.path, multimodalMemory.data);
  return true;
}

function deleteSelective(selectiveMemory, id) {
  const before = selectiveMemory.data.items.length;
  selectiveMemory.data.items = selectiveMemory.data.items.filter((entry) => entry.id !== id);
  if (selectiveMemory.data.items.length === before) return false;
  writeJson(selectiveMemory.path, selectiveMemory.data);
  return true;
}

function deleteLedgerEvent(eventLedger, id) {
  const basePath = eventLedger?.basePath;
  if (!basePath || !existsSync(basePath)) return false;
  const files = readdirSync(basePath).filter((name) => name.endsWith(".ndjson"));
  for (const file of files) {
    const fullPath = join(basePath, file);
    const lines = readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
    let changed = false;
    const kept = lines.filter((line, index) => {
      try {
        const row = JSON.parse(line);
        const rowId = row.id ?? `ledger:${row.ts ?? file}:${row.eventType ?? "event"}:${index}`;
        if (String(rowId) === String(id)) {
          changed = true;
          return false;
        }
      } catch {
        // mantém
      }
      return true;
    });
    if (changed) {
      writeFileSync(fullPath, kept.length ? `${kept.join("\n")}\n` : "");
      return true;
    }
  }
  return false;
}

export function deleteMemoryItem(runtime, { id, category }) {
  const def = categoryDef(category);
  if (!def || !id) return false;

  const { longTerm, episodicMemory, multimodalMemory, selectiveMemory, eventLedger } = runtime;

  switch (category) {
    case "eu":
      return deleteProfileFact(longTerm, id);
    case "fatos":
      return longTerm.delete(id) > 0;
    case "episodios":
      return deleteEpisodic(episodicMemory, id);
    case "multimodal":
      return deleteMultimodal(multimodalMemory, id);
    case "aprendizado":
      return deleteLedgerEvent(eventLedger, id);
    case "vida":
      return deleteSelective(selectiveMemory, id);
    default:
      return false;
  }
}

export function resolveCategoryIds(categoryParam) {
  if (!categoryParam) return null;
  const parts = String(categoryParam)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}
