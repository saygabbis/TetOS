import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { proto } from "baileys";
import { findLengthField, installSoundStickerProto } from "../../src/integrations/whatsapp/media/soundSticker.js";
import { extractStickerAudio, muxAudioIntoMp4, probeMedia, staticWebpToAnimated } from "../../src/core/media/soundStickerMedia.js";

const SB = Symbol.for("tetos.soundStickerBytes");
function varint(n) {
  const v = [];
  while (n > 127) {
    v.push((n & 127) | 128);
    n >>>= 7;
  }
  v.push(n);
  return Buffer.from(v);
}
const field = (f, b) => Buffer.concat([varint((f << 3) | 2), varint(b.length), b]);

function wrapper() {
  const st = Buffer.from(proto.Message.StickerMessage.encode({ mimetype: "image/webp", isAnimated: true, width: 512, height: 512 }).finish());
  const au = Buffer.from(proto.Message.AudioMessage.encode({ mimetype: "audio/ogg; codecs=opus", seconds: 3, url: "https://x" }).finish());
  return field(1, field(26, Buffer.concat([st, field(26, au)])));
}

describe("figurinha com som — protobuf", () => {
  installSoundStickerProto();

  it("acrescenta o campo 134 e lê o som de volta", () => {
    const msg = proto.Message.fromObject({ stickerMessage: { mimetype: "image/webp" } });
    msg[SB] = wrapper();
    const bytes = Buffer.from(proto.Message.encode(msg).finish());
    expect(findLengthField(bytes, 134)).toBeTruthy();
    const d = proto.Message.decode(bytes);
    expect(d.stickerMessage.soundAudio.seconds).toBe(3);
  });

  it("entende mensagem só com o campo 134 e aninhada", () => {
    const d = proto.Message.decode(field(134, wrapper()));
    expect(d.stickerMessage.width).toBe(512);
    expect(d.stickerMessage.soundAudio.url).toBe("https://x");
    const inner = proto.Message.fromObject({ stickerMessage: { mimetype: "image/webp" } });
    inner[SB] = wrapper();
    const dsm = proto.Message.fromObject({ deviceSentMessage: { destinationJid: "a" } });
    dsm.deviceSentMessage.message = inner;
    const d2 = proto.Message.decode(proto.Message.encode(dsm).finish());
    expect(d2.deviceSentMessage.message.stickerMessage.soundAudio.mimetype).toContain("opus");
  });

  it("mensagem comum continua igual", () => {
    const d = proto.Message.decode(proto.Message.encode({ conversation: "oi" }).finish());
    expect(d.conversation).toBe("oi");
    expect(d.stickerMessage).toBeFalsy();
  });
});

describe("figurinha com som — ffmpeg", () => {
  it("extrai áudio, anima figurinha estática e faz mp4 com som", () => {
    const dir = mkdtempSync(join(tmpdir(), "ss-"));
    try {
      const video = join(dir, "v.mp4");
      const webp = join(dir, "s.webp");
      const ff = (args) => spawnSync(ffmpegInstaller.path, ["-y", "-hide_banner", "-loglevel", "error", ...args]);
      ff(["-f", "lavfi", "-i", "testsrc=s=320x240:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-shortest", "-pix_fmt", "yuv420p", video]);
      ff(["-f", "lavfi", "-i", "color=c=red:s=512x512:d=1", "-frames:v", "1", webp]);
      const audio = extractStickerAudio(video, dir);
      expect(audio?.path && existsSync(audio.path)).toBe(true);
      expect(audio.seconds).toBeGreaterThan(2);
      const anim = staticWebpToAnimated(webp, dir, 2);
      expect(anim && existsSync(anim)).toBe(true);
      const mp4 = muxAudioIntoMp4(video, audio.path, dir);
      expect(probeMedia(mp4).hasAudio).toBe(true);
      // vídeo sem áudio → null
      const mute = join(dir, "m.mp4");
      ff(["-f", "lavfi", "-i", "testsrc=s=320x240:d=1", "-pix_fmt", "yuv420p", mute]);
      expect(extractStickerAudio(mute, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
