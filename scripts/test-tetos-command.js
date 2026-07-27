import {
  parseTetosCommand,
  stripTetosPromptMentions,
  resolveTetosMessage,
  isQuotedTetosOneShot
} from "../src/integrations/whatsapp/tetosCommand.js";
import { parseTetoSlashCommand } from "../src/integrations/whatsapp/tetoSlashCommands.js";
import { isGroupPriorityEntry } from "../src/integrations/whatsapp/groupTurnPlanner.js";
import { planFloodAwareGroupSegments } from "../src/integrations/whatsapp/groupFloodCoordinator.js";
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

const resolved = resolveTetosMessage({ prompt: "tetozinha, oi" }, {});
assert(resolved === "oi", "resolveTetosMessage remove vocativo");

const idx = {
  byKey: new Map(),
  get(channelId, messageId) {
    return this.byKey.get(`${channelId}:${messageId}`) ?? null;
  }
};
idx.byKey.set("g@g.us:abc", { messageId: "abc", isFromBot: true, tetosOneShot: true });
assert(isQuotedTetosOneShot(idx, "g@g.us", "abc"), "detecta reply em resposta .tetos");
assert(!isQuotedTetosOneShot(idx, "g@g.us", "xyz"), "msg normal não é tetos one-shot");

assert(isGroupPriorityEntry({ tetosCommand: true }), ".tetos tem prioridade na fila");
assert(isGroupPriorityEntry({ parsedCommand: true }), "parsedCommand tem prioridade");

const floodEntries = Array.from({ length: 12 }, (_, i) => ({
  userId: `u${i}`,
  message: `msg ${i}`,
  ts: 1000 + i,
  messageKey: { id: `m${i}` }
}));
floodEntries.push({
  userId: "cmd",
  message: "pergunta tetos",
  ts: 2000,
  tetosCommand: true,
  messageKey: { id: "tetos1" }
});
const floodPlan = planFloodAwareGroupSegments(floodEntries);
assert(
  floodPlan.segments.some((s) => s.tetosCommand || s.message === "pergunta tetos"),
  "flood não descarta .tetos"
);

ok("test-tetos-command");
