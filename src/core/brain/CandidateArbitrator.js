/**
 * Arbitragem entre candidatos de subsistemas do cérebro.
 * Cada módulo propõe ações; o vencedor influencia narrator/timing/initiative.
 */
export class CandidateArbitrator {
  collect(snapshot = {}, turnContext = {}) {
    const candidates = [];

    if (snapshot.life?.currentActivity) {
      candidates.push({
        source: "life",
        action: "stay_in_activity",
        weight: 0.35 + (snapshot.life.sleep?.isAvailable === false ? 0.25 : 0),
        detail: snapshot.life.currentActivity
      });
    }

    if (snapshot.music?.pendingComment) {
      candidates.push({
        source: "music",
        action: "mention_music",
        weight: 0.62,
        detail: snapshot.music.pendingComment
      });
    }

    if (snapshot.social?.recentEvent) {
      candidates.push({
        source: "social",
        action: "reference_offscreen",
        weight: 0.48,
        detail: snapshot.social.recentEvent
      });
    }

    if (snapshot.trustBond?.vulnerableReachOut) {
      candidates.push({
        source: "trust",
        action: "vulnerable_reach_out",
        weight: 0.78,
        detail: "madrugada+medo+intimidade"
      });
    }

    if (snapshot.timing?.shouldInitiateConversation) {
      candidates.push({
        source: "timing",
        action: "initiate_conversation",
        weight: 0.55 + (snapshot.timing.initiateReason ? 0.1 : 0),
        detail: snapshot.timing.initiateReason ?? "distance+social"
      });
    }

    if (snapshot.autonomous?.soloThoughts?.length) {
      const last = snapshot.autonomous.soloThoughts.at(-1);
      candidates.push({
        source: "autonomous",
        action: "solo_thought_echo",
        weight: 0.42,
        detail: last?.text?.slice(0, 80)
      });
    }

    if (turnContext.media?.type === "sticker") {
      candidates.push({
        source: "media",
        action: "react_to_sticker",
        weight: 0.5,
        detail: turnContext.media.type
      });
    }

    if (snapshot.health?.length) {
      candidates.push({
        source: "health",
        action: "acknowledge_condition",
        weight: 0.4,
        detail: snapshot.health.map((h) => h.type ?? h.name).join(", ")
      });
    }

    if (snapshot.world?.isTraveling) {
      candidates.push({
        source: "world",
        action: "mention_trip",
        weight: 0.52,
        detail: `${snapshot.world.locationLabel ?? snapshot.world.currentLocation} (${snapshot.world.tripReason ?? "viagem"})`
      });
    }

    return candidates;
  }

  arbitrate(candidates = []) {
    if (!candidates.length) {
      return { winner: null, runnerUp: null, candidates: [], reason: "no_candidates" };
    }
    const sorted = [...candidates].sort((a, b) => b.weight - a.weight);
    const winner = sorted[0];
    const runnerUp = sorted[1] ?? null;
    return {
      winner,
      runnerUp,
      candidates: sorted,
      reason: `picked ${winner.source}:${winner.action} (w=${winner.weight.toFixed(2)})`
    };
  }

  run(snapshot = {}, turnContext = {}) {
    const candidates = this.collect(snapshot, turnContext);
    return this.arbitrate(candidates);
  }
}
