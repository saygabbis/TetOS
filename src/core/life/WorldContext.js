import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { contextualSeed, chance, pick } from "../brain/rng.js";

const DEFAULT_STATE = {
  homeBase: "São Paulo, Brasil",
  currentLocation: "sp",
  tripReason: null,
  tripStartedAt: null,
  tripEndsAt: null,
  lastTripEndedAt: null,
  tripHistory: [],
  localSeason: "outono",
  climateTags: ["urbano", "umido"],
  timezone: "America/Sao_Paulo",
  culturalNotes: [],
  lastUpdated: null
};

const LOCATION_PRESETS = {
  sp: {
    label: "São Paulo",
    climateTags: ["urbano", "umido"],
    timezone: "America/Sao_Paulo",
    cultural: false
  },
  tokyo: {
    label: "Tóquio",
    climateTags: ["jet_lag", "urbano", "umido", "cultura_jp"],
    timezone: "Asia/Tokyo",
    cultural: true
  },
  seoul: {
    label: "Seul",
    climateTags: ["jet_lag", "urbano", "cultura_kr"],
    timezone: "Asia/Seoul",
    cultural: true
  },
  paris: {
    label: "Paris",
    climateTags: ["jet_lag", "frio_seco", "cultura_fr"],
    timezone: "Europe/Paris",
    cultural: true
  },
  nyc: {
    label: "Nova York",
    climateTags: ["jet_lag", "urbano", "cultura_us"],
    timezone: "America/New_York",
    cultural: true
  },
  london: {
    label: "Londres",
    climateTags: ["jet_lag", "frio_seco", "cultura_uk"],
    timezone: "Europe/London",
    cultural: true
  },
  travel_transit: {
    label: "Em trânsito",
    climateTags: ["jet_lag", "cansaco_viagem"],
    timezone: "UTC",
    cultural: false
  }
};

const TRIP_REASONS = [
  { id: "passeio", weight: 0.38, label: "passeio" },
  { id: "cultural", weight: 0.32, label: "aprender cultura local" },
  { id: "curiosidade", weight: 0.22, label: "curiosidade" },
  { id: "show", weight: 0.05, label: "show" },
  { id: "collab", weight: 0.03, label: "collab" }
];

const CULTURAL_DESTINATIONS = ["tokyo", "seoul", "paris", "nyc", "london"];

const MIN_DAYS_BETWEEN_TRIPS = 45;
const DAILY_TRIP_ROLL_CHANCE = 0.0004;

export class WorldContext {
  constructor(path, { bus = null, journalAppend = null } = {}) {
    this.path = path;
    this.bus = bus;
    this.journalAppend = journalAppend;
    this.state = readJson(path, DEFAULT_STATE) ?? structuredClone(DEFAULT_STATE);
    this.state.tripHistory ??= [];
    this.state.culturalNotes ??= [];
    this._lastTripRollDay = null;
  }

  save() {
    writeJson(this.path, this.state);
  }

  getSnapshot() {
    return {
      ...this.state,
      isTraveling: this.state.currentLocation !== "sp",
      locationLabel: LOCATION_PRESETS[this.state.currentLocation]?.label ?? this.state.currentLocation
    };
  }

  deriveSeason(date = new Date()) {
    const month = date.getMonth() + 1;
    if (month >= 12 || month <= 2) return "verao";
    if (month >= 3 && month <= 5) return "outono";
    if (month >= 6 && month <= 8) return "inverno";
    return "primavera";
  }

  pickTripReason(seed, preferCultural = true) {
    const pool = preferCultural
      ? TRIP_REASONS.filter((r) => r.id !== "show" || chance(seed, 0.15))
      : TRIP_REASONS;
    const total = pool.reduce((s, r) => s + r.weight, 0);
    let roll = (seed % 1000) / 1000 * total;
    for (const r of pool) {
      roll -= r.weight;
      if (roll <= 0) return r;
    }
    return pool[0];
  }

  startTrip(location, { reason = "passeio", days = 5, note = null, source = "autonomous" } = {}) {
    const preset = LOCATION_PRESETS[location] ?? LOCATION_PRESETS.sp;
    if (location === "sp") return this.getSnapshot();

    const startedAt = new Date().toISOString();
    const endsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    this.state.currentLocation = location;
    this.state.tripReason = reason;
    this.state.tripStartedAt = startedAt;
    this.state.tripEndsAt = endsAt;
    this.state.climateTags = [...preset.climateTags];
    this.state.timezone = preset.timezone;
    this.state.lastUpdated = startedAt;

    const entry = {
      location,
      reason,
      days,
      startedAt,
      endsAt,
      source,
      note: note ?? `viagem para ${preset.label} (${reason})`
    };
    this.state.tripHistory.push(entry);
    if (this.state.tripHistory.length > 24) {
      this.state.tripHistory = this.state.tripHistory.slice(-24);
    }

    if (preset.cultural) {
      this.state.culturalNotes.push({
        ts: startedAt,
        location,
        text: `quero ver ${preset.label} de perto — ${reason}`
      });
      if (this.state.culturalNotes.length > 20) {
        this.state.culturalNotes = this.state.culturalNotes.slice(-20);
      }
    }

    this.save();
    this.bus?.emit("world.trip_started", { state: this.getSnapshot(), entry });
    this.journalAppend?.({ type: "world_trip_started", ...entry });
    return this.getSnapshot();
  }

