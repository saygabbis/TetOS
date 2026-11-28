import { describe, expect, it } from "vitest";
import { FISH_TETO_VOICE_ID, VoiceNotes, isVoiceCreditError } from "../../src/modules/voice/voiceNotes.js";
import { spawnSync } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

// 1s de silêncio em mp3, feito pelo ffmpeg (o que o Fish devolveria).
function silentMp3() {
  const r = spawnSync(ffmpegInstaller.path, ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1", "-f", "mp3", "pipe:1"]);
  return r.stdout;
}

function fakeFetch({ ttsStatus = 200, credit = "5.00" } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/wallet/")) return new Response(JSON.stringify({ credit }), { status: 200 });
    if (ttsStatus !== 200) return new Response(JSON.stringify({ status: ttsStatus, message: "x" }), { status: ttsStatus });
    return new Response(silentMp3(), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const fish = (over = {}) => ({ apiKey: "teste", voiceId: FISH_TETO_VOICE_ID, model: "s2.1-pro", lowCredit: 1, baseUrl: "https://api.fish.audio", ...over });

describe("voz da Teto (Fish Audio)", () => {
  it("usa o modelo da Teto e devolve ogg/opus", async () => {
    const f = fakeFetch();
    const v = new VoiceNotes({ fish: fish(), fetchImpl: f, enabled: true });
    expect(v.provider).toBe("fish");
    const note = await v.synthesize("oi gente, tudo bem?");
    expect(note.audio.subarray(0, 4).toString()).toBe("OggS");
    const tts = f.calls.find((c) => c.url.endsWith("/v1/tts"));
    expect(JSON.parse(tts.init.body).reference_id).toBe(FISH_TETO_VOICE_ID);
    expect(tts.init.headers.Authorization).toBe("Bearer teste");
  });

  it("sem crédito: não troca de voz, avisa e não fica batendo na API", async () => {
    let t = 1_000_000;
    const f = fakeFetch({ ttsStatus: 402, credit: "0" });
    const v = new VoiceNotes({ fish: fish(), fetchImpl: f, now: () => t, fallbackEdge: false });
    const err = await v.synthesize("oi").catch((e) => e);
    expect(isVoiceCreditError(err)).toBe(true);
    expect(v.status().out).toBe(true);
    const before = f.calls.length;
    await v.synthesize("oi de novo").catch(() => {});
    expect(f.calls.length).toBe(before); // dentro dos 10 min nem chama
    const a = v.creditNotice("chat", { isOwner: true });
    const b = v.creditNotice("chat", { isOwner: true });
    expect(a).toMatch(/crédito/);
    expect(b).not.toBe(a);
    expect(b).toMatch(/volta/);
  });

  it("crédito volta sozinho quando recarrega", async () => {
    let t = 1_000_000;
    let credit = "0";
    let status = 402;
    const fetchImpl = async (url) =>
      url.includes("/wallet/") ? new Response(JSON.stringify({ credit }), { status: 200 }) : status === 200 ? new Response(silentMp3(), { status: 200 }) : new Response("{}", { status });
    const v = new VoiceNotes({ fish: fish(), fetchImpl, now: () => t });
    await v.synthesize("oi").catch(() => {});
    expect(v.status().out).toBe(true);
    credit = "10";
    status = 200;
    t += 11 * 60_000;
    const note = await v.synthesize("voltei");
    expect(note.audio.length).toBeGreaterThan(0);
    expect(v.status().out).toBe(false);
  });

  it("crédito baixo: avisa uma vez por dia", async () => {
    const v = new VoiceNotes({ fish: fish(), fetchImpl: fakeFetch({ credit: "0.40" }) });
    await v.refreshCredit();
    expect(v.status().low).toBe(true);
    expect(v.creditNotice("c", { kind: "low", isOwner: true })).toMatch(/acabando/);
    expect(v.creditNotice("c", { kind: "low", isOwner: true })).toBeNull();
  });
});
