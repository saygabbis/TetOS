import assert from "node:assert/strict";
import { parseActionCommands } from "../src/modules/chat/chatService.js";
import { isPresetStickerKey, normalizeAgentMediaCommand } from "../src/integrations/whatsapp/agentMediaCommands.js";
import {
  deriveStickerKeyFromVision,
  extractDisplayName,
  sanitizeVisionDescription
} from "../src/integrations/whatsapp/stickerVisionNaming.js";

assert.equal(
  deriveStickerKeyFromVision('Sticker animada: a cat wearing a red hat'),
  "cat-wearing-red-hat"
);
assert.equal(
  extractDisplayName("Sticker: um gato bravo com olhos grandes"),
  "um gato bravo com olhos grandes"
);

const pathLeak =
  "Sticker analisada localmente e animada. Arquivo persistido em C:\\Users\\LEGIAO~1\\AppData\\Local\\Temp\\tetos-vision-1782935223389-frame.png. A análise semântica não ficou disponível, então use apenas pistas básicas desta mídia.";
assert.equal(sanitizeVisionDescription(pathLeak), "");
assert.equal(extractDisplayName(pathLeak), null);
assert.equal(
  deriveStickerKeyFromVision(pathLeak, { messageId: "3EB08F84755DFD39BCD94C", prefix: "fwd" }),
  "fwd-39bcd94c"
);

assert.equal(isPresetStickerKey("teto-pao"), true);
assert.equal(isPresetStickerKey("3EB0F91A291E21535654C7"), false);
assert.equal(normalizeAgentMediaCommand("toimage"), "toimg");
assert.equal(normalizeAgentMediaCommand("otimizar"), "optimize");

const modeOn = parseActionCommands('modoRepertorio("on")');
assert.equal(modeOn[0].type, "repertoire_mode");
assert.equal(modeOn[0].enabled, true);

const modeOff = parseActionCommands('desativarRepertorio()');
assert.equal(modeOff[0].type, "repertoire_mode");
assert.equal(modeOff[0].enabled, false);

const preset = parseActionCommands('sticker("teto-linguinha")');
assert.equal(preset[0].type, "sticker");
assert.equal(preset[0].key, "teto-linguinha");

const silence = parseActionCommands('calar("todos")');
assert.equal(silence[0].type, "silence");
assert.equal(silence[0].scope, "todos");

const makeSticker = parseActionCommands('sticker("3EB0F91A291E21535654C7", "10s")');
assert.equal(makeSticker[0].type, "media");
assert.equal(makeSticker[0].command, "sticker");
assert.equal(makeSticker[0].messageId, "3EB0F91A291E21535654C7");
assert.deepEqual(makeSticker[0].args, ["10s"]);

const fsticker = parseActionCommands('fsticker("3EB0ABC1234567890DEF1")');
assert.equal(fsticker[0].command, "fsticker");

const optimize = parseActionCommands('optimize("3EB0ABC1234567890DEF1")');
assert.equal(optimize[0].command, "optimize");

const removebg = parseActionCommands('removebg("3EB0ABC1234567890DEF1", "verde", "forte")');
assert.equal(removebg[0].command, "removebg");
assert.deepEqual(removebg[0].args, ["verde", "forte"]);

const toimg = parseActionCommands('toimage("3EB0F91A291E21535654C7")');
assert.equal(toimg[0].type, "media");
assert.equal(toimg[0].command, "toimg");

const save = parseActionCommands('salvarSticker("3EB0ABC1234567890DEF1", "meme-gato")');
assert.equal(save[0].type, "save_sticker");
assert.equal(save[0].key, "meme-gato");

const saveAlias = parseActionCommands('adicionarRepertorio("3EB0DEF1234567890ABC1")');
assert.equal(saveAlias[0].type, "save_sticker");
assert.equal(saveAlias[0].messageId, "3EB0DEF1234567890ABC1");

const mixed = parseActionCommands(
  'mensagem("pera")\nfsticker("3EB0ABC")\nremovebg("3EB0DEF", "verde")'
);
assert.equal(mixed.length, 3);

const ytDl = parseActionCommands('youtube("https://youtu.be/abc", "mp3")');
assert.equal(ytDl[0].type, "url_download");
assert.equal(ytDl[0].command, "youtube");
assert.equal(ytDl[0].url, "https://youtu.be/abc");
assert.deepEqual(ytDl[0].args, ["mp3"]);

const redditDl = parseActionCommands('reddit("https://reddit.com/r/a/comments/b/c", "post")');
assert.equal(redditDl[0].type, "url_download");
assert.equal(redditDl[0].command, "reddit");

const genericDl = parseActionCommands('download("https://vimeo.com/123")');
assert.equal(genericDl[0].command, "download");

const thumbDl = parseActionCommands('thumb("https://youtu.be/abc")');
assert.equal(thumbDl[0].command, "thumbnail");

const convertCmd = parseActionCommands('convert("3EB0ABC1234567890DEF1", "png")');
assert.equal(convertCmd[0].type, "media");
assert.equal(convertCmd[0].command, "convert");
assert.deepEqual(convertCmd[0].args, ["png"]);

console.log("test-agent-action-commands: ok");
