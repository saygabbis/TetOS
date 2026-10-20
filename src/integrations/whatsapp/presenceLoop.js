// Iniciativa da Teto (puxar assunto no PV): escolhe quem, gera a mensagem e envia.
import { DEFAULTS } from "../../infra/config/defaults.js";
import { dmUserId, isUserRecentlyActive, resolveNudgeRemoteJid, touchUserActivity } from "../../core/channels/userActivity.js";
import { isIdentityIdLike } from "../../core/channels/profileFacts.js";
import { getLocalHour } from "../../core/life/sleepSchedule.js";

/** Pausa nudges/presence após 403 de assinatura (evita spam a cada 60s). */
let presenceLlmPausedUntil = 0;
let presenceSubscriptionWarned = false;

export function isOllamaSubscriptionError(message = "") {
  const msg = String(message);
  return /403/.test(msg) && /subscription|upgrade/i.test(msg);
}

/** Erro do loop de presença: 403 de assinatura pausa as iniciativas por 6h (evita spam de erro). */
export function notePresenceError(error) {
  const msg = String(error?.message ?? "");
  if (isOllamaSubscriptionError(msg)) {
    presenceLlmPausedUntil = Date.now() + 6 * 60 * 60 * 1000;
    if (!presenceSubscriptionWarned) {
      presenceSubscriptionWarned = true;
      console.error(
        `[presence] ${DEFAULTS.model} exige Pro na Ollama Cloud (403). Chat também falha com este modelo. Use um modelo do plano free ou assine Pro. Iniciativas pausadas 6h.`
      );
    }
    return;
  }
  console.error("[presence] error:", msg);
}

/**
 * Uma entrada por pessoa (por chat de PV real). Antes a mesma pessoa aparecia como tel, LID e dm-*
 * e podia receber a mesma iniciativa várias vezes — e chaves de grupo entravam na lista.
 */
export function listKnownUsers(runtime) {
  const profiles = runtime.longTerm?.data?.profiles ?? {};
  const mediumTerm = runtime.longTerm?.data?.mediumTerm ?? {};
  const ids = [...new Set([...Object.keys(profiles), ...Object.keys(mediumTerm)])].filter(
    (id) => id !== "default" && !id.includes("::") && !/^\d+:\d+$/.test(id) && isIdentityIdLike(id)
  );
  const byJid = new Map();
  for (const id of ids) {
    const jid = resolveNudgeRemoteJid(runtime, id);
    if (!jid || jid.endsWith("@g.us")) continue;
    const score = (id === dmUserId(jid) ? 2 : 0) + (profiles[id]?.facts?.lastDmSessionId ? 1 : 0);
    const prev = byJid.get(jid);
    if (!prev || score > prev.score) byJid.set(jid, { id, score });
  }
  return [...byJid.values()].map((v) => v.id);
}

export async function runPresence(runtime, socket, initiationEngine) {
  if (!DEFAULTS.replyEnabled) return;
  if (!DEFAULTS.presenceEnabled) return;
  if (Date.now() < presenceLlmPausedUntil) return;
  const users = listKnownUsers(runtime);
  for (const userId of users) {
    const profile = runtime.longTerm.getProfile(userId);
    const dmOnlyInGroup =
      profile?.facts?.lastChannel === "group" &&
      runtime.tetoActivation?.isActivationRequired?.() &&
      !runtime.tetoActivation.isDmActive(userId);
    if (dmOnlyInGroup) {
      continue;
    }
    if (runtime.tetoActivation?.isActivationRequired?.() && !runtime.tetoActivation.isDmActive(userId)) {
      continue;
    }

    const boundary = runtime.longTerm.getProfile(userId)?.facts ?? {};
    const boundaryUntil = boundary.userBoundaryUntil ? Date.parse(boundary.userBoundaryUntil) : 0;
    if (Number.isFinite(boundaryUntil) && boundaryUntil > Date.now()) continue;

    const sleepSnap = runtime.brainOrchestrator?.life?.sleep?.getSnapshot?.() ?? {};
    if (sleepSnap.isAvailable === false) continue;

    const tz = runtime.brainOrchestrator?.life?.profile?.get?.()?.timezone ?? "America/Sao_Paulo";
    const hour = getLocalHour(new Date(), tz);
    if (hour >= 0 && hour < 7) continue;

    const evaluation = initiationEngine?.evaluateForUser?.(userId);
    if (!evaluation?.shouldInitiate) continue;

    const isQueued = Boolean(evaluation.queueEntryId);
    if (
      !isQueued &&
      isUserRecentlyActive(runtime, userId, DEFAULTS.presenceInactiveMs)
    ) {
      continue;
    }

    const allowed = runtime.basicLoop.maybeInitiate(userId, evaluation);
    if (!allowed) continue;

    const sessionId = evaluation.sessionId;
    const history = runtime.shortTerm?.getAll?.(sessionId)?.slice(-12) ?? [];
    const remoteJid = resolveNudgeRemoteJid(runtime, userId);
    const tone = evaluation.tone ?? "playful";
    const seedMessage =
      String(evaluation.impulse ?? evaluation.threadHint ?? "").trim() ||
      "Manda uma mensagem curta e natural pro usuario (iniciativa da Teto).";

    const replies = await runtime.chatService.handleMessage(
      seedMessage,
      {
        userId,
        sessionId,
        styleHint: { conversationEnergy: evaluation.mode?.includes("lull") ? "low" : "medium" },
        fallback: "ground",
        timingPlan: evaluation.timingPlan ?? null,
        brainBlocks: evaluation.brainBlocks ?? null,
        brainSnapshot: evaluation.brainSnapshot ?? null,
        isInitiative: true,
        initiationContext: evaluation,
        recentHistory: history
      },
      history,
      tone
    );

    const parts = Array.isArray(replies) ? replies.filter(Boolean) : replies ? [replies] : [];
    if (!parts.length) continue;

    if (!remoteJid.endsWith("@g.us")) {
      if (typeof socket.sendPresenceUpdate === "function") {
        try {
          await socket.sendPresenceUpdate("composing", remoteJid);
          const thinkMs = evaluation.timingPlan?.thinkDelayMs ?? 1200;
          await new Promise((r) => setTimeout(r, Math.min(thinkMs, 4000) + Math.floor(Math.random() * 800)));
          await socket.sendPresenceUpdate("paused", remoteJid);
        } catch {
          /* ignore */
        }
      }
      for (const text of parts) {
        await socket.sendMessage(remoteJid, { text });
        if (parts.length > 1) {
          await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 900)));
        }
      }
    }

    if (evaluation.queueEntryId) {
      initiationEngine?.markSent?.(evaluation.queueEntryId);
    }
    runtime.basicLoop?.recordOutbound?.(userId, evaluation);
    touchUserActivity(runtime, userId, { markMessage: false, sessionId });
    runtime.timeStore?.markAssistantMessage?.(userId, Date.now(), sessionId);
    runtime.brainOrchestrator?.recordAssistantOutput?.(sessionId, parts.join("\n"), {
      initiative: true,
      mode: evaluation.mode
    });
  }
}

