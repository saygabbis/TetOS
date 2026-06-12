/** Hora local (0–23) no fuso da Teto / usuário. */
export function getLocalHour(now = new Date(), timezone = "America/Sao_Paulo") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false
  }).formatToParts(now);
  const raw = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  return raw === 24 ? 0 : raw;
}

/**
 * Janela de sono: plano da noite + quietHours aprendidos + padrão 23h–7h.
 */
export function resolveSleepWindow({ tonightPlan = null, rhythm = {} } = {}) {
  let bedHour = tonightPlan?.bedHour;
  let wakeHour = tonightPlan?.wakeHour;
  const quiet = Array.isArray(rhythm?.quietHours) ? rhythm.quietHours : [];
  const peakHours = Array.isArray(rhythm?.peakHours) ? rhythm.peakHours : [];

  const nightQuiet = quiet.filter((h) => h >= 22 || h < 9);
  if (nightQuiet.length >= 2) {
    const evening = nightQuiet.filter((h) => h >= 20);
    const morning = nightQuiet.filter((h) => h < 10);
    if (evening.length && bedHour == null) {
      bedHour = Math.min(23, Math.max(...evening));
    }
    if (morning.length && wakeHour == null) {
      wakeHour = Math.max(6, Math.min(...morning));
    }
  }

  return {
    bedHour: bedHour ?? 23,
    wakeHour: wakeHour ?? 7,
    peakHours
  };
}

/** Ex.: cama 23h, acordar 7h → 23–6 dormindo, 7+ acordada. */
export function isInSleepWindow(hour, bedHour, wakeHour) {
  if (bedHour === wakeHour) return false;
  if (bedHour > wakeHour) {
    return hour >= bedHour || hour < wakeHour;
  }
  return hour >= bedHour && hour < wakeHour;
}

/** Já passou da hora de acordar (manhã/tarde), mas ainda marcada como dormindo. */
export function isPastWakeTime(hour, bedHour, wakeHour) {
  if (bedHour > wakeHour) {
    return hour >= wakeHour && hour < bedHour;
  }
  return hour >= wakeHour;
}
