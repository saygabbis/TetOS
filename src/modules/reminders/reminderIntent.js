function parseRelativeDueAt(raw) {
  const match = String(raw ?? "").match(/\bdaqui\s+(\d+)\s*(segundo|minuto|hora|segundos|minutos|horas)\b/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit.startsWith("segundo")
    ? 1000
    : unit.startsWith("minuto")
      ? 60 * 1000
      : 60 * 60 * 1000;
  return new Date(Date.now() + amount * multiplier).toISOString();
}

function cleanReminderText(raw) {
  return String(raw ?? "")
    .replace(/\bme\s+lembra\b/i, "")
    .replace(/\bdaqui\s+\d+\s*(segundo|minuto|hora|segundos|minutos|horas)\b/i, "")
    .replace(/^\s*(de|pra|para)\s+/i, "")
    .trim();
}

export function detectReminderIntent(text) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  const relativeDueAt = parseRelativeDueAt(raw);
  if (/\bme lembra\b/i.test(raw) && relativeDueAt) {
    return {
      type: "create",
      text: cleanReminderText(raw),
      dueAt: relativeDueAt
    };
  }

  const createMatch = raw.match(/\b(?:me lembra|cria lembrete|anota lembrete|lembrete)\b[:\-]?\s*([\s\S]+)/i);
  if (createMatch?.[1]) {
    return { type: "create", text: createMatch[1].trim(), dueAt: relativeDueAt };
  }

  if (/\b(lista|listar|quais)\b.*\b(lembretes|reminders)\b/i.test(lower)) {
    return { type: "list" };
  }

  const doneMatch = raw.match(/\b(?:concluir|finalizar|marcar)\s+lembrete\s+([\w-]+)/i);
  if (doneMatch?.[1]) {
    return { type: "done", id: doneMatch[1].trim() };
  }

  return null;
}
