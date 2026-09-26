/** Slugs de skill AutoMate (alinhado a SKILL_NAME_PATTERN). */
const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function normalizeSkillRefs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (SKILL_NAME_RE.test(name) && !out.includes(name)) {
      out.push(name);
    }
  }
  return out;
}

export function skillRefsPipelinePrefix(skillRefs) {
  if (!skillRefs?.length) return "";
  const slugs = skillRefs.map((s) => `/${s}`).join(", ");
  return `[O usuário referenciou explicitamente estas skills do AutoMate (obrigatório honrar o procedimento delas): ${slugs}]\n\n`;
}
