import { ChatMessageIndex } from "../src/integrations/whatsapp/chatMessageIndex.js";
import {
  extractQuotedText,
  isQuotedMessageFromBot,
  normalizeQuoteKey
} from "../src/integrations/whatsapp/messageContext.js";
import { assert, ok } from "./test-helpers.js";

const channel = "120363@g.us";
const index = new ChatMessageIndex();
index.append({
  channelId: channel,
  messageId: "bot-msg-1",
  actorId: "teto",
  text: "Sellye, claro.",
  isFromBot: true
});

const botJid = "5516988137617@s.whatsapp.net";
const botPhone = "5516988137617";
const botActorIds = new Set(["teto", "self", botPhone]);

assert(
  isQuotedMessageFromBot(
    { stanzaId: "bot-msg-1", participant: botJid },
    { botJid, botPhone, botActorIds, messageIndex: index, channelId: channel }
  ),
  "participant do bot no quote conta como reply"
);

assert(
  isQuotedMessageFromBot(
    { stanzaId: "bot-msg-1" },
    { botJid, botPhone, botActorIds, messageIndex: index, channelId: channel }
  ),
  "stanzaId no índice com isFromBot conta"
);

assert(
  isQuotedMessageFromBot(
    { stanzaId: "unknown", participant: null },
    {
      botJid,
      botPhone,
      botActorIds,
      messageIndex: index,
      channelId: channel,
      quotedText: "Sellye, claro."
    }
  ),
  "fallback por texto da mensagem citada"
);

assert(
  !isQuotedMessageFromBot(
    { stanzaId: "x", participant: "5516994435369@s.whatsapp.net" },
    { botJid, botPhone, botActorIds, messageIndex: index, channelId: channel }
  ),
  "quote de outra pessoa não é reply ao bot"
);

assert(
  extractQuotedText({ conversation: "Sellye, claro." }) === "Sellye, claro.",
  "extrai texto do quote"
);

const qk = normalizeQuoteKey(
  { id: "abc", fromMe: false, participant: "5516994435369@s.whatsapp.net" },
  channel
);
assert(qk.participant && qk.id === "abc", "quote key preserva participant em grupo");

const ctx = index.buildReplyContext(channel, "bot-msg-1", 10);
assert(ctx.formatted.includes("Sellye"), "thread inclui mensagem citada");
assert(ctx.formatted.includes("MARCADA"), "marca msg do reply");

ok("test-reply-quote");
