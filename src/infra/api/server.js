import "dotenv/config";
import express from "express";
import { DEFAULTS } from "../config/defaults.js";
import { autoTag } from "../../core/memory/tagger.js";
import { buildChannelView } from "../../core/channels/channelApiView.js";
import { readRecentLogs, summarizeLogs } from "../observability/logInspector.js";
import { buildRuntimeSummary } from "../observability/runtimeSummary.js";
import { buildMemorySummary } from "../observability/memorySummary.js";
import { buildReminderSummary } from "../../modules/reminders/reminderSummary.js";
import { createRuntime, handleIncomingMessage } from "../../app/createRuntime.js";

const app = express();
app.use(express.json());

const runtime = createRuntime();
const {
  longTerm,
  shortTerm,
  basicLoop,
  selectiveMemory,
  channelRegistry,
  channelAdmin,
  searchModule,
  documentModule,
  operationRouter,
  metrics,
  reminders,
  multimodalMemory,
  reminderScheduler
} = runtime;

app.post("/chat", async (req, res) => {
  try {
    const { replies } = await handleIncomingMessage(runtime, req.body ?? {});
    return res.json({ replies });
  } catch (error) {
    const statusCode = error?.statusCode ?? 500;
    return res.status(statusCode).json({ error: error.message });
  }
});

app.post("/memory/save", (req, res) => {
  const { tag, tags, content } = req.body ?? {};
  if (!content) {
    return res.status(400).json({ error: "content is required" });
  }

  const resolvedTags = Array.isArray(tags)
    ? tags.filter(Boolean).slice(0, DEFAULTS.maxTags)
    : tag
      ? [tag]
      : [autoTag(content)];

  const saved = longTerm.save({ tags: resolvedTags, content });
  return res.json({ status: "ok", entry: saved });
});

app.post("/memory/delete", (req, res) => {
  const { id } = req.body ?? {};
  if (!id) {
    return res.status(400).json({ error: "id is required" });
  }

  const removed = longTerm.delete(id);
  return res.json({ status: "ok", removed });
});

app.get("/memory", (req, res) => {
  return res.json({
    entries: longTerm.all(),
    profiles: longTerm.data?.profiles,
    mediumTerm: longTerm.data?.mediumTerm,
    selective: selectiveMemory.all()
  });
});

app.get("/memory/search", (req, res) => {
  const { tag, q } = req.query;
  const results = longTerm.search({ tag, query: q });
  return res.json({ entries: results });
});

app.post("/memory/search", (req, res) => {
  const { tag, q } = req.body ?? {};
  const results = longTerm.search({ tag, query: q });
  return res.json({ entries: results });
});

app.post("/nudge", async (req, res) => {
  const { userId } = req.body ?? {};
  const targetUser = typeof userId === "string" ? userId : "default";
  const payload = basicLoop.maybeNudge(targetUser, { hasRecentMemory: true });
  if (!payload?.text) {
    return res.json({ message: null, reason: payload?.reason ?? null });
  }
  const replies = await runtime.chatService.handleMessage(
    payload.text,
    { userId: targetUser, sessionId: `api-nudge-${targetUser}`, fallback: "ground" },
    null,
    "calm"
  );
  const text = Array.isArray(replies) ? replies[0] : replies;
  return res.json({ message: text ?? null, reason: payload?.reason ?? null });
});

app.post("/session/clear", (req, res) => {
  const { sessionId } = req.body ?? {};
  const sessionKey = sessionId ?? "default";
  shortTerm.clear(sessionKey);
  return res.json({ status: "ok" });
});

app.get("/channels", (req, res) => {
  const channels = Object.values(channelRegistry.data?.channels ?? {}).map(buildChannelView);
  return res.json({ channels });
});

app.get("/channels/:channelId", (req, res) => {
  const channel = channelRegistry.get(req.params.channelId, req.query.userId ?? "default");
  return res.json({ channel: buildChannelView(channel) });
});

app.post("/channels/admin", (req, res) => {
  const { channelId, userId, action, mode } = req.body ?? {};
  if (!channelId || !action) {
    return res.status(400).json({ error: "channelId and action are required" });
  }
  const updated = channelAdmin.execute({
    channelId,
    userId: userId ?? "default",
    action,
    patch: { mode }
  });
  return res.json({ status: "ok", channel: buildChannelView(updated) });
});

