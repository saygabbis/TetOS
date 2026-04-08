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
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H14",location:"server.js:/chat:entry",message:"chat request received",data:{pid:process.pid,port:basePort,messagePreview:String(req.body?.message??"").slice(0,120),sessionId:req.body?.sessionId??null,userId:req.body?.userId??null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const { replies } = await handleIncomingMessage(runtime, req.body ?? {});
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H14",location:"server.js:/chat:exit",message:"chat response ready",data:{pid:process.pid,repliesCount:Array.isArray(replies)?replies.length:0,repliesPreview:Array.isArray(replies)?replies.map((r)=>String(r).slice(0,100)):[]},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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

const basePort = Number(DEFAULTS.port);
const maxPortRetries = 5;
const envPortIsExplicit = typeof process.env.TETOS_PORT === "string" && process.env.TETOS_PORT.trim() !== "";

function startServer(port, attempt = 0) {
  // #region agent log
  fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"post-fix",hypothesisId:"H6",location:"server.js:startServer:attempt",message:"about to listen",data:{port,attempt,pid:process.pid,envPort:process.env.TETOS_PORT??null,envPortIsExplicit},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const server = app.listen(port, () => {
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"post-fix",hypothesisId:"H6",location:"server.js:startServer:success",message:"listen success",data:{port,attempt,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    console.log(`TetOS API running on http://localhost:${port}`);
  });

  server.on("error", (error) => {
    const conflict = error?.code === "EADDRINUSE";
    const canFallback = conflict && attempt < maxPortRetries;
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"post-fix",hypothesisId:"H6",location:"server.js:startServer:error",message:"listen error",data:{code:error?.code??null,errno:error?.errno??null,address:error?.address??null,port:error?.port??port,attempt,canFallback,envPortIsExplicit,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // #region agent log
    console.error(
      `[api-debug] conflict=${conflict} canFallback=${canFallback} envPortIsExplicit=${envPortIsExplicit} envPort=${process.env.TETOS_PORT ?? "null"} attempt=${attempt} nextPort=${port + 1}`
    );
    // #endregion
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
