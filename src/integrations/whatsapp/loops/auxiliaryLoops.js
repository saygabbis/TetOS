// Rotinas periódicas do runner: vida, iniciativa, lembretes, relatório diário e retenções.
import { DEFAULTS } from "../../../infra/config/defaults.js";
import { runMediaRetentionSweep } from "../../../infra/media/mediaRetentionSweep.js";
import { sweepMindLogRetention } from "../../../infra/mindLogRetention.js";
import { deliverDueReminders } from "../../../modules/reminders/reminderDelivery.js";
import { notePresenceError, runPresence } from "./initiativeLoop.js";
import { markOutbox, takePendingOutbox } from "../conversation/outbox.js";
import { dmUserId } from "../../../core/channels/userActivity.js";
import { buildAutomateOutcomePrompt } from "../../automate/automateOutcomePrompt.js";

/** "dona"/"owner" → JID da dona; número → JID de telefone; JID → ele mesmo. */
function resolveOutboxJid(to) {
  const t = String(to ?? "").trim();
  if (/^(dona|owner|gabbis)$/i.test(t)) return DEFAULTS.ownerWaJids?.[0] ?? null;
  if (t.includes("@")) return t;
  const digits = t.replace(/\D/g, "");
  return digits.length >= 10 ? `${digits}@s.whatsapp.net` : null;
}

async function deliverOutbox(runtime) {
  for (const item of takePendingOutbox(DEFAULTS.whatsappOutboxPath)) {
    const jid = resolveOutboxJid(item.to);
    if (!jid || jid.endsWith("@g.us")) {
      markOutbox(DEFAULTS.whatsappOutboxPath, item.id, "failed", "destino inválido (só PV)");
      continue;
    }
    const sessionId = `wa-dm:${jid}`;
    const userId = dmUserId(jid);
    let texts = [item.text];
    if (item.kind === "automate_outcome") {
      // Tarefa no PC terminou: ela conta o resultado do jeito dela (não é fala da dona).
      const replies = await runtime.chatService.handleMessage(
        buildAutomateOutcomePrompt({ ...item.payload, fromUser: false }),
        { userId, sessionId, channelId: jid, isOwner: true, skipUserRecord: true, fallback: "ground" },
        runtime.shortTerm?.getAll?.(sessionId)?.slice(-10) ?? [],
        "playful"
      );
      texts = (Array.isArray(replies) ? replies : [replies]).filter(Boolean).slice(0, 2);
    }
    if (!texts.length) {
      markOutbox(DEFAULTS.whatsappOutboxPath, item.id, "failed", "sem texto");
      continue;
    }
    const ok = await runtime.waOrchestrator.sendProactive({ remoteJid: jid, userId, sessionId, texts });
    if (ok && item.kind !== "automate_outcome") runtime.shortTerm?.add?.({ role: "assistant", content: `mensagem(${JSON.stringify(item.text)})` }, sessionId);
    markOutbox(DEFAULTS.whatsappOutboxPath, item.id, ok ? "sent" : "failed", ok ? null : "envio interrompido");
  }
}

export function scheduleAuxiliaryLoops(runtime, getSocket, getConnected) {
  // A mente avisa no PV quem pediu algo pra ela (estudo/habilidade pronta).
  runtime.mind?.registerSender?.("whatsapp", async ({ chatId, userId, text }) => {
    if (!getConnected() || !runtime.waOrchestrator?.sendProactive || !String(chatId ?? "").includes("@")) throw new Error("zap offline");
    const sessionId = `wa-dm:${chatId}`;
    const ok = await runtime.waOrchestrator.sendProactive({ remoteJid: chatId, userId: userId ?? dmUserId(chatId), sessionId, texts: [text] });
    if (!ok) throw new Error("envio interrompido");
    runtime.shortTerm?.add?.({ role: "assistant", content: `mensagem(${JSON.stringify(text)})` }, sessionId);
  });

  // Vida: avisa quando ela acorda/volta (entrega o que ficou pra depois). Barato — só consulta o plano do dia.
  if (runtime.brainOrchestrator?.life?.tick) {
    setInterval(() => {
      try {
        runtime.brainOrchestrator.life.tick();
      } catch (error) {
        console.warn("[life] tick error:", error?.message ?? error);
      }
    }, 60_000).unref?.();
  }

  // Repassa de cabeça as conversas que esfriaram (caderno de memória por pessoa/grupo).
  if (runtime.peopleMemory) {
    setInterval(() => {
      runtime.peopleMemory.consolidateDue({ max: 2 }).catch((error) => {
        console.warn("[memória] consolidação:", error?.message ?? error);
      });
    }, 3 * 60_000).unref?.();
  }

  // Pedidos de envio vindos da API/MCP (outro processo): o runner é quem tem a conexão.
  setInterval(() => {
    if (!getConnected() || !runtime.waOrchestrator?.sendProactive) return;
    deliverOutbox(runtime).catch((error) => console.warn("[outbox]", error?.message ?? error));
  }, 5000).unref?.();

  if (DEFAULTS.presenceEnabled) {
    setInterval(() => {
      const socket = getSocket();
      if (!getConnected() || !socket) return;
      runPresence(runtime, socket).catch(notePresenceError);
    }, DEFAULTS.presenceCheckMs);
  }

  setInterval(() => {
    const due = runtime.reminderScheduler?.sweep?.() ?? [];
    if (due.length) {
      runtime.logger?.log?.("reminders.scheduled_due", { count: due.length });
    }
    const socket = getSocket();
    if (!getConnected() || !socket) return;
    deliverDueReminders(runtime, socket, { replyEnabled: DEFAULTS.replyEnabled }).catch((error) => {
      console.error("[reminders] delivery error:", error.message);
    });
  }, DEFAULTS.reminderSweepMs);

  if (DEFAULTS.dailyReportEnabled) {
    setInterval(() => {
      const report = runtime.dailyReportGenerator?.maybeGenerateNow?.(
        new Date(),
        DEFAULTS.dailyReportTime
      );
      if (report) {
        runtime.logger?.log?.("learning.daily_report_generated", report);
      }
    }, 30000);
  }

  if (DEFAULTS.mediaRetentionEnabled) {
    const sweep = () =>
      runMediaRetentionSweep({
        mediaRoot: DEFAULTS.whatsappMediaPath,
        maxBytes: DEFAULTS.mediaHotMaxBytes,
        visualAnalysesPath: DEFAULTS.visualAnalysesPath,
        multimodalMemoryPath: DEFAULTS.multimodalMemoryPath,
        logger: runtime.logger
      }).catch((error) => {
        console.error("[media-retention]", error?.message ?? error);
      });
    setTimeout(sweep, 120_000);
    setInterval(sweep, DEFAULTS.mediaRetentionIntervalMs);
  }

  if (DEFAULTS.mindLogEnabled && DEFAULTS.mindLogRetentionDays > 0) {
    const sweepMindLog = () => {
      try {
        const result = sweepMindLogRetention(DEFAULTS.mindLogPath, DEFAULTS.mindLogRetentionDays);
        if (result.removed > 0) {
          console.log(`[mind-log] retencao: removidos ${result.removed}, mantidos ${result.kept}`);
        }
      } catch (error) {
        console.error("[mind-log] retencao:", error?.message ?? error);
      }
    };
    setTimeout(sweepMindLog, 180_000);
    setInterval(sweepMindLog, 6 * 60 * 60 * 1000);
  }
}

