import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLegacyMindLogPath, resolveMindLogDailyPath } from "../consciousness/mindLogPaths.js";
import { readNdjsonFile, readNdjsonStream } from "../../infra/ndjsonReader.js";

function dayKey(date = new Date(), timeZone = "America/Sao_Paulo") {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function readMindLogForDay(mindLogPath, day) {
  if (isLegacyMindLogPath(mindLogPath)) {
    return readNdjsonStream(mindLogPath, {
      lineFilter: (line) => line.includes(day)
    }).filter((entry) => String(entry.ts ?? "").startsWith(day));
  }
  return readNdjsonFile(resolveMindLogDailyPath(mindLogPath, day));
}

export class DailyReportGenerator {
  constructor({
    reportsPath,
    ledger,
    behaviorProfiler,
    focusStore,
    timeZone = "America/Sao_Paulo",
    mindLogPath = null
  } = {}) {
    this.reportsPath = reportsPath;
    this.ledger = ledger;
    this.behaviorProfiler = behaviorProfiler;
    this.focusStore = focusStore;
    this.timeZone = timeZone;
    this.mindLogPath = mindLogPath;
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
    const events = readNdjsonFile(ledgerPath);
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
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      events: 0,
      messages: 0,
      media: 0,
      reactions: 0
    }));
    const timelineEvents = [];
    let prevTs = null;
    const gaps = [];
    for (const ev of events) {
      const ts = ev.ts ? Date.parse(ev.ts) : null;
      const hour = ts ? new Date(ts).getHours() : 0;
      if (hourly[hour]) {
        hourly[hour].events += 1;
        if (String(ev.eventType).includes("message")) hourly[hour].messages += 1;
        if (ev.mediaType) hourly[hour].media += 1;
        if (String(ev.eventType).includes("reaction")) hourly[hour].reactions += 1;
      }
      if (ts && prevTs) {
        const gapMin = (ts - prevTs) / 60000;
        if (gapMin > 30) gaps.push({ from: new Date(prevTs).toISOString(), to: new Date(ts).toISOString(), minutes: Math.round(gapMin) });
      }
      if (ts) prevTs = ts;
      if (timelineEvents.length < 200) {
        timelineEvents.push({
          ts: ev.ts ?? null,
          eventType: ev.eventType ?? null,
          actorId: ev.actorId ?? ev.userId ?? null,
          mediaType: ev.mediaType ?? null
        });
      }
    }
    const mindEntries = this.mindLogPath
      ? readMindLogForDay(this.mindLogPath, day)
      : [];
    const mindSamples = mindEntries.slice(-24);
    const hourlySnapshots = Array.from({ length: 24 }, (_, hour) => {
      const hourEntries = mindEntries.filter((e) => {
        const ts = e.ts ? Date.parse(e.ts) : null;
        return ts && new Date(ts).getHours() === hour;
      });
      const last = hourEntries.at(-1)?.brain ?? {};
      return {
        hour,
        samples: hourEntries.length,
        trust: last.trustBond ?? null,
        world: last.worldContext ?? last.world ?? null,
        health: last.health ?? null,
        emotion: last.emotion?.mood ?? null
      };
    }).filter((h) => h.samples > 0);
    const timingByHour = Object.entries(behavior.byHour ?? {}).map(([hour, data]) => ({
      hour: Number(hour),
      messages: data?.messages ?? 0,
      reactions: data?.reactions ?? 0,
      avgLatencyMs: data?.avgLatencyMs ?? null
    }));
    const firstTs = events[0]?.ts ? Date.parse(events[0].ts) : null;
    const lastTs = events[events.length - 1]?.ts ? Date.parse(events[events.length - 1].ts) : null;
    const duration = {
      activeSpanMinutes: firstTs && lastTs ? Math.round((lastTs - firstTs) / 60000) : 0,
      longestSilenceMin: gaps.length ? Math.max(...gaps.map((g) => g.minutes)) : 0,
      silenceGaps: gaps.length
    };
    const json = {
      day,
      generatedAt: new Date().toISOString(),
      timezone: this.timeZone,
      focus,
      totals: { events: events.length, byEvent },
      timeline: {
        hourly,
        events: timelineEvents,
        gaps: gaps.slice(0, 20)
      },
      timing: {
        byHour: timingByHour,
        avgLatencyMs: behavior.avgLatencyMs ?? null,
        p50Ms: behavior.avgLatencyMs ?? null
      },
      duration,
      mindSnapshots: mindSamples,
      hourlySnapshots,
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
    const peakHours = hourly
      .filter((h) => h.messages > 0)
      .sort((a, b) => b.messages - a.messages)
      .slice(0, 3)
      .map((h) => `${h.hour}h (${h.messages} msgs)`);
    const md = [
      `# Relatorio Diario - ${day}`,
      "",
      `- Gerado em: ${json.generatedAt} (${this.timeZone})`,
      `- Eventos totais: ${events.length}`,
      peakHours.length ? `- Pico de atividade: ${peakHours.join(", ")}` : "",
      `- Foco atual: ${focus.focus}`,
      `- Notas de foco: ${focus.notes || "nenhuma"}`,
      `- Latencia media de resposta (ms): ${behavior.avgLatencyMs ?? "n/d"}`,
      duration.longestSilenceMin ? `- Maior silencio: ${duration.longestSilenceMin}min` : "",
      duration.activeSpanMinutes ? `- Faixa ativa do dia: ~${duration.activeSpanMinutes}min` : "",
      "",
      "## Timeline por hora",
      ...hourly.filter((h) => h.events > 0).map((h) => `- ${String(h.hour).padStart(2, "0")}h: ${h.events} eventos (${h.messages} msgs, ${h.media} midias)`),
      "",
      "## Snapshots cerebrais por hora",
      ...hourlySnapshots.map((h) =>
        `- ${String(h.hour).padStart(2, "0")}h: trust=${h.trust?.trust ?? "n/d"} world=${h.world?.currentLocation ?? "n/d"} health=${Array.isArray(h.health) ? h.health.length : 0} mood=${h.emotion ?? "n/d"}`
      ),
      "",
      "## Eventos marcantes (com hora)",
      ...timelineEvents.slice(-15).map((e) => `- ${e.ts ?? "?"} [${e.eventType}] ${e.actorId ?? ""}`),
      gaps.length ? `\nMaior silencio: ${gaps.sort((a, b) => b.minutes - a.minutes)[0].minutes}min` : "",
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
    try {
      return this.generateForDay(day);
    } catch (error) {
      console.error("[daily-report] falha ao gerar relatorio:", error?.message ?? error);
      return null;
    }
  }
}
