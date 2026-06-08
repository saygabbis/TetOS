/** Checks adicionais do catálogo 50+ — cada um adiciona reason e modula o plan. */
import { chance, contextualSeed } from "../brain/rng.js";

export function applyExtendedChecks(plan, ctx, reasons) {
  const hour = ctx.hourOfDay ?? new Date().getHours();
  const emotion = ctx.emotion ?? {};
  const body = ctx.body ?? {};
  const sleep = ctx.sleep ?? ctx.life?.sleep ?? {};
  const trust = ctx.trustBond ?? {};
  const absorbed = ctx.absorbed ?? {};
  const behavior = ctx.behaviorProfile ?? {};
  const seed = contextualSeed([hour, emotion.mood, ctx.message?.length]);

  // Disponibilidade expandida
  if (sleep.state === "drowsy") { plan.thinkDelayMs += 400; reasons.push("drowsy"); }
  if (sleep.state === "wired") { plan.thinkDelayMs *= 0.85; reasons.push("wired"); }
  if (sleep.state === "insomnia") { plan.thinkDelayMs += 700; reasons.push("insomnia"); }
  if (sleep.state === "overslept") { plan.thinkDelayMs += 300; reasons.push("overslept"); }
  if (ctx.life?.currentActivity?.includes("banho")) { plan.readDelayMs += 900; reasons.push("in_shower"); }
  if (ctx.life?.currentActivity?.includes("refei")) { plan.readDelayMs += 1200; reasons.push("eating"); }
  if (ctx.life?.currentActivity?.includes("call")) { plan.silenceAppropriate = true; reasons.push("offscreen_call"); }
  if ((ctx.health ?? []).some((h) => h.type === "headache")) { plan.thinkDelayMs += 500; reasons.push("headache"); }
  if ((ctx.health ?? []).some((h) => h.severity > 0.7)) { plan.thinkDelayMs += 1000; reasons.push("severe_health"); }

  // Distância expandida
  const gapH = ctx.lastMessageAt ? (Date.now() - Date.parse(ctx.lastMessageAt)) / 3600000 : null;
  if (gapH !== null && gapH > 72) { plan.thinkDelayMs += 800; reasons.push("very_long_gap"); }
  if (gapH !== null && gapH < 0.02) { plan.readDelayMs += 100; reasons.push("instant_burst"); }
  if (ctx.closeDecision === "silent") { plan.silenceAppropriate = true; reasons.push("closure_decision"); }

  // Ritmo expandido
  const byHour = behavior.byHour?.[hour];
  if (byHour?.messages > 5) { plan.thinkDelayMs *= 0.9; reasons.push("hour_active"); }
  if (hour >= 0 && hour < 6) { plan.thinkDelayMs += 500; reasons.push("late_night_hour"); }
  if ([6, 7, 8].includes(hour)) { plan.thinkDelayMs += 200; reasons.push("early_morning"); }
  if ([12, 13].includes(hour)) { plan.readDelayMs += 300; reasons.push("lunch_hour"); }
  if ([18, 19, 20].includes(hour)) { plan.thinkDelayMs += 150; reasons.push("evening_peak"); }
  const isWeekend = [0, 6].includes(new Date().getDay());
  if (isWeekend) { plan.thinkDelayMs *= 0.95; reasons.push("weekend"); }
  if (absorbed.style?.shortMsgRate > 0.6) { plan.typingProfile = "terse"; reasons.push("user_short_style"); }
  if (absorbed.style?.laughterRate > 0.4) { plan.typingProfile = "energetic"; reasons.push("user_playful_style"); }
  if (!ctx.userLikelyActive) { plan.thinkDelayMs += 400; reasons.push("user_likely_away"); }

  // Emocional expandido
  if (emotion.mood === "anxious") { plan.thinkDelayMs += 350; reasons.push("anxious"); }
  if (emotion.mood === "nostalgic") { plan.thinkDelayMs += 450; reasons.push("nostalgic"); }
  if ((emotion.stress ?? 0) > 0.65) { plan.thinkDelayMs += 400; reasons.push("high_stress"); }
  if ((emotion.vulnerability ?? 0) > 0.55) { plan.thinkDelayMs += 250; reasons.push("vulnerable"); }
  if ((emotion.playfulness ?? 0) > 0.7) { plan.thinkDelayMs *= 0.8; reasons.push("playful"); }
  if ((emotion.irritability ?? 0) > 0.6) { plan.typingProfile = "terse"; reasons.push("irritable"); }
  if (emotion.dominant?.some?.((d) => d.name === "saudade")) { plan.thinkDelayMs += 300; reasons.push("saudade_blend"); }

  // Corpo expandido
  if (body.thirst > 0.7) { plan.thinkDelayMs += 200; reasons.push("thirsty"); }
  if (body.hunger > 0.5 && body.hunger <= 0.75) { plan.thinkDelayMs += 200; reasons.push("mild_hunger"); }
  if ((body.vices?.scroll ?? 0) > 0.5) { plan.readDelayMs += 600; reasons.push("distracted_scroll"); }
  if ((body.vices?.sweets ?? 0) > 0.5) { plan.thinkDelayMs *= 0.92; reasons.push("sugar_rush"); }
  if (body.physicalComfort < 0.25) { plan.thinkDelayMs += 600; reasons.push("very_uncomfortable"); }

  // Contexto expandido
  if (ctx.hasMedia && ctx.media?.type === "video") { plan.readDelayMs += 800; reasons.push("video_media"); }
  if (ctx.hasMedia && ctx.media?.type === "audio") { plan.readDelayMs += 600; reasons.push("audio_media"); }
  if (ctx.hasMedia && ctx.media?.type === "sticker") { plan.readDelayMs += 350; reasons.push("sticker_media"); }
  if (ctx.isDirectQuestion && ctx.isGroup) { plan.thinkDelayMs += 200; reasons.push("group_question"); }
  if (String(ctx.message ?? "").length > 280) { plan.readDelayMs += 500; reasons.push("long_message"); }
  if (String(ctx.message ?? "").length < 12) { plan.thinkDelayMs *= 0.85; reasons.push("short_message"); }
  if (/\?{2,}/.test(String(ctx.message ?? ""))) { plan.thinkDelayMs += 150; reasons.push("urgent_question"); }

  // Trust / iniciativa expandida
  if (trust.initiateBoost > 0.4) { reasons.push("trust_initiate_boost"); }
  if (trust.toneHint === "warm") { plan.thinkDelayMs *= 0.92; reasons.push("warm_bond"); }
  if (trust.toneHint === "guarded") { plan.thinkDelayMs += 500; reasons.push("guarded_bond"); }
  if (trust.rupture > 0.5) { plan.thinkDelayMs += 700; reasons.push("rupture_active"); }
  if (trust.vulnerableReachOut) { plan.shouldInitiateConversation = true; reasons.push("vulnerable_reach_out"); }

  // Repetição / silêncio
  if (ctx.repetition?.overusedTopics?.length) { plan.thinkDelayMs += 200; reasons.push("topic_fatigue"); }
  if (ctx.repetition?.recentEcho) { plan.thinkDelayMs += 300; reasons.push("recent_echo_risk"); }

  // Calibração media hub
  if (ctx.mediaTimingHint?.readDelayBoost) {
    plan.readDelayMs += ctx.mediaTimingHint.readDelayBoost;
    reasons.push(ctx.mediaTimingHint.note ?? "media_timing_hint");
  }

  // Entrega
  if (plan.typingProfile === "group_casual" && !ctx.isGroup) {
    plan.typingProfile = "normal";
  }
  if (chance(seed, 0.08)) { plan.readDelayMs += 300; reasons.push("micro_pause"); }
  if (chance(seed, 0.05)) { plan.thinkDelayMs += 500; reasons.push("hesitation"); }
  if (ctx.subconscious) { reasons.push("subconscious_loaded"); }
  if (hour >= 9 && hour <= 17) { reasons.push("daytime"); }

  return plan;
}
