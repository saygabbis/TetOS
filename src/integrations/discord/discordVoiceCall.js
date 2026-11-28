/**
 * Call de voz da Teto no Discord: entra no canal de voz de quem chamou, ouve cada pessoa (Whisper),
 * responde pelo mesmo cérebro do chat e fala com a voz DELA (Fish Audio).
 *
 *  - Sem crédito de voz: nem entra (avisa no texto); se acabar no meio, avisa e sai da call.
 *  - Crédito acabando: avisa uma vez falando e segue.
 *  - Sai sozinha quando a call fica sem gente, quando pedem, ou depois de MAX_CALL_MS.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

const MIN_SPEECH_MS = 600;
const MAX_UTTERANCE_MS = 25_000;
const SILENCE_END_MS = 900;
const GATHER_MS = 700;
const EMPTY_LEAVE_MS = 45_000;
const MAX_CALL_MS = 90 * 60_000;

export const CALL_JOIN_RE = /(?<!\p{L})(entra|entrar|vem|vamo|bora|cola|chega)(?!\p{L}).{0,25}(?<!\p{L})(call|chamada|liga[çc][ãa]o|canal de voz|voice|vc|voz)(?!\p{L})/iu;
export const CALL_LEAVE_RE = /(?<!\p{L})(sai|sair|vaza|desliga|desligar|tchau)(?!\p{L}).{0,20}(?<!\p{L})(call|chamada|voice|vc)(?!\p{L})/iu;

/** Texto que ela fala na call a partir das ações do cérebro (mensagem/áudio viram fala). */
export function spokenFromActions(actions = []) {
  return actions
    .filter((a) => (a.type === "message" || a.type === "voice") && a.text)
    .map((a) => String(a.text).trim())
    .filter(Boolean)
    .join(". ")
    .slice(0, 600);
}

function pcmToOgg(pcm, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-v", "error", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-ac", "1", "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1"], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const out = [];
    let err = "";
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim() || `ffmpeg ${code}`))));
    child.stdin.end(pcm);
  });
}

