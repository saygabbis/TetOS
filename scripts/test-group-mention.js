import { botMentionedInJids, classifyTetoAddress, isDirectTetoAddress } from "../src/integrations/whatsapp/messageContext.js";
import { assert, ok } from "./test-helpers.js";

assert(
  isDirectTetoAddress("ei teto como vai?", { hasMention: false, isReplyToBot: false }),
  "chamada contextual pelo nome conta como menção"
);
assert(
  classifyTetoAddress("teto, me ajuda aqui", { hasMention: false, isReplyToBot: false }) === "contextual",
  "vocativo com pedido é contextual"
);
assert(
  !isDirectTetoAddress("bom dia galera", { hasMention: false, isReplyToBot: false }),
  "mensagem sem teto não é menção"
);
assert(
  classifyTetoAddress("o teto da sala tá vazando", { hasMention: false, isReplyToBot: false }) === "none",
  "teto da casa não chama a bot"
);
assert(
  classifyTetoAddress("vi a teto ontem no mercado", { hasMention: false, isReplyToBot: false }) === "name_ambiguous",
  "nome solto no meio sem contexto fica ambíguo"
);
assert(
  botMentionedInJids(["5516988137617@lid"], "5516988137617@s.whatsapp.net", "5516988137617"),
  "menção @ por telefone bate com bot"
);
assert(
  botMentionedInJids(["5516988137617:73@lid"], "5516988137617@s.whatsapp.net", "5516988137617"),
  "menção @ com sufixo :NN no LID"
);
assert(
  classifyTetoAddress("tetooo", { hasMention: false, isReplyToBot: false }) === "contextual",
  "tetooo esticado conta como chamada"
);
assert(
  classifyTetoAddress("Tetoooo", { hasMention: false, isReplyToBot: false }) === "contextual",
  "Tetoooo conta"
);
assert(
  classifyTetoAddress("Kasane Teto", { hasMention: false, isReplyToBot: false }) === "contextual",
  "nome completo conta"
);
assert(
  classifyTetoAddress("aloo", { hasMention: false, isReplyToBot: false }) === "none",
  "aloo não é teto"
);

ok("test-group-mention");
