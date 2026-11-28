import { isOwnerContact } from "../../../core/channels/userActivity.js";

/**
 * Ligação no zap. O WhatsApp Web (Baileys) não tem áudio de chamada, então ela não consegue atender:
 * deixa tocar um pouco (como quem viu), recusa e responde do jeito dela, com áudio da voz dela
 * quando dá. Insistiu ligando = resposta diferente; dormindo = recusa calada (só a dona leva um "zzz").
 */
const NOTE_COOLDOWN_MS = 10 * 60_000;

export function attachWhatsAppCallHandler(socket, runtime, { log = console, random = Math.random } = {}) {
  const lastNote = new Map(); // quem ligou → { at, n }
  socket.ev.on("call", async (calls = []) => {
    for (const call of calls) {
      if (call?.status !== "offer" || !call.from || !call.id) continue;
      try {
        await handleOffer(call);
      } catch (error) {
        log.warn?.(`[call-zap] falhou: ${error?.message ?? error}`);
      }
    }
  });

  async function handleOffer(call) {
    const from = call.from;
    const isOwner = isOwnerContact(runtime, from, null);
    const active = isOwner || runtime.tetoActivation?.isDmActive?.(`dm-${from.replace(/@.+$/, "")}`) || runtime.tetoActivation?.isDmActive?.(from);
    // Deixa tocar 3–7s, como gente que pegou o celular e viu quem é.
    await new Promise((r) => setTimeout(r, 3000 + random() * 4000));
    await socket.rejectCall?.(call.id, from).catch(() => {});
    log.log?.(`[call-zap] ${isOwner ? "dona" : from} ligou (${call.isVideo ? "vídeo" : "voz"}${call.isGroup ? ", grupo" : ""}) → recusei`);
    if (call.isGroup || !active) return;

    const mode = runtime.brainOrchestrator?.life?.availability?.({ chatId: from, isOwner })?.mode ?? "online";
    const prev = lastNote.get(from);
    const insisting = prev && Date.now() - prev.at < NOTE_COOLDOWN_MS;
    const n = insisting ? prev.n + 1 : 1;
    lastNote.set(from, { at: Date.now(), n });
    if (n > 3) return;

    let text;
    if (mode === "asleep") {
      if (!isOwner || n > 1) return;
      text = "zzz... tô dormindo, me liga não 😴";
    } else if (n === 1) {
      const options = [
        "não consigo atender ligação pelo zap 😭 me manda um áudio que eu te respondo falando",
        `ligação aqui não rola pra mim 😕 manda áudio${isOwner ? " ou me chama na call do Discord, lá eu entro e falo" : ""}`,
        "ei, eu não atendo ligação no zap! manda áudio que eu respondo com a minha voz"
      ];
      text = options[Math.floor(random() * options.length)];
    } else if (n === 2) {
      text = isOwner ? "Gabbis 😤 eu NÃO consigo atender pelo zap, me chama no Discord que lá eu entro na call" : "já falei que não consigo atender 😭 manda áudio";
    } else {
      text = "para de me ligar kkkkk";
    }

    const voice = runtime.voiceNotes;
    if (n === 1 && voice?.status?.().realVoice && !voice.status().out && mode !== "asleep") {
      try {
        const note = await voice.synthesize(text);
        await socket.sendMessage(from, { audio: note.audio, mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: note.seconds });
        return;
      } catch {
        /* sem voz agora: vai no texto */
      }
    }
    await socket.sendMessage(from, { text });
  }
}
