import { ChatMessageIndex } from "../src/integrations/whatsapp/chatMessageIndex.js";
import { resolveVerifiedQuoteKey } from "../src/integrations/whatsapp/quoteMessageResolver.js";
import { assert, ok } from "./test-helpers.js";

const channel = "test@g.us";
const index = new ChatMessageIndex();
index.append({
  channelId: channel,
  messageId: "3EB0ABCDEF1234567890AA",
  actorId: "111",
  text: "pergunta do usuário",
  isFromBot: false
});
index.append({
  channelId: channel,
  messageId: "3EB0F91A291E21535654C7",
  actorId: "teto",
  text: "resposta da teto",
  isFromBot: true
});

const exact = resolveVerifiedQuoteKey({
  channelId: channel,
  remoteJid: channel,
  quoteId: "3EB0ABCDEF1234567890AA",
  chatMessageIndex: index
});
assert(exact.quoteKey?.id === "3EB0ABCDEF1234567890AA", "id exato resolve");

const truncated = resolveVerifiedQuoteKey({
  channelId: channel,
  remoteJid: channel,
  quoteId: "3EB0ABCDEF1234567890",
  chatMessageIndex: index
});
assert(truncated.quoteKey?.id === "3EB0ABCDEF1234567890AA", "id truncado resolve para o mais próximo");

const invalid = resolveVerifiedQuoteKey({
  channelId: channel,
  remoteJid: channel,
  quoteId: "ZZZZZZZZZZZZZZZZZZZZZZ",
  chatMessageIndex: index
});
assert(invalid.quoteKey === null, "id inválido não gera quote");

ok("test-quote-resolver");
