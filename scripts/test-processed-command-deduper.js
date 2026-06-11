import { createProcessedCommandDeduper } from "../src/integrations/whatsapp/processedCommandDeduper.js";
import { assert, ok } from "./test-helpers.js";

const deduper = createProcessedCommandDeduper(1000);

assert(deduper.claim("msg-1", 0) === true, "primeira vez processa");
assert(deduper.claim("msg-1", 100) === false, "replay imediato ignora");
assert(deduper.claim("msg-2", 100) === true, "outra mensagem processa");

deduper.prune(2000);
assert(deduper.claim("msg-1", 2001) === true, "apos TTL expira pode reprocessar");
assert(deduper.claim(null, 2001) === true, "sem messageId nao bloqueia");

ok("processed-command-deduper");
