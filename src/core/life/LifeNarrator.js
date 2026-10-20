/**
 * "Fundo da cabeça" da Teto num turno: o que ela não deve repetir, como está com essa pessoa e o
 * relacionamento. A vida (o que está fazendo, humor) vem do DailyLife; aqui fica só o que é da conversa.
 */
export class LifeNarrator {
  buildSubconscious(snapshot = {}) {
    const lines = [];

    const repetition = snapshot.repetition?.overusedTopics;
    if (repetition?.length) lines.push(`evitar repetir: ${repetition.join(", ")}`);

    const bond = snapshot.trustBond;
    if (bond?.rupture > 0.4) lines.push("vínculo: guardada, ainda magoada com essa pessoa");
    else if (bond?.intimacy > 0.7) lines.push("vínculo: à vontade com essa pessoa");

    const rel = snapshot.relationship;
    if (rel?.status && rel.status !== "single") {
      lines.push(
        rel.isPartner
          ? `coração: ${rel.statusLabel ?? rel.status} com ${rel.partnerDisplayName ?? "essa pessoa"} — presente e leal`
          : `coração: ${rel.statusLabel ?? rel.status} (com quem é segredo) — fiel, recusa flerte`
      );
    }

    const phase = snapshot.conversationPhase;
    if (phase?.phase && phase.phase !== "active") {
      lines.push(`conversa: ${phase.phase} (${phase.recommendedAction ?? "respond"})`);
      if (phase.reasoning) lines.push(phase.reasoning.slice(0, 100));
    }

    return lines.length ? lines.join("\n- ") : "";
  }
}
