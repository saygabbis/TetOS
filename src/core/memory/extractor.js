const NAME_PATTERNS = [
  /\bmeu nome (?:é|eh)\s+([\p{L}][\p{L}\s'-]{1,40})/iu,
  /\bme chama\s+([\p{L}][\p{L}\s'-]{1,40})/iu
];

const LIKE_PATTERNS = [
  /\beu gosto de\s+([^.!?]{2,60})/iu,
  /\beu curto\s+([^.!?]{2,60})/iu
];

const I_AM_PATTERNS = [
  /\beu sou\s+([^.!?]{2,60})/iu,
  /\beu tô\s+([^.!?]{2,60})/iu
];

function matchFirst(patterns, text) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export function extractFacts(message) {
  const facts = [];
  const name = matchFirst(NAME_PATTERNS, message);
  if (name) facts.push({ type: "user_name", value: name });

  const likes = matchFirst(LIKE_PATTERNS, message);
  if (likes) facts.push({ type: "user_like", value: likes });

  const identity = matchFirst(I_AM_PATTERNS, message);
  if (identity) facts.push({ type: "user_identity", value: identity });

  return facts;
}

export function extractStyle(message) {
  const text = message.toLowerCase();
  const style = {
    usesAbbrev: /\b(vc|pq|q\?|tb|msm|n)\b/.test(text),
    usesLaughter: /(kkk+|rs)/.test(text),
    usesEmojis: /[\u{1F300}-\u{1FAFF}]/u.test(message),
    isShort: message.length < 25,
    isLong: message.length > 120
  };

  return style;
}

export function isMeaningful(message) {
  const trimmed = message.trim().toLowerCase();
  if (!trimmed) return false;
  if (/^(oi|oie|olá|ola|ok|okk|blz|kk+|rs|hm|hmm|u[eé]|tá|ta|ah)$/.test(trimmed)) {
    return false;
  }
  if (trimmed.length < 10) return false;
  return true;
}
