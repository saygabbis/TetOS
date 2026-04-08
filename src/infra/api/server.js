import "dotenv/config";
import express from "express";
import { DEFAULTS } from "../config/defaults.js";
import { autoTag } from "../../core/memory/tagger.js";
import { createRuntime, handleIncomingMessage } from "../../app/createRuntime.js";

const app = express();
app.use(express.json());

const runtime = createRuntime();
const { longTerm, shortTerm, basicLoop } = runtime;

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
  return res.json({ entries: longTerm.all(), profiles: longTerm.data?.profiles, mediumTerm: longTerm.data?.mediumTerm });
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

app.post("/nudge", (req, res) => {
  const { userId } = req.body ?? {};
  const targetUser = typeof userId === "string" ? userId : "default";
  const payload = basicLoop.maybeNudge(targetUser, { hasRecentMemory: true });
  return res.json({ message: payload?.text ?? null, reason: payload?.reason ?? null });
});

app.post("/session/clear", (req, res) => {
  const { sessionId } = req.body ?? {};
  const sessionKey = sessionId ?? "default";
  shortTerm.clear(sessionKey);
  return res.json({ status: "ok" });
});

app.get("/status", (req, res) => {
  const { sessionId } = req.query;
  return res.json({
    status: "ok",
    model: DEFAULTS.model,
    personalityPath: DEFAULTS.personalityPath,
    memoryCount: longTerm.all().length,
    shortTermCount: shortTerm.getAll(sessionId ?? "default").length,
    limits: {
      maxHistory: DEFAULTS.maxHistory,
      maxContentLength: DEFAULTS.maxContentLength,
      maxIdLength: DEFAULTS.maxIdLength,
      maxTags: DEFAULTS.maxTags,
      responseHistory: DEFAULTS.responseHistoryLimit,
      responseSimilarity: DEFAULTS.responseSimilarity,
      responseMaxParts: DEFAULTS.responseMaxParts
    }
  });
});

const port = DEFAULTS.port;
app.listen(port, () => {
  console.log(`TetOS API running on http://localhost:${port}`);
});