app.post("/search", async (req, res) => {
  try {
    const { q } = req.body ?? {};
    if (!q) {
      return res.status(400).json({ error: "q is required" });
    }
    const result = await searchModule.handle(q);
    return res.json({ status: "ok", ...result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/documents", (req, res) => {
  return res.json({ documents: documentModule.list() });
});

app.get("/reminders", (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : null;
  const filter = req.query.filter ? String(req.query.filter) : null;
  const all = reminders.list(userId);
  const filtered = filter === "pending"
    ? all.filter((item) => !item.done && item.dueAt && !item.delivered)
    : filter === "delivered"
      ? all.filter((item) => item.delivered)
      : filter === "failed"
        ? all.filter((item) => !item.done && item.dueAt && !item.delivered && item.deliveryAttempts > 0 && item.deliveryError)
        : filter === "open"
          ? all.filter((item) => !item.done)
          : all;
  return res.json({ reminders: filtered, summary: buildReminderSummary(reminders, reminderScheduler), filter });
});

app.get("/memory/multimodal", (req, res) => {
  const userId = req.query.userId ? String(req.query.userId) : null;
  return res.json({ entries: multimodalMemory.list(userId) });
});

app.get("/documents/:id", (req, res) => {
  const document = documentModule.read(req.params.id);
  if (!document) {
    return res.status(404).json({ error: "document not found" });
  }
  return res.json({ document });
});

app.post("/documents/:id", (req, res) => {
  const { content } = req.body ?? {};
  if (typeof content !== "string") {
    return res.status(400).json({ error: "content is required" });
  }
  const document = documentModule.write(req.params.id, content);
  return res.json({ status: "ok", document });
});

app.post("/operations", (req, res) => {
  const { type, userId, payload } = req.body ?? {};
  const result = operationRouter.execute({ type, userId, payload });
  if (!result) {
    return res.status(400).json({ error: "unknown operation" });
  }
  if (result.error) {
    return res.status(403).json(result);
  }
  return res.json({ status: "ok", ...result });
});

app.get("/logs", (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  const logs = readRecentLogs(DEFAULTS.logPath, limit);
  return res.json({ logs, summary: summarizeLogs(logs) });
});

app.get("/metrics", (req, res) => {
  return res.json({ metrics: metrics.getAll() });
});

app.get("/runtime/summary", (req, res) => {
  return res.json({ summary: buildRuntimeSummary(runtime) });
});

app.get("/status", (req, res) => {
  const { sessionId, channelId, userId } = req.query;
  return res.json({
    status: "ok",
    ollamaMode: DEFAULTS.ollamaMode,
    ollamaBaseUrl: DEFAULTS.ollamaBaseUrl,
    model: DEFAULTS.model,
    personalityPath: DEFAULTS.personalityPath,
    memoryCount: longTerm.all().length,
    selectiveMemoryCount: selectiveMemory.all().length,
    shortTermCount: shortTerm.getAll(sessionId ?? "default").length,
    channel: channelId ? buildChannelView(channelRegistry.get(channelId, userId ?? "default")) : null,
    documentsCount: documentModule.list().length,
    logsSummary: summarizeLogs(readRecentLogs(DEFAULTS.logPath, 100)),
    runtimeSummary: buildRuntimeSummary(runtime),
    memorySummary: buildMemorySummary(runtime),
    reminderSummary: buildReminderSummary(reminders, reminderScheduler),
    remindersCount: reminders.list().length,
    metrics: metrics.getAll(),
    limits: {
      maxHistory: DEFAULTS.maxHistory,
      maxContentLength: DEFAULTS.maxContentLength,
      maxIdLength: DEFAULTS.maxIdLength,
      maxTags: DEFAULTS.maxTags,
      responseHistory: DEFAULTS.responseHistoryLimit,
      responseSimilarity: DEFAULTS.responseSimilarity,
      responseMaxParts: DEFAULTS.responseMaxParts,
      selectiveMemoryCapacity: DEFAULTS.selectiveMemoryCapacity,
      selectiveMemoryExpirationMs: DEFAULTS.selectiveMemoryExpirationMs,
      selectiveMemoryReinforcementThreshold: DEFAULTS.selectiveMemoryReinforcementThreshold,
      groupPassiveSize: DEFAULTS.groupPassiveSize
    }
  });
});

const basePort = Number(DEFAULTS.port);
const maxPortRetries = 5;
const envPortIsExplicit = typeof process.env.TETOS_PORT === "string" && process.env.TETOS_PORT.trim() !== "";

function startServer(port, attempt = 0) {
  const server = app.listen(port, () => {
    console.log(`TetOS API running on http://localhost:${port}`);
  });

  server.on("error", (error) => {
    const conflict = error?.code === "EADDRINUSE";
    const canFallback = conflict && attempt < maxPortRetries;
    if (canFallback) {
      if (envPortIsExplicit && attempt === 0) {
        console.warn(
          `[api] configured port ${port} is busy (TETOS_PORT set). Falling back automatically.`
        );
      }
      console.warn(`[api] port ${port} in use, trying ${port + 1}...`);
      startServer(port + 1, attempt + 1);
      return;
    }
    console.error(`[api] failed to bind port ${port}: ${error?.message ?? "unknown error"}`);
    process.exit(1);
  });
}

startServer(basePort);
