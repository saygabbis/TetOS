import {
  parseTetosCommand,
  stripTetosPromptMentions,
  isQuotedTetosOneShot
} from "../src/integrations/whatsapp/tetosCommand.js";
import { parseTetoSlashCommand } from "../src/integrations/whatsapp/tetoSlashCommands.js";
import { assert, ok } from "./test-helpers.js";

const dot = parseTetosCommand(".tetos qual a capital do brasil?");
assert(dot?.prompt === "qual a capital do brasil?", "parse .tetos com prompt");

const slash = parseTetosCommand("/tetos oi");
assert(slash?.prompt === "oi", "parse /tetos");

const empty = parseTetosCommand(".tetos");
assert(empty?.prompt === "", "parse .tetos sem prompt");

const notCmd = parseTetosCommand(".teto-ativar");
assert(notCmd === null, ".teto-ativar não é .tetos");

const ativar = parseTetoSlashCommand(".teto-ativar");
assert(ativar?.action === "activate_dm", ".teto-ativar continua separado");

const stripped = stripTetosPromptMentions("@5511999999999 teto, qual 2+2?", {
  botPhone: "5511999999999",
  mentionHint: ["5511999999999@s.whatsapp.net"]
});
assert(stripped === "qual 2+2?", "remove menção e vocativo teto");

const strippedName = stripTetosPromptMentions("tetozinha, me explica fotossíntese");
assert(strippedName === "me explica fotossíntese", "remove vocativo tetozinha");

const multiWord = parseTetosCommand(".tetos  como   funciona   o   git");
assert(multiWord?.prompt === "como   funciona   o   git", "preserva espaços internos do prompt");

const idx = {
  byKey: new Map(),
  get(channelId, messageId) {
    return this.byKey.get(`${channelId}:${messageId}`) ?? null;
  }
};
idx.byKey.set("g@g.us:abc", { messageId: "abc", isFromBot: true, tetosOneShot: true });
assert(isQuotedTetosOneShot(idx, "g@g.us", "abc"), "detecta reply em resposta .tetos");
assert(!isQuotedTetosOneShot(idx, "g@g.us", "xyz"), "msg normal não é tetos one-shot");

ok("test-tetos-command");
