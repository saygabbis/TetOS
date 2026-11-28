/**
 * Temperamento dinâmico da Teto. Nenhuma taxa de comportamento é fixa: cada uma tem um "jeito normal"
 * (o valor base, inclusive os do .env) e oscila em volta dele como numa pessoa:
 *
 *  - deriva lenta e suave por hábito (ruído de várias ondas com fase própria de cada chave): tem dia que
 *    ela tá mais de figurinha, outro mais de áudio, uma hora mais tagarela, outra mais na dela;
 *  - o "dia" dela (cada dia sorteia um viés diferente, estável durante o dia);
 *  - o estado do momento: energia, humor (valência) e agitação vindos da rotina e dos sentimentos.
 *
 * Uso: temperament.chance("sticker_only", 0.1, { energy: 0.6, valence: 0.4 }) → probabilidade do momento.
 * Os pesos dizem quanto cada parte do estado puxa aquela taxa (positivo = mais quando alta).
 */

const DAY_MS = 86_400_000;

function hash(str) {
  let h = 2166136261;
  for (const ch of String(str)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export class Temperament {
  constructor({ now = () => Date.now(), spread = Number(process.env.TETOS_TEMPERAMENT_SPREAD ?? 0.45), timeZoneOffsetMin = -180 } = {}) {
    this.now = now;
    this.spread = Number.isFinite(spread) ? clamp(spread, 0, 1.5) : 0.45;
    this.tzMs = timeZoneOffsetMin * 60_000;
    this.sources = { feelings: null, life: null };
  }

  /** Liga com a mente (sentimentos) e a rotina (energia, horário). */
  connect({ feelings = null, life = null } = {}) {
    if (feelings) this.sources.feelings = feelings;
    if (life) this.sources.life = life;
    return this;
  }

  /** Deriva suave em [-1, 1] pra uma chave: 3 ondas (≈ 40 min, ≈ 3 h, ≈ 20 h) + viés do dia. */
  drift(key, at = this.now()) {
    const t = at / 60_000;
    const p = hash(key) * Math.PI * 2;
    const q = hash(`${key}:b`) * Math.PI * 2;
    const r = hash(`${key}:c`) * Math.PI * 2;
    const waves = 0.25 * Math.sin(t / 41 + p) + 0.35 * Math.sin(t / 187 + q) + 0.4 * Math.sin(t / 1213 + r);
    const day = Math.floor((at + this.tzMs) / DAY_MS);
    const dayBias = hash(`${key}:${day}`) * 2 - 1;
    return clamp(0.65 * waves + 0.35 * dayBias, -1, 1);
  }

  /** Estado do momento (0–1): energia, valência (humor bom), agitação (sentimentos fortes). */
  state(at = this.now()) {
    let energy = 0.6;
    let valence = 0.58;
    let arousal = 0.3;
    try {
      const life = this.sources.life?.mood?.(new Date(at));
      if (life) {
        energy = Number(life.energy ?? energy);
        valence = Number(life.valence ?? valence);
      }
    } catch {}
    try {
      const m = this.sources.feelings?.mood?.(at);
      if (m) {
        valence = Number(m.valence ?? valence);
        const strong = (m.feelings ?? []).reduce((s, f) => s + (f.level ?? 0), 0);
        arousal = clamp(0.2 + strong * 0.35, 0, 1);
        if (m.feelings?.some((f) => f.name === "sono")) energy = Math.min(energy, 0.35);
      }
    } catch {}
    return { energy: clamp(energy, 0, 1), valence: clamp(valence, 0, 1), arousal: clamp(arousal, 0, 1) };
  }

  /**
   * Fator multiplicativo do momento pra uma chave (≈ 0.4–2.5). `weights` em {energy, valence, arousal}:
   * quanto cada um (centrado no "normal") puxa pra cima/baixo.
   */
  factor(key, weights = {}, { at = this.now(), state = null } = {}) {
    if (this.frozen) return 1; // testes que conferem a taxa exata
    const s = state ?? this.state(at);
    const centered = { energy: s.energy - 0.6, valence: s.valence - 0.58, arousal: s.arousal - 0.3 };
    let pull = 0;
    for (const [k, w] of Object.entries(weights)) pull += (centered[k] ?? 0) * Number(w || 0);
    return Math.exp(this.spread * this.drift(key, at) + pull);
  }

  /** Probabilidade do momento a partir da base (nunca 0 se a base não é 0, nunca acima de `max`). */
  chance(key, base, weights = {}, { max = 0.95, ...opts } = {}) {
    const b = Number(base);
    if (!Number.isFinite(b) || b <= 0) return 0;
    return clamp(b * this.factor(key, weights, opts), b * 0.15, Math.max(b, max));
  }

  /** Valor contínuo do momento (delays, limites…), dentro de [min, max]. */
  value(key, base, weights = {}, { min = -Infinity, max = Infinity, ...opts } = {}) {
    return clamp(Number(base) * this.factor(key, weights, opts), min, max);
  }

  /** Rola a chance do momento. */
  roll(key, base, weights = {}, { random = Math.random, ...opts } = {}) {
    return random() < this.chance(key, base, weights, opts);
  }

  /** Resumo pra log/status: como ela tá "puxada" hoje. */
  snapshot(keys = ["sticker_only", "typo", "group_join", "initiative", "voice", "gif"]) {
    const s = this.state();
    return { state: s, factors: Object.fromEntries(keys.map((k) => [k, Number(this.factor(k, {}, { state: s }).toFixed(2))])) };
  }
}

/** Instância única do processo (zap + Discord + mente compartilham o mesmo humor). */
export const temperament = new Temperament();

/** Pesos prontos de cada hábito: o que puxa pra mais ou pra menos. */
export const HABITS = Object.freeze({
  sticker_only: { energy: 0.8, valence: 1.2 },
  react_only: { energy: -1.2, arousal: -0.4 },
  gif: { energy: 1.0, valence: 0.8 },
  typo: { energy: -2.0, arousal: 0.8 },
  typo_fix: { energy: 1.5 },
  group_join: { energy: 1.6, valence: 1.0, arousal: 0.6 },
  initiative: { energy: 1.2, valence: 0.8, arousal: 0.5 },
  voice: { energy: 1.0, valence: 1.0 },
  reaction: { valence: 1.0, arousal: 0.6 },
  share: { energy: 1.0, valence: 1.2 }
});
