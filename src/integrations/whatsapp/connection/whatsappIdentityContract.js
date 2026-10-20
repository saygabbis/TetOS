/**
 * Identidade usada no fluxo WhatsApp:
 *
 * - remoteJid: JID real do chat no WhatsApp; em grupo termina com @g.us.
 * - userId: pessoa lógica que falou; em grupo é o participante, em DM é o contato.
 * - participantId: participante local do grupo; vazio em DM.
 * - sessionId: chave de fila e short-term memory.
 * - channelId: canal conversacional; normalmente remoteJid no WhatsApp.
 * - channelScope: escopo de memória; "direct" em DM, "group:<id>" em grupos.
 */
export const WHATSAPP_IDENTITY_FIELDS = Object.freeze([
  "remoteJid",
  "userId",
  "participantId",
  "sessionId",
  "channelId",
  "channelScope"
]);

export function buildWhatsappIdentitySnapshot({
  remoteJid,
  userId,
  participantId = null,
  sessionId,
  channelId = remoteJid,
  isGroup = false
} = {}) {
  return {
    remoteJid,
    userId,
    participantId,
    sessionId,
    channelId,
    channelScope: isGroup ? `group:${channelId ?? remoteJid}` : "direct",
    channelType: isGroup ? "group" : "dm"
  };
}
