const HIGH_FOCUS = [/ensaio/i, /grava/i, /mix\b/i, /call/i, /reuni/i, /estudo de mix/i];
const MEDIUM_FOCUS = [/jogar/i, /jantar/i, /passeio/i, /vocal warm/i];

export function assessActivityFocus(lifeSnapshot = {}) {
  const activity = String(lifeSnapshot?.currentActivity ?? "").trim();
  if (!activity) return { level: "low", activity, elapsedMin: null };

  const startedAt = lifeSnapshot?.activityStartedAt ? Date.parse(lifeSnapshot.activityStartedAt) : null;
  const elapsedMin = startedAt && Number.isFinite(startedAt) ? (Date.now() - startedAt) / 60_000 : 999;

  if (HIGH_FOCUS.some((re) => re.test(activity))) {
    if (elapsedMin < 35) {
      return { level: "high", activity, elapsedMin, busyRemainingMin: Math.ceil(35 - elapsedMin) };
    }
    if (elapsedMin < 75) return { level: "medium", activity, elapsedMin };
    return { level: "low", activity, elapsedMin };
  }

  if (MEDIUM_FOCUS.some((re) => re.test(activity)) && elapsedMin < 25) {
    return { level: "medium", activity, elapsedMin };
  }

  return { level: "low", activity, elapsedMin };
}
