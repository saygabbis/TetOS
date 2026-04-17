export function detectConfirmationReply(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^(sim|confirmo|confirmar|pode|ok|pode fazer)$/i.test(t)) return true;
  if (/^(não|nao|cancela|cancelar|para|pare)$/i.test(t)) return false;
  return null;
}
