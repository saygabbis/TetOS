import { Agent } from "../../core/agent/agent.js";

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Parseia `.tetos <mensagem>` (também aceita `/tetos`).
 * @returns {{ prompt: string } | null}
 */
export function parseTetosCommand(text = "", prefix = ".") {
  const raw = String(text ?? "").trim();
  const p = escapeRegExp(prefix || ".");
  const pattern = new RegExp(`^(?:\\/|${p})tetos(?:\\s+([\\s\\S]*))?$`, "i");
  const match = raw.match(pattern);
  if (!match) return null;
  return { prompt: String(match[1] ?? "").trim() };
}

/**
 * Remove menções à Teto/bot do texto do comando (não faz parte da pergunta).
 */
export function stripTetosPromptMentions(prompt = "", { botPhone, mentionHint = [] } = {}) {
  let t = String(prompt ?? "").trim();
  const phoneDigits = String(botPhone ?? "").replace(/\D/g, "");

  if (phoneDigits) {
    t = t.replace(new RegExp(`@${phoneDigits}\\b`, "gi"), " ").trim();
  }

  t = t.replace(/@\d{4,}\b/g, " ").trim();

  for (const raw of mentionHint) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (digits.length >= 4) {
      t = t.replace(new RegExp(`@${digits}\\b`, "gi"), " ").trim();
    }
  }

  t = t.replace(/^(teto|tetozinha)[,!?.\s]+/i, "").trim();
  t = t.replace(/\s{2,}/g, " ").trim();
  return t;
}

function buildTetosPrompt(userPrompt) {
  return [
    "[SYSTEM]",
    "Responda de forma direta e concisa, só ao que foi perguntado.",
    "Consulta pontual via comando .tetos — sem histórico, sem continuar conversa.",
    "Uma resposta curta em texto simples. Sem comandos de ação (mensagem, reagir, sticker, etc.).",
    "",
    "[INPUT]",
    `User: ${userPrompt}`,
    "",
    "[OUTPUT]",
    "Reply:"
  ].join("\n");
}

function formatUsage(prefix = ".") {
  const p = prefix || ".";
  return `uso: ${p}tetos <mensagem> — pergunta pontual à IA (sem conversa contínua)`;
}

/** Reply na resposta de um `.tetos` — não deve abrir janela nem gerar conversa. */
export function isQuotedTetosOneShot(messageIndex, channelId, messageId) {
  if (!messageIndex || !channelId || !messageId) return false;
  const row = messageIndex.get(channelId, messageId);
  return Boolean(row?.tetosOneShot);
}

/**
 * Executa `.tetos`: LLM stateless, sem memória nem janela de engajamento.
 */
export async function handleTetosCommand({
  prompt: rawPrompt,
  runtime,
  safeSendMessage,
  remoteJid,
  botPhone,
  mentionHint = [],
  commandPrefix = ".",
  socket = null,
  chatMessageIndex = null
} = {}) {
  if (!runtime?.brain?.generate || !safeSendMessage) {
    return { handled: false };
  }

  const prompt = stripTetosPromptMentions(rawPrompt, { botPhone, mentionHint });
  if (!prompt) {
    await safeSendMessage(remoteJid, { text: formatUsage(commandPrefix) });
    return { handled: true, reply: formatUsage(commandPrefix) };
  }

  const sendPresence = async (state) => {
    if (typeof socket?.sendPresenceUpdate === "function") {
      try {
        await socket.sendPresenceUpdate(state, remoteJid);
      } catch (_) {
        /* noop */
      }
    }
  };

  await sendPresence("composing");

  let reply;
  try {
    reply = await runtime.brain.generate(buildTetosPrompt(prompt));
  } catch (error) {
    await sendPresence("paused");
    await safeSendMessage(remoteJid, {
      text: `não consegui responder agora: ${error?.message ?? "erro"}`
    });
    return { handled: true, error: error?.message };
  }

  await sendPresence("paused");

  const text = String(reply ?? "").trim();
  if (!text || Agent.isSilentReply(text)) {
    return { handled: true, reply: null };
  }

  const sent = await safeSendMessage(remoteJid, { text });
  const sentId = sent?.key?.id ?? sent?.message?.key?.id ?? null;
  if (sentId && chatMessageIndex) {
    chatMessageIndex.append({
      channelId: remoteJid,
      messageId: sentId,
      actorId: "teto",
      text,
      isFromBot: true,
      remoteJid,
      tetosOneShot: true
    });
  }
  return { handled: true, reply: text, messageId: sentId };
}
