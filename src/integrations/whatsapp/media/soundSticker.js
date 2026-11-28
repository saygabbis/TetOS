/**
 * Figurinha com som (WhatsApp, nov/2026).
 *
 * O WhatsApp manda a figurinha animada (WebP) com um áudio Ogg/Opus anexado num campo que o
 * Baileys ainda não conhece:
 *   Message.audioStickerMessage (134, FutureProofMessage) → .message (1, Message)
 *     → .stickerMessage (26) → StickerMessage.audioMessage (26, AudioMessage)
 *
 * Envio: a mensagem normal leva a figurinha (quem não tem o recurso vê ela sem som) e, na hora de
 * codificar, a gente acrescenta os bytes do campo 134. Recebimento: ao decodificar, se vier o
 * campo 134, a figurinha vira `stickerMessage` e o áudio fica em `stickerMessage.soundAudio`.
 * Formato descoberto por engenharia reversa (bots da comunidade): pode quebrar se o zap mudar.
 */
import { createCipheriv, createHmac } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  generateWAMessageFromContent,
  getMediaKeys,
  prepareWAMessageMedia,
  proto
} from "baileys";

const SOUND_BYTES = Symbol.for("tetos.soundStickerBytes");
const FIELD_AUDIO_STICKER = 134;
const FIELD_STICKER = 26;
const FIELD_STICKER_AUDIO = 26;

// ---------- protobuf cru ----------

function encodeVarint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 127) {
    out.push((v & 127) | 128);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function lengthField(field, bytes) {
  const b = Buffer.from(bytes);
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(b.length), b]);
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let b;
  do {
    if (pos >= buf.length) throw new Error("varint truncado");
    b = buf[pos++];
    if (shift < 28) result |= (b & 127) << shift;
    else result += (b & 127) * 2 ** shift;
    shift += 7;
  } while (b & 128);
  return { value: result, pos };
}

/** Bytes do primeiro campo `field` (tipo length-delimited) num buffer protobuf, ou null. */
export function findLengthField(buf, field) {
  let pos = 0;
  try {
    while (pos < buf.length) {
      const tag = readVarint(buf, pos);
      pos = tag.pos;
      const f = Math.floor(tag.value / 8);
      const wt = tag.value & 7;
      if (wt === 0) pos = readVarint(buf, pos).pos;
      else if (wt === 1) pos += 8;
      else if (wt === 5) pos += 4;
      else if (wt === 2) {
        const len = readVarint(buf, pos);
        const start = len.pos;
        const end = start + len.value;
        if (end > buf.length) return null;
        if (f === field) return buf.subarray(start, end);
        pos = end;
      } else return null;
    }
  } catch {
    return null;
  }
  return null;
}

// ---------- codificar / decodificar ----------

let installed = false;

/** Ensina o proto do Baileys a mandar e entender figurinha com som. Idempotente. */
export function installSoundStickerProto(P = proto) {
  if (installed || !P?.Message) return;
  installed = true;
  const Message = P.Message;
  const origEncode = Message.encode;
  const origDecode = Message.decode;

  Message.encode = function encodeWithSound(message, writer) {
    const w = origEncode.call(this, message, writer);
    const extra = message?.[SOUND_BYTES];
    if (extra) w.uint32(((FIELD_AUDIO_STICKER << 3) | 2) >>> 0).bytes(extra);
    return w;
  };

  Message.decode = function decodeWithSound(reader, length) {
    let slice = null;
    try {
      if (reader instanceof Uint8Array) slice = reader;
      else if (reader?.buf && typeof reader.pos === "number") {
        const end = length === undefined ? reader.len : reader.pos + length;
        slice = reader.buf.subarray(reader.pos, end);
      }
    } catch {
      slice = null;
    }
    const decoded = origDecode.call(this, reader, length);
    if (slice) {
      try {
        attachSoundSticker(decoded, slice, P, origDecode);
      } catch {
        /* figurinha com som é bônus: nunca quebra a leitura */
      }
    }
    return decoded;
  };
}

function attachSoundSticker(decoded, raw, P, origDecode) {
  const future = findLengthField(raw, FIELD_AUDIO_STICKER);
  if (!future) return;
  const innerMsg = findLengthField(future, 1);
  if (!innerMsg) return;
  const stickerBytes = findLengthField(innerMsg, FIELD_STICKER);
  if (!stickerBytes) return;
  const sticker = P.Message.StickerMessage.decode(stickerBytes);
  const audioBytes = findLengthField(stickerBytes, FIELD_STICKER_AUDIO);
  const audio = audioBytes ? P.Message.AudioMessage.decode(audioBytes) : null;
  if (!decoded.stickerMessage) decoded.stickerMessage = sticker;
  if (audio) decoded.stickerMessage.soundAudio = audio;
}

/** AudioMessage do som de uma figurinha (null se ela não tem som). */
export function soundAudioOf(stickerMessage) {
  return stickerMessage?.soundAudio ?? null;
}

