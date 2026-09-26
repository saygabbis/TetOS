const AUTOMATE_MENTION_RE = /@automate\b/gi;

export function parseAutomateMention(raw = "") {
  const text = String(raw ?? "");
  const hasAutomate = AUTOMATE_MENTION_RE.test(text);
  AUTOMATE_MENTION_RE.lastIndex = 0;
  if (!hasAutomate) {
    return { hasAutomate: false, mode: "chat", intentText: text };
  }
  const intentText = text.replace(AUTOMATE_MENTION_RE, " ").replace(/\s+/g, " ").trim();
  return { hasAutomate: true, mode: "automate", intentText };
}

export function resolveUiMessageMode(bodyMode, text) {
  if (bodyMode === "automate") {
    return "automate";
  }
  const parsed = parseAutomateMention(text);
  return parsed.mode;
}
