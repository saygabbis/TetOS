// Rotinas periódicas do runner: vida, iniciativa, lembretes, relatório diário e retenções.
import { DEFAULTS } from "../../infra/config/defaults.js";
import { runMediaRetentionSweep } from "../../infra/media/mediaRetentionSweep.js";
import { sweepMindLogRetention } from "../../infra/mindLogRetention.js";
import { deliverDueReminders } from "../../modules/reminders/reminderDelivery.js";
import { notePresenceError, runPresence } from "./presenceLoop.js";

export function scheduleAuxiliaryLoops(runtime, nudgeEngine, getSocket, getConnected) {
  const lifeTickMs = Number(process.env.TETOS_LIFE_TICK_MS ?? 900000);
  if (runtime.brainOrchestrator?.life?.tick && Number.isFinite(lifeTickMs) && lifeTickMs >= 120000) {
    setInterval(() => {
      try {
        runtime.brainOrchestrator.life.tick({
          emotion: runtime.brainOrchestrator.emotion?.getSnapshot?.() ?? {}
        });
      } catch (error) {
        console.warn("[life] tick error:", error?.message ?? error);
      }
    }, lifeTickMs);
  }

  if (DEFAULTS.presenceEnabled) {
    setInterval(() => {
      const socket = getSocket();
      if (!getConnected() || !socket) return;
      runPresence(runtime, socket, nudgeEngine).catch(notePresenceError);
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