export function createDiscordVoiceCalls({ runtime, client, identityOf, respondInCall, log = console, ffmpegPath = process.env.TETOS_FFMPEG_PATH || ffmpegInstaller.path }) {
  const sessions = new Map(); // guildId → sessão
  let voiceLib = null;
  const lib = async () => (voiceLib ??= await import("@discordjs/voice"));
  const prism = async () => (await import("prism-media")).default;

  const voice = () => runtime.voiceNotes;

  async function say(session, text) {
    const v = voice();
    if (!v?.synthesize || !text) return false;
    try {
      const note = await v.synthesize(text);
      const { createAudioResource, StreamType, AudioPlayerStatus, entersState } = await lib();
      const resource = createAudioResource(Readable.from(note.audio), { inputType: StreamType.OggOpus });
      session.player.play(resource);
      await entersState(session.player, AudioPlayerStatus.Playing, 5_000).catch(() => {});
      await entersState(session.player, AudioPlayerStatus.Idle, Math.max(15_000, note.seconds * 2500)).catch(() => {});
      const st = v.status?.();
      if (st?.low && !session.warnedLow) {
        session.warnedLow = true;
        const low = v.creditNotice(`discord-call:${session.guildId}`, { kind: "low", isOwner: true });
        if (low) {
          const n2 = await v.synthesize(low).catch(() => null);
          if (n2) {
            session.player.play(createAudioResource(Readable.from(n2.audio), { inputType: StreamType.OggOpus }));
            await entersState(session.player, AudioPlayerStatus.Idle, 20_000).catch(() => {});
          }
        }
      }
      return true;
    } catch (error) {
      if (error?.code === "voice_no_credit") {
        const notice = v.creditNotice(`discord-call:${session.guildId}`, { isOwner: session.ownerAsked }) ?? "acabou meu crédito de voz";
        await session.textChannel?.send?.({ content: `${notice}\n(vou sair da call, sem voz não dá 😭)`, allowedMentions: { parse: [] } }).catch(() => {});
        await leave(session.guildId, "sem crédito de voz");
        return false;
      }
      log.warn?.(`[call] falar falhou: ${error?.message ?? error}`);
      return false;
    }
  }

  function listen(session, userId) {
    if (session.listening.has(userId) || userId === client.user?.id) return;
    const member = session.channel.guild.members.cache.get(userId);
    if (member?.user?.bot) return;
    session.listening.add(userId);
    (async () => {
      const { EndBehaviorType } = await lib();
      const P = await prism();
      const started = Date.now();
      const opus = session.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_END_MS } });
      const decoder = new P.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
      const chunks = [];
      let bytes = 0;
      const cutoff = setTimeout(() => opus.destroy(), MAX_UTTERANCE_MS);
      opus.pipe(decoder);
      decoder.on("data", (c) => {
        chunks.push(c);
        bytes += c.length;
      });
      await new Promise((r) => {
        decoder.once("end", r);
        decoder.once("close", r);
        opus.once("close", () => setTimeout(r, 50));
        decoder.once("error", r);
      });
      clearTimeout(cutoff);
      // 48000 Hz × 2 canais × 2 bytes = 192 bytes por ms.
      const ms = bytes / 192;
      if (ms < MIN_SPEECH_MS || !sessions.has(session.guildId)) return;
      const ogg = await pcmToOgg(Buffer.concat(chunks), ffmpegPath);
      const dir = mkdtempSync(join(tmpdir(), "tetos-call-"));
      try {
        const file = join(dir, "fala.ogg");
        writeFileSync(file, ogg);
        const r = await runtime.audioTranscriber?.transcribe?.({ filePath: file, mimetype: "audio/ogg" });
        const text = String(r?.text ?? "").trim();
        if (text && text.length > 1) heard(session, userId, text, started);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })()
      .catch((error) => log.warn?.(`[call] ouvir falhou: ${error?.message ?? error}`))
      .finally(() => session.listening.delete(userId));
  }

  /** Junta falas que chegam juntas (várias pessoas) e manda pro cérebro uma vez. */
  function heard(session, userId, text, at) {
    const member = session.channel.guild.members.cache.get(userId);
    const name = member?.displayName ?? member?.user?.username ?? "alguém";
    session.lastActivity = Date.now();
    log.log?.(`[call] ${name}: ${text}`);
    if (CALL_LEAVE_RE.test(text) && /teto/i.test(text)) {
      void (async () => {
        await say(session, "tá bom, tô saindo, tchauzinho");
        await leave(session.guildId, "pediram pra sair");
      })();
      return;
    }
    session.pending.push({ userId, name, text, at });
    clearTimeout(session.gatherTimer);
    session.gatherTimer = setTimeout(() => void flush(session), GATHER_MS);
  }

  async function flush(session) {
    if (session.busy || !session.pending.length || !sessions.has(session.guildId)) return;
    session.busy = true;
    const batch = session.pending.splice(0);
    try {
      const people = batch.map((b) => ({ ...b, ...identityOf({ id: b.userId }) }));
      const actions = await respondInCall({ session, people });
      const spoken = spokenFromActions(actions);
      if (spoken) {
        log.log?.(`[call] Teto: ${spoken}`);
        await say(session, spoken);
      }
    } catch (error) {
      log.warn?.(`[call] resposta falhou: ${error?.message ?? error}`);
    } finally {
      session.busy = false;
      if (session.pending.length) void flush(session);
    }
  }

  async function join({ guild, voiceChannel, textChannel, requesterId, isOwner = false }) {
    const v = voice();
    if (!v?.status?.().realVoice) return { ok: false, note: "ainda não tenho minha voz de verdade configurada, então não dá pra entrar na call 😕" };
    if (v.status().out) await v.refreshCredit?.();
    if (v.status().out) return { ok: false, note: v.creditNotice(`discord-call:${guild.id}`, { isOwner }) ?? "tô sem crédito de voz" };
    const existing = sessions.get(guild.id);
    if (existing?.channel?.id === voiceChannel.id) return { ok: true, already: true };
    if (existing) await leave(guild.id, "mudou de canal");
    const { joinVoiceChannel, createAudioPlayer, entersState, VoiceConnectionStatus, NoSubscriberBehavior } = await lib();
    const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: false });
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      connection.destroy();
      return { ok: false, note: "não consegui entrar na call 😭 (vê se eu tenho permissão de conectar e falar)" };
    }
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(player);
    const session = {
      guildId: guild.id,
      channel: voiceChannel,
      textChannel,
      connection,
      player,
      ownerAsked: isOwner,
      requesterId,
      listening: new Set(),
      pending: [],
      busy: false,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      emptySince: null,
      warnedLow: false
    };
    sessions.set(guild.id, session);
    connection.receiver.speaking.on("start", (userId) => listen(session, userId));
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([entersState(connection, VoiceConnectionStatus.Signalling, 5_000), entersState(connection, VoiceConnectionStatus.Connecting, 5_000)]);
      } catch {
        await leave(guild.id, "caiu a conexão");
      }
    });
    session.watch = setInterval(() => {
      const humans = [...(session.channel.members?.values?.() ?? [])].filter((m) => !m.user?.bot).length;
      if (humans === 0) session.emptySince ??= Date.now();
      else session.emptySince = null;
      if ((session.emptySince && Date.now() - session.emptySince > EMPTY_LEAVE_MS) || Date.now() - session.startedAt > MAX_CALL_MS) {
        void leave(guild.id, humans === 0 ? "call vazia" : "tempo máximo");
      }
    }, 10_000);
    session.watch.unref?.();
    log.log?.(`[call] entrou em ${guild.name} / ${voiceChannel.name}`);
    return { ok: true, session };
  }

  async function leave(guildId, reason = "") {
    const s = sessions.get(guildId);
    if (!s) return false;
    sessions.delete(guildId);
    clearInterval(s.watch);
    clearTimeout(s.gatherTimer);
    try {
      s.player.stop(true);
      s.connection.destroy();
    } catch {}
    log.log?.(`[call] saiu (${reason})`);
    return true;
  }

  return { join, leave, say, sessionOf: (guildId) => sessions.get(guildId) ?? null, active: () => [...sessions.values()] };
}
