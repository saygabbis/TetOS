/** RNG contextual — seed por dia + estado (reprodutível nos logs). */
export function contextualSeed(parts = []) {
  const day = new Date().toISOString().slice(0, 10);
  const raw = [day, ...parts.map((p) => String(p ?? ""))].join("|");
  let h = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function seededRandom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function chance(seed, p) {
  return seededRandom(seed)() < p;
}

export function pick(seed, arr) {
  if (!arr?.length) return null;
  const r = seededRandom(seed)();
  return arr[Math.floor(r * arr.length)];
}
