const COMMANDS = {
  "teto-ativar": "activate_dm",
  "teto-desativar": "deactivate_dm",
  "teto-grupo-ativar": "activate_group",
  "teto-grupo-desativar": "deactivate_group"
};

const COMMAND_NAMES = Object.keys(COMMANDS).join("|");

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatTetoActivationCommand(name, prefix = ".") {
  const p = prefix || ".";
  return `${p}${name}`;
}

export function parseTetoSlashCommand(text = "", prefix = ".") {
  const raw = String(text ?? "").trim();
  const p = escapeRegExp(prefix || ".");
  const pattern = new RegExp(`^(?:\\/|${p})(${COMMAND_NAMES})\\b`, "i");
  const match = raw.match(pattern);
  if (!match) return null;
  const key = match[1].toLowerCase();
  return { action: COMMANDS[key], command: key };
}

export async function handleTetoSlashCommand({
  action,
  userId,
  remoteJid,
  isGroup,
  activationStore,
  groupEngagement,
  socket,
  commandPrefix = "."
} = {}) {
  if (!activationStore || !socket?.sendMessage) return { handled: false };

  const act = (name) => formatTetoActivationCommand(name, commandPrefix);

  let reply = null;
  switch (action) {
    case "activate_dm":
      if (isGroup) {
        reply = `use isso no privado: ${act("teto-ativar")}`;
        break;
      }
      activationStore.activateDm(userId, { activatedBy: userId });
      groupEngagement?.unmute?.(remoteJid, userId);
      reply = "ok, teto ativa pra você no privado ✓";
      break;
    case "deactivate_dm":
      if (isGroup) {
        reply = `use isso no privado: ${act("teto-desativar")}`;
        break;
      }
      activationStore.deactivateDm(userId);
      groupEngagement?.clear?.(remoteJid, userId);
      groupEngagement?.unmute?.(remoteJid, userId);
      reply = `teto desativada no privado. manda ${act("teto-ativar")} quando quiser de novo`;
      break;
    case "activate_group":
      if (!isGroup) {
        reply = `use isso dentro do grupo: ${act("teto-grupo-ativar")}`;
        break;
      }
      activationStore.activateGroup(remoteJid, { activatedBy: userId });
      groupEngagement?.unmute?.(remoteJid);
      reply = "teto ativa neste grupo ✓ (ainda precisa me marcar ou responder minha msg)";
      break;
    case "deactivate_group":
      if (!isGroup) {
        reply = `use isso dentro do grupo: ${act("teto-grupo-desativar")}`;
        break;
      }
      activationStore.deactivateGroup(remoteJid);
      groupEngagement?.clearGroup?.(remoteJid);
      groupEngagement?.unmute?.(remoteJid);
      reply = "teto desativada neste grupo";
      break;
    default:
      return { handled: false };
  }

  await socket.sendMessage(remoteJid, { text: reply });
  return { handled: true, reply };
}
