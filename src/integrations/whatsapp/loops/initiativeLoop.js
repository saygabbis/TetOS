// Iniciativa da Teto (puxar assunto no PV): escolhe quem, gera a mensagem e envia.
import { DEFAULTS } from "../../../infra/config/defaults.js";
import { dmUserId, isOwnerContact, resolveNudgeRemoteJid } from "../../../core/channels/userActivity.js";
import { cleanDisplayName } from "../../../core/channels/waIdentity.js";
import { isIdentityIdLike } from "../../../core/channels/profileFacts.js";
import { chooseInitiative } from "../../../core/autonomy/initiative.js";
import { recentAssistantTurns, regulateBubbles } from "../../../modules/chat/styleRegulator.js";

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
    // Só quem já conversou com ela no PV: conhecer alguém do grupo não é motivo pra chamar no privado.
    if (!id.startsWith("dm-") && !profiles[id]?.facts?.lastDmSessionId) continue;
    const jid = resolveNudgeRemoteJid(runtime, id);
    if (!jid || jid.endsWith("@g.us")) continue;
    const score = (id === dmUserId(jid) ? 2 : 0) + (profiles[id]?.facts?.lastDmSessionId ? 1 : 0);
    const prev = byJid.get(jid);
    if (!prev || score > prev.score) byJid.set(jid, { id, score });
  }
  return [...byJid.values()].map((v) => v.id);
}

let running = false;

/**
 * Iniciativa: a cada poucos minutos, vê se ela tem motivo (e jeito) de puxar assunto com alguém próximo.
 * Decisão em `chooseInitiative`; aqui só junta os dados e manda pelo mesmo caminho das respostas.
 */
export async function runPresence(runtime, socket) {
  if (!DEFAULTS.replyEnabled || !DEFAULTS.presenceEnabled) return;
  if (Date.now() < presenceLlmPausedUntil || running) return;
  const life = runtime.brainOrchestrator?.life;
  const state = runtime.initiativeState;
  if (!life?.availability || !state?.shouldEvaluate()) return;
  const availability = life.availability({ isOwner: true });
  if (availability.mode !== "online") return;
  running = true;
  try {
    const dayInfo = life.dayInfo();
    for (const userId of listKnownUsers(runtime)) {
      if (runtime.tetoActivation?.isActivationRequired?.() && !runtime.tetoActivation.isDmActive(userId)) continue;
      const facts = runtime.longTerm.getProfile(userId)?.facts ?? {};
      const boundaryUntil = facts.userBoundaryUntil ? Date.parse(facts.userBoundaryUntil) : 0;
      if (Number.isFinite(boundaryUntil) && boundaryUntil > Date.now()) continue;

      const remoteJid = resolveNudgeRemoteJid(runtime, userId);
      if (!remoteJid || remoteJid.endsWith("@g.us")) continue;
      const sessionId = facts.lastDmSessionId ?? `wa-dm:${remoteJid}`;
      const isOwner = isOwnerContact(runtime, remoteJid, userId);
      const lastUser = Date.parse(runtime.timeStore?.getLastUserMessage?.(userId, sessionId) ?? "") || 0;
      const lastAny = Date.parse(runtime.timeStore?.getLastMessage?.(userId, sessionId) ?? "") || 0;
      if (!lastUser) continue;
      const name = cleanDisplayName(facts.preferredName || facts.displayName || facts.name) || null;
      const decision = chooseInitiative({
        availability: life.availability({ chatId: remoteJid, isOwner }),
        dayInfo,
        person: {
          userId,
          isOwner,
          isPartner: Boolean(runtime.relationshipStore?.isPartner?.(userId, runtime)),
          intimacy: runtime.brainOrchestrator?.trust?.getBond?.(userId, "direct")?.intimacy ?? 0,
          gapSinceUserMs: Date.now() - lastUser,
          gapSinceAnyMs: Date.now() - lastAny,
          followUps: runtime.peopleMemory?.followUps?.(userId, "direct") ?? [],
          name
        },
        row: state.user(userId)
      });
      if (!decision) continue;

      const history = runtime.shortTerm?.getAll?.(sessionId)?.slice(-12) ?? [];
      const replies = await runtime.chatService.handleMessage(
        decision.impulse,
        {
          userId,
          sessionId,
          channelId: remoteJid,
          isOwner,
          isInitiative: true,
          skipUserRecord: true,
          initiationContext: { impulse: decision.impulse, mode: decision.mode },
          recentHistory: history,
          fallback: "ground"
        },
        history,
        "playful"
      );
      const texts = regulateBubbles(Array.isArray(replies) ? replies.filter(Boolean) : [], {
        recentTurns: recentAssistantTurns(history)
      }).texts.slice(0, 2);
      if (!texts.length) continue;

      const sent = runtime.waOrchestrator?.sendProactive
        ? await runtime.waOrchestrator.sendProactive({ remoteJid, userId, sessionId, texts })
        : await sendDirect(socket, remoteJid, texts);
      if (!sent) continue;
      state.noteSent(userId, decision.reasonKey);
      runtime.timeStore?.markAssistantMessage?.(userId, Date.now(), sessionId);
      for (const text of texts) runtime.peopleMemory?.record?.({ userId, scope: "direct", role: "teto", text });
      if (decision.reasonKey.startsWith("fu:")) runtime.peopleMemory?.markFollowedUp?.(userId, "direct", decision.reasonKey.slice(3));
      console.log(`[iniciativa] ${decision.mode} → ${name ?? userId}: ${texts.join(" | ").slice(0, 120)}`);
      break; // uma iniciativa por rodada: ninguém manda mensagem pra todo mundo ao mesmo tempo
    }
  } finally {
    running = false;
  }
}

async function sendDirect(socket, remoteJid, texts) {
  try {
    await socket.sendPresenceUpdate?.("composing", remoteJid);
    await new Promise((r) => setTimeout(r, 1500 + Math.floor(Math.random() * 1500)));
    for (const text of texts) await socket.sendMessage(remoteJid, { text });
    return true;
  } catch {
    return false;
  }
}
