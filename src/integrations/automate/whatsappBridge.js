import { DEFAULTS } from "../../infra/config/defaults.js";
import { enqueueOutbox } from "../whatsapp/conversation/outbox.js";
import { automateOutcomes, bindRunToThread, markRunForExplanation, registerAutomateRun } from "./automateRunContext.js";
import { parseInstructionFromEnqueueResult } from "./uiReplies.js";

/**
 * Ponte WhatsApp → AutoMate (roda no processo da API, que é quem fala com o PC):
 * a dona pede no PV do zap, o runner chama POST /automate/whatsapp/run, a tarefa vai pro AutoMate e,
 * quando termina, o resultado volta pela caixa de saída — o runner do WhatsApp explica no jeito dela.
 * Exige TETOS_API_TOKEN (sem token, os endpoints ficam fechados).
 */
export function registerWhatsAppAutomateBridge(app, { automateClient, deviceGateway, apiToken }) {
  const requireToken = (req, res, next) => {
    if (!apiToken) return res.status(403).json({ error: "defina TETOS_API_TOKEN para usar o AutoMate pelo WhatsApp" });
    if ((req.headers.authorization ?? "") !== `Bearer ${apiToken}`) return res.status(401).json({ error: "unauthorized" });
    return next();
  };
  const deviceId = process.env.TETOS_DEFAULT_DEVICE_ID ?? "default-device";

  app.get("/automate/status", requireToken, (req, res) => {
    res.json({ online: Boolean(deviceGateway?.isDeviceConnected?.(deviceId)) });
  });

  app.post("/automate/whatsapp/run", requireToken, async (req, res) => {
    const intent = String(req.body?.intent ?? "").trim();
    const jid = String(req.body?.jid ?? "").trim();
    if (!intent || !jid || jid.endsWith("@g.us")) return res.status(400).json({ error: "intent e jid (PV) são obrigatórios" });
    if (!deviceGateway?.isDeviceConnected?.(deviceId)) return res.status(409).json({ error: "offline" });
    const threadId = `wa:${jid}`;
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    bindRunToThread(runId, threadId);
    markRunForExplanation(runId, intent, { fromUser: false });
    try {
      const result = await automateClient.enqueue(intent, undefined, { threadId, runId });
      const instructionId = parseInstructionFromEnqueueResult(result);
      if (instructionId) registerAutomateRun({ instructionId, runId, threadId });
      return res.json({ runId, instructionId });
    } catch (error) {
      return res.status(502).json({ error: error?.message ?? "falha ao falar com o PC" });
    }
  });

  // Terminou uma tarefa pedida pelo zap: devolve pro runner explicar no PV.
  automateOutcomes.on("outcome", (outcome) => {
    if (!String(outcome?.threadId ?? "").startsWith("wa:")) return;
    try {
      enqueueOutbox(DEFAULTS.whatsappOutboxPath, {
        to: outcome.threadId.slice(3),
        kind: "automate_outcome",
        payload: {
          status: outcome.status,
          output: String(outcome.output ?? "").slice(0, 3000),
          error: outcome.error ? String(outcome.error).slice(0, 600) : null,
          intent: outcome.intent ?? null
        },
        by: "automate"
      });
    } catch (error) {
      console.error("[automate→zap]", error?.message ?? error);
    }
  });
}
