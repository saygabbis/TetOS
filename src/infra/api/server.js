import "dotenv/config";
import express from "express";
import { DEFAULTS } from "../config/defaults.js";
import { ShortTermMemory } from "../../core/memory/shortTerm.js";
import { LongTermMemory } from "../../core/memory/longTerm.js";
import { ContextBuilder } from "../../core/memory/contextBuilder.js";
import { autoTag } from "../../core/memory/tagger.js";
import { OllamaClient } from "../../core/brain/ollamaClient.js";
import { Agent } from "../../core/agent/agent.js";
import { ChatService } from "../../modules/chat/chatService.js";
import { loadPersonality } from "../../core/personality/index.js";

const app = express();
app.use(express.json());

const shortTerm = new ShortTermMemory(DEFAULTS.maxShortTerm);
const longTerm = new LongTermMemory(DEFAULTS.memoryPath);
const contextBuilder = new ContextBuilder(longTerm);
const brain = new OllamaClient({
  baseUrl: DEFAULTS.ollamaBaseUrl,
  model: DEFAULTS.model
});
const personality = loadPersonality(DEFAULTS.personalityPath);
const agent = new Agent({
  personality,
  shortTerm,
  longTerm,
  brain,
  contextBuilder
});
const chatService = new ChatService(agent);

app.post("/chat", async (req, res) => {
  const { message, messages, userId, sessionId } = req.body ?? {};
  const allowedRoles = new Set(["user", "assistant", "system"]);
  const safeUserId =
    typeof userId === "string"
      ? userId.slice(0, DEFAULTS.maxIdLength)
      : userId;
  const safeSessionId =
    typeof sessionId === "string"
      ? sessionId.slice(0, DEFAULTS.maxIdLength)
      : sessionId;
  const clampContent = (value) =>
    typeof value === "string"
      ? value.slice(0, DEFAULTS.maxContentLength)
      : value;

  const normalizedHistory = Array.isArray(messages)
    ? messages
        .filter((msg) => typeof msg?.content === "string")
        .map((msg) => ({
          ...msg,
          content: msg.content.trim()
        }))
        .filter((msg) => msg.content)
        .slice(-DEFAULTS.maxHistory)
        .map((msg) => {
          const role = allowedRoles.has(msg?.role) ? msg.role : "user";
          return {
            role,
            content: clampContent(msg.content),
            meta: { userId: safeUserId, sessionId: safeSessionId }
          };
        })
    : null;

  const input =
    clampContent(
      message ?? normalizedHistory?.[normalizedHistory.length - 1]?.content
    );

  if (!input) {
    return res.status(400).json({ error: "message is required" });
  }

  try {
    const reply = await chatService.handleMessage(
      input,
      { userId: safeUserId, sessionId: safeSessionId },
      normalizedHistory
    );
    return res.json({ reply });
  } catch (error) {
    return res.status(500).json({ error: error.message });
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
  return res.json({ entries: longTerm.all() });
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
      maxTags: DEFAULTS.maxTags
    }
  });
});

const port = DEFAULTS.port;
app.listen(port, () => {
  console.log(`TetOS API running on http://localhost:${port}`);
});