  returnHome({ note = null } = {}) {
    const preset = LOCATION_PRESETS.sp;
    const ended = {
      from: this.state.currentLocation,
      reason: this.state.tripReason,
      endedAt: new Date().toISOString(),
      note
    };
    this.state.currentLocation = "sp";
    this.state.tripReason = null;
    this.state.tripStartedAt = null;
    this.state.tripEndsAt = null;
    this.state.lastTripEndedAt = ended.endedAt;
    this.state.climateTags = [...preset.climateTags];
    this.state.timezone = preset.timezone;
    this.state.lastUpdated = ended.endedAt;
    this.save();
    this.bus?.emit("world.trip_ended", { state: this.getSnapshot(), ended });
    this.journalAppend?.({ type: "world_trip_ended", ...ended });
    return this.getSnapshot();
  }

  daysSinceLastTrip(now = Date.now()) {
    const last = this.state.lastTripEndedAt ? Date.parse(this.state.lastTripEndedAt) : null;
    if (!last) return Infinity;
    return (now - last) / (24 * 60 * 60 * 1000);
  }

  considerAutonomousTrip({ now = new Date(), emotion = null, life = null } = {}) {
    if (this.state.currentLocation !== "sp") return null;
    if (this.daysSinceLastTrip(now.getTime()) < MIN_DAYS_BETWEEN_TRIPS) return null;

    const dayKey = now.toISOString().slice(0, 10);
    if (this._lastTripRollDay === dayKey) return null;
    this._lastTripRollDay = dayKey;

    const seed = contextualSeed([dayKey, emotion?.mood, life?.phase, this.state.tripHistory.length]);
    if (!chance(seed, DAILY_TRIP_ROLL_CHANCE)) return null;

    const destination = pick(seed + 1, CULTURAL_DESTINATIONS);
    const reasonObj = this.pickTripReason(seed + 2, true);
    const days = 4 + (seed % 9);
    return this.startTrip(destination, {
      reason: reasonObj.label,
      days,
      source: "autonomous_daily",
      note: `decidi ir pra ${LOCATION_PRESETS[destination]?.label} — ${reasonObj.label}`
    });
  }

  planTripFromInterest(topic, meta = {}) {
    if (this.state.currentLocation !== "sp") return null;
    const lower = String(topic ?? "").toLowerCase();
    let destination = null;
    if (/jap|tokyo|東京|jp/.test(lower)) destination = "tokyo";
    else if (/coreia|seoul|kr/.test(lower)) destination = "seoul";
    else if (/paris|fran|france/.test(lower)) destination = "paris";
    else if (/nova york|nyc|new york/.test(lower)) destination = "nyc";
    else if (/londres|london|uk/.test(lower)) destination = "london";
    else if (/viagem|viajar|passeio|cultural/.test(lower)) {
      destination = pick(contextualSeed([topic]), CULTURAL_DESTINATIONS);
    }
    if (!destination) return null;
    const seed = contextualSeed([topic, destination]);
    const reasonObj = this.pickTripReason(seed, true);
    return this.startTrip(destination, {
      reason: reasonObj.label,
      days: 5 + (seed % 6),
      source: meta.source ?? "planted_interest",
      note: `interesse maduro: ${topic}`
    });
  }

  tick({ now = new Date(), emotion = null, life = null } = {}) {
    const seed = contextualSeed([this.state.currentLocation, now.getDate()]);
    this.state.localSeason = this.deriveSeason(now);

    if (this.state.localSeason === "inverno" && this.state.currentLocation === "sp") {
      if (!this.state.climateTags.includes("frio_seco")) {
        this.state.climateTags.push("frio_seco");
      }
    }
    if (this.state.localSeason === "verao" && this.state.currentLocation === "sp") {
      if (!this.state.climateTags.includes("quente_umido")) {
        this.state.climateTags.push("quente_umido");
      }
    }

    if (this.state.tripEndsAt && Date.parse(this.state.tripEndsAt) <= now.getTime()) {
      this.returnHome({ note: "voltei pra SP" });
    }

    if (this.state.currentLocation === "sp") {
      this.considerAutonomousTrip({ now, emotion, life });
    }

    this.state.lastUpdated = now.toISOString();
    this.save();
    return this.getSnapshot();
  }
}
