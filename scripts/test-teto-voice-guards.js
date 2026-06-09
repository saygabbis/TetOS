import { ChatService } from "../src/modules/chat/chatService.js";
import { detectTetoInMediaDescription } from "../src/core/character/tetoSelfRecognition.js";
import { assert, ok } from "./test-helpers.js";

const echo = ChatService.deEcho("falando tudo torto ai", "Falando tudo torto, hein?");
assert(echo.needsRegen, "detecta eco da crítica do usuário");

const thanks = ChatService.deEcho("teto fala direito", "obrigada, Gabbis");
assert(thanks.needsRegen, "obrigada sem motivo dispara regen");

const okReply = ChatService.deEcho("quem é ela ent??", "é a Selly, a amiga que eu citei");
assert(!okReply.needsRegen, "resposta contextual não é eco");

assert(
  ChatService.hasMetaDrift("Tenta falar direito, Gabbis, senão eu corrijo pra você."),
  "detecta inversão de papel"
);

const selfImg = detectTetoInMediaDescription(
  "anime girl with red twin drill hair holding baguette",
  { mediaType: "sticker" }
);
assert(selfImg.isLikelySelf, "reconhece visual da Teto");

ok("test-teto-voice-guards");
