/**
 * Quando a Teto entra numa mensagem de grupo que NÃO foi direto pra ela (sem @, reply ou nome).
 * Nada de regra fixa: pesa sinais como uma pessoa faria (já estou nesse papo? tem conteúdo? eu
 * falei demais agora há pouco? a conversa tá viva?) e sorteia — às vezes entra, às vezes não.
 *
 * - "window": ela já está conversando com essa pessoa; tende a seguir, mas cansa e pula "kkkk".
 * - "bystander": papo dos outros; entra raramente, só com a conversa rolando (contexto) e sabendo
 *   que não era com ela.
 */

const clamp = (n, min = 0, max = 1) => Math.max(min, Math.min(max, n));

/**
 * @returns {{ mode: "window" | "bystander" | null, chance: number }}
 */
export function groupJoinChance({
  inWindow = false,
  addressedToSomeoneElse = false,
  lowSignal = false,
  isQuestion = false,
  isOwner = false,
  recentBotTurns = 0,
  msSinceBotTurn = Infinity,
  liveMessages = 0
} = {}) {
  const mode = inWindow && !addressedToSomeoneElse ? "window" : "bystander";
  let chance;
  if (mode === "window") {
    chance = lowSignal ? 0.18 : 0.82;
  } else {
    // Sem conversa rolando ela não tem contexto pra se meter.
    if (liveMessages < 3) return { mode: null, chance: 0 };
    chance = lowSignal ? 0.02 : 0.07 + Math.min(0.08, liveMessages * 0.01);
    if (inWindow) chance += 0.08; // estava no papo e a pessoa virou pra outro: às vezes comenta junto
  }
  if (isQuestion) chance *= 1.3;
  if (isOwner) chance *= 1.25;
  // Cansaço: quanto mais ela falou no grupo nos últimos minutos, menos vontade de falar de novo.
  chance *= 0.62 ** recentBotTurns;
  if (msSinceBotTurn < 20_000) chance *= 0.45;
  return { mode, chance: clamp(chance, 0, 0.95) };
}

export function rollGroupJoin(signals = {}, random = Math.random) {
  const { mode, chance } = groupJoinChance(signals);
  return { mode: mode && random() < chance ? mode : null, chance };
}
