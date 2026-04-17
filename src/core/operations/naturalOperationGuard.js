export function shouldRequireConfirmation(type, payload = {}) {
  if (type === "channel_admin") return true;
  if (type === "document_write") return true;
  return false;
}

export function buildConfirmationMessage(type, payload = {}) {
  if (type === "channel_admin") {
    return `Confirma a operação ${payload?.action} no canal ${payload?.channelId}? Responda SIM ou NÃO.`;
  }
  if (type === "document_write") {
    return `Confirma a escrita no documento ${payload?.id}? Responda SIM ou NÃO.`;
  }
  return "Confirma a operação? Responda SIM ou NÃO.";
}
