import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function dayKey(date = new Date(), timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function safeReadNdjson(path) {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export class DailyReportGenerator {
  constructor({
    reportsPath,
    ledger,
    behaviorProfiler,
    focusStore,
    timeZone = "America/Sao_Paulo"
  } = {}) {
    this.reportsPath = reportsPath;
    this.ledger = ledger;
    this.behaviorProfiler = behaviorProfiler;
    this.focusStore = focusStore;
    this.timeZone = timeZone;
    this.lastGeneratedDay = null;
    if (!existsSync(this.reportsPath)) {
      mkdirSync(this.reportsPath, { recursive: true });
    }
  }

  generateForDay(day) {
    const reportDir = join(this.reportsPath, day);
    if (!existsSync(reportDir)) {
      mkdirSync(reportDir, { recursive: true });
    }
    const ledgerPath = join(this.ledger.basePath, `${day}.ndjson`);
    const events = safeReadNdjson(ledgerPath);
    const byEvent = {};
    const edits = [];
    const deletions = [];
    const commandStats = {
      total: 0,
      byCommand: {},
      byStatus: {},
      byInputType: {},
      byOutputType: {},
      byTargetSource: {},
      elapsedSamples: []
    };
    for (const ev of events) {
      const key = String(ev.eventType ?? "unknown");
      byEvent[key] = (byEvent[key] ?? 0) + 1;
      if (key === "message.edited") {
        edits.push({
          ts: ev.ts ?? null,
          messageId: ev.messageId ?? null,
          actorId: ev.actorId ?? null,
          beforeText: ev.beforeText ?? null,
          afterText: ev.afterText ?? null,
          reason: ev.reason ?? "nao_informado"
        });
      }
      if (key === "message.deleted") {
        deletions.push({
          ts: ev.ts ?? null,
          messageId: ev.messageId ?? null,
          beforeText: ev.beforeText ?? null,
          reason: ev.reason ?? "nao_informado"
        });
      }
      if (key === "command.media") {
        const commandName = String(ev.commandName ?? "unknown");
        const status = String(ev.status ?? "unknown");
        const inputType = String(ev.inputType ?? "unknown");
        const outputType = String(ev.outputType ?? "unknown");
        const targetSource = String(ev.targetSource ?? "unknown");
        commandStats.total += 1;
        commandStats.byCommand[commandName] = (commandStats.byCommand[commandName] ?? 0) + 1;
        commandStats.byStatus[status] = (commandStats.byStatus[status] ?? 0) + 1;
        commandStats.byInputType[inputType] = (commandStats.byInputType[inputType] ?? 0) + 1;
        commandStats.byOutputType[outputType] = (commandStats.byOutputType[outputType] ?? 0) + 1;
        commandStats.byTargetSource[targetSource] = (commandStats.byTargetSource[targetSource] ?? 0) + 1;
        if (Number.isFinite(Number(ev.elapsedMs))) {
          commandStats.elapsedSamples.push(Number(ev.elapsedMs));
        }
      }
    }
    const avgCommandLatencyMs = commandStats.elapsedSamples.length
      ? Math.round(
        commandStats.elapsedSamples.reduce((acc, n) => acc + n, 0) / commandStats.elapsedSamples.length
      )
      : null;
    const behavior = this.behaviorProfiler.snapshot();
    const focus = this.focusStore.get();
    const json = {
      day,
      generatedAt: new Date().toISOString(),
      focus,
      totals: { events: events.length, byEvent },
      edits: {
        count: edits.length,
        samples: edits.slice(-50)
      },
      deletions: {
        count: deletions.length,
        samples: deletions.slice(-50)
      },
      commandMedia: {
        total: commandStats.total,
        avgLatencyMs: avgCommandLatencyMs,
        byCommand: commandStats.byCommand,
        byStatus: commandStats.byStatus,
        byInputType: commandStats.byInputType,
        byOutputType: commandStats.byOutputType,
        byTargetSource: commandStats.byTargetSource
      },
      behavior
    };
    const md = [
      `# Relatorio Diario - ${day}`,
      "",
      `- Eventos totais: ${events.length}`,
      `- Foco atual: ${focus.focus}`,
      `- Notas de foco: ${focus.notes || "nenhuma"}`,
      `- Latencia media de resposta (ms): ${behavior.avgLatencyMs ?? "n/d"}`,
      "",
      "## Eventos por tipo",
      ...Object.entries(byEvent).map(([k, v]) => `- ${k}: ${v}`),
      "",
      "## Perfil comportamental",
      `- Mensagens: ${behavior.totals.messages}`,
      `- Reacoes: ${behavior.totals.reactions}`,
      `- Midias: ${behavior.totals.media}`,
      `- Links: ${behavior.totals.links}`,
      "",
      "## Edicoes e exclusoes",
      `- Mensagens editadas: ${edits.length}`,
      `- Mensagens apagadas: ${deletions.length}`,
      ...edits.slice(-10).map((item) =>
        `- [EDIT] ${item.ts} id=${item.messageId} motivo=${item.reason} | antes="${item.beforeText ?? ""}" | depois="${item.afterText ?? ""}"`
      ),
      ...deletions.slice(-10).map((item) =>
        `- [DELETE] ${item.ts} id=${item.messageId} motivo=${item.reason} | antes="${item.beforeText ?? ""}"`
      ),
      "",
      "## Comandos de midia",
      `- Total de comandos: ${commandStats.total}`,
      `- Latencia media (ms): ${avgCommandLatencyMs ?? "n/d"}`,
      ...Object.entries(commandStats.byCommand).map(([k, v]) => `- Comando ${k}: ${v}`),
      ...Object.entries(commandStats.byStatus).map(([k, v]) => `- Status ${k}: ${v}`),
      ...Object.entries(commandStats.byTargetSource).map(([k, v]) => `- Origem ${k}: ${v}`),
      "",
      "## Arvore de aprendizado (resumo)",
      `- Entrada -> Captura -> Anonimizacao -> Ledger -> Perfil -> Relatorio`,
      `- Hipotese: priorizar horarios de pico e chats mais ativos no proximo ciclo.`
    ].join("\n");

    writeFileSync(join(reportDir, "report.json"), JSON.stringify(json, null, 2));
    writeFileSync(join(reportDir, "report.md"), md);
    this.lastGeneratedDay = day;
    return { day, events: events.length, reportDir };
  }

  maybeGenerateNow(referenceDate = new Date(), reportTime = "00:00") {
    const day = dayKey(referenceDate, this.timeZone);
    const [hh, mm] = String(reportTime).split(":").map((n) => Number(n));
    const hour = referenceDate.getHours();
    const minute = referenceDate.getMinutes();
    if (hour !== (hh || 0) || minute !== (mm || 0)) return null;
    if (this.lastGeneratedDay === day) return null;
    return this.generateForDay(day);
  }
}
