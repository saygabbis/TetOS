export class LifeNarrator {
  constructor({ workerLlm = null } = {}) {
    this.workerLlm = workerLlm;
  }

  buildConscious(snapshot = {}) {
    const life = snapshot.life ?? {};
    const emotion = snapshot.emotion ?? {};
    const sleep = life.sleep ?? snapshot.sleep ?? {};
    const lines = [];

    if (life.currentActivity) {
      const since = life.activityStartedAt
        ? ` (desde ${life.activityStartedAt.slice(11, 16)})`
        : "";
      lines.push(`agora: ${life.currentActivity}${since}`);
    } else if (sleep.state && sleep.state !== "awake") {
      lines.push(`agora: ${sleep.state.replace(/_/g, " ")}`);
    } else {
      lines.push("agora: sem atividade fixa");
    }

    if (emotion.mood) {
      const dom = emotion.dominant?.[0];
      const moodLine = dom
        ? `humor: ${emotion.mood} (${dom.name} ${(dom.weight * 100).toFixed(0)}%)`
        : `humor: ${emotion.mood}`;
      lines.push(moodLine);
    }

    const available = snapshot.sleep?.isAvailable ?? sleep.state === "awake";
    lines.push(`disponível: ${available ? "sim" : "não"}${emotion.energy < 0.35 ? ", cansada" : ""}`);

    if (snapshot.world?.currentLocation && snapshot.world.currentLocation !== "sp") {
      lines.push(`local: ${snapshot.world.currentLocation} (${snapshot.world.tripReason ?? "viagem"})`);
    }

    if (snapshot.music?.nowPlaying) {
      lines.push(`ouvindo: ${snapshot.music.nowPlaying}`);
    }

    return lines.join("\n- ");
  }

  buildSubconscious(snapshot = {}) {
    const lines = [];
    const life = snapshot.life ?? {};
    const autonomous = snapshot.autonomous ?? {};

    const pendingObl = (life.obligations ?? []).find((o) => o.status === "pending");
    if (pendingObl) lines.push(`pendência: ${pendingObl.label}`);

    const privateThought = (life.privateThoughts ?? autonomous.soloThoughts ?? []).slice(-1)[0];
    if (privateThought?.text) {
      lines.push(`pensamento: ${privateThought.text.slice(0, 80)}`);
    }

    const offscreen = snapshot.social?.recentOffscreen?.slice(-1)[0];
    if (offscreen?.summary) lines.push(`off-screen: ${offscreen.summary}`);

    const body = snapshot.emotion?.body ?? snapshot.body;
    if (body?.hunger > 0.7) lines.push("corpo: com fome");

    const repetition = snapshot.repetition?.overusedTopics;
    if (repetition?.length) {
      lines.push(`evitar repetir: ${repetition.join(", ")}`);
    }

    const bond = snapshot.trustBond;
    if (bond?.rupture > 0.4) lines.push("vínculo: guardada, ainda magoada");
    if (bond?.intimacy > 0.7) lines.push("vínculo: à vontade com essa pessoa");

    const phase = snapshot.conversationPhase;
    if (phase?.phase && phase.phase !== "active") {
      lines.push(`conversa: ${phase.phase} (${phase.recommendedAction ?? "respond"})`);
      if (phase.reasoning) lines.push(phase.reasoning.slice(0, 100));
    }

    if (!lines.length) lines.push("nada urgente no fundo da cabeça");
    return lines.join("\n- ");
  }

  buildBlocks(snapshot = {}) {
    const conscious = this.buildConscious(snapshot);
    const subconscious = this.buildSubconscious(snapshot);
    return {
      consciousBlock: `[CONSCIOUS CONTEXT]\n- ${conscious}`,
      subconsciousBlock: `[SUBCONSCIOUS — NÃO REPETIR LITERALMENTE]\n- ${subconscious}`,
      conscious,
      subconscious
    };
  }

  async narrate(snapshot = {}, { useLlm = false } = {}) {
    if (useLlm && this.workerLlm?.generate) {
      try {
        const prompt = `Com base no snapshot cerebral abaixo, escreva dois blocos curtos em PT-BR:
[CONSCIOUS CONTEXT] (3-5 bullets, presente)
[SUBCONSCIOUS] (3-5 bullets, pendências/curiosidades, não repetir literal)
Snapshot: ${JSON.stringify(snapshot).slice(0, 3000)}`;
        const raw = await this.workerLlm.generate(prompt);
        const consciousMatch = raw.match(/\[CONSCIOUS[^\]]*\]([\s\S]*?)(?=\[SUBCONSCIOUS|$)/i);
        const subMatch = raw.match(/\[SUBCONSCIOUS[^\]]*\]([\s\S]*)/i);
        if (consciousMatch || subMatch) {
          return {
            consciousBlock: consciousMatch ? `[CONSCIOUS CONTEXT]${consciousMatch[1].trim()}` : this.buildBlocks(snapshot).consciousBlock,
            subconsciousBlock: subMatch ? `[SUBCONSCIOUS — NÃO REPETIR LITERALMENTE]${subMatch[1].trim()}` : this.buildBlocks(snapshot).subconsciousBlock,
            source: "worker_llm"
          };
        }
      } catch {
        /* fallback deterministic */
      }
    }
    return { ...this.buildBlocks(snapshot), source: "deterministic_v1" };
  }
}