/** Onde fica o som de uma figurinha salva: `<arquivo-da-figurinha>-soundaudio.ogg`. */
export function soundPathForSticker(stickerPath) {
  return stickerPath ? `${String(stickerPath).replace(/\.[a-z0-9]+$/i, "")}-soundaudio.ogg` : null;
}

/** Som já baixado dessa figurinha (ou null). */
export function existingStickerSound(stickerPath) {
  const p = soundPathForSticker(stickerPath);
  return p && existsSync(p) ? p : null;
}

/**
 * Baixa o som de uma figurinha recebida pra junto do arquivo dela (reaproveita se já existe).
 * Retorna o caminho ou null (figurinha sem som).
 */
export async function persistStickerSound({ stickerMessage, stickerPath, downloadContentFromMessage }) {
  const audio = soundAudioOf(stickerMessage);
  if (!audio || !stickerPath || typeof downloadContentFromMessage !== "function") return null;
  const path = soundPathForSticker(stickerPath);
  if (existsSync(path)) return path;
  const stream = await downloadContentFromMessage(audio, "audio");
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return null;
  writeFileSync(path, buf);
  return path;
}

// ---------- envio ----------

/** Sidecar de streaming do áudio (HMAC de 10 bytes por bloco de 64 KiB do arquivo cifrado). */
async function buildStreamingSidecar(plain, mediaKey) {
  const { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, "audio");
  const aes = createCipheriv("aes-256-cbc", cipherKey, iv);
  const cipher = Buffer.concat([aes.update(plain), aes.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(cipher).digest().subarray(0, 10);
  const enc = Buffer.concat([cipher, mac]);
  const CHUNK = 65536;
  const parts = [];
  for (let i = 0; i < enc.length; i += CHUNK) {
    const prev = i === 0 ? iv : enc.subarray(i - 16, i);
    const block = enc.subarray(i, i + CHUNK + 16);
    parts.push(createHmac("sha256", macKey).update(prev).update(block).digest().subarray(0, 10));
  }
  return Buffer.concat(parts);
}

/**
 * Manda figurinha com som. `payload` = { soundSticker: { sticker: Buffer, audio: Buffer, seconds },
 * contextInfo?, quoted? }. Se o zap recusar o áudio, cai pra figurinha normal.
 */
export async function sendSoundSticker(socket, jid, payload, { onSent } = {}) {
  installSoundStickerProto();
  const { sticker, audio, seconds } = payload.soundSticker ?? {};
  if (!Buffer.isBuffer(sticker) || !Buffer.isBuffer(audio)) throw new Error("soundSticker sem sticker/audio");
  const opts = { upload: socket.waUploadToServer, mediaUploadTimeoutMs: 60_000 };

  const visual = await prepareWAMessageMedia({ sticker, isAnimated: true }, opts);
  const audioMedia = await prepareWAMessageMedia(
    { audio, mimetype: "audio/ogg; codecs=opus", seconds: Math.max(1, Math.ceil(Number(seconds) || 1)) },
    opts
  );
  const stickerMsg = visual.stickerMessage;
  stickerMsg.isAnimated = true;
  stickerMsg.width = 512;
  stickerMsg.height = 512;
  if (payload.contextInfo) stickerMsg.contextInfo = payload.contextInfo;
  const audioMsg = audioMedia.audioMessage;
  try {
    audioMsg.streamingSidecar = await buildStreamingSidecar(audio, audioMsg.mediaKey);
  } catch {
    /* sem sidecar ainda toca */
  }

  const userJid = socket.user?.id;
  const full = generateWAMessageFromContent(jid, { stickerMessage: stickerMsg }, { userJid, quoted: payload.quoted });
  const stickerBytes = Buffer.concat([
    proto.Message.StickerMessage.encode(full.message.stickerMessage).finish(),
    lengthField(FIELD_STICKER_AUDIO, proto.Message.AudioMessage.encode(audioMsg).finish())
  ]);
  full.message[SOUND_BYTES] = lengthField(1, lengthField(FIELD_STICKER, stickerBytes));

  await socket.relayMessage(jid, full.message, { messageId: full.key.id });
  if (typeof onSent === "function") onSent(full);
  return full;
}

/** Envolve socket.sendMessage pra aceitar `{ soundSticker }` em qualquer lugar do código. */
export function wrapSocketForSoundStickers(socket, { onSent } = {}) {
  installSoundStickerProto();
  const orig = socket.sendMessage.bind(socket);
  socket.sendMessage = async (jid, content, options = {}) => {
    if (content?.soundSticker) {
      try {
        return await sendSoundSticker(socket, jid, { ...content, quoted: options?.quoted ?? content.quoted }, { onSent });
      } catch (error) {
        console.warn(`[wa] figurinha com som falhou (${error.message}); mandando sem som`);
        const { soundSticker, quoted: _q, ...rest } = content;
        return orig(jid, { ...rest, sticker: soundSticker.sticker }, options);
      }
    }
    return orig(jid, content, options);
  };
  return socket;
}
