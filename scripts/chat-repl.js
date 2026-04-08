import readline from "node:readline";
import { spawn } from "node:child_process";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const sessionId = `cli-${Date.now()}`;
let serverProc = null;
let apiBaseUrl = null;
const REPL_PORT = Number(process.env.TETOS_REPL_PORT ?? 3010);
const FALLBACK_PORTS = [3000, 3001, 3002, 3003, 3004, 3005];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingStatus(baseUrl, timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/status`, { signal: controller.signal });
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H15",location:"chat-repl.js:pingStatus",message:"status probe result",data:{baseUrl,ok:res.ok,status:res.status,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.ok;
  } catch {
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H15",location:"chat-repl.js:pingStatus",message:"status probe failed",data:{baseUrl,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startServer(env = process.env) {
  const safeEnv = Object.fromEntries(
    Object.entries(env).filter(([key, value]) => {
      if (!key || key.includes("=")) return false;
      return typeof value === "string";
    })
  );
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  serverProc = spawn(cmd, ["start"], {
    stdio: "inherit",
    shell: false,
    windowsHide: true,
    env: safeEnv
  });
  return serverProc;
}

async function ensureServer() {
  const preferred = `http://localhost:${REPL_PORT}`;
  if (await pingStatus(preferred)) {
    apiBaseUrl = preferred;
    return;
  }

  for (const port of FALLBACK_PORTS) {
    const candidate = `http://localhost:${port}`;
    if (candidate === preferred) continue;
    if (await pingStatus(candidate)) {
      apiBaseUrl = candidate;
      return;
    }
  }

  console.log("Servidor não está rodando. Iniciando `npm start`...");
  try {
    startServer({
      ...process.env,
      TETOS_PORT: String(REPL_PORT)
    });
  } catch (error) {
    throw new Error(`falha ao iniciar servidor local (${error.message})`);
  }
  for (let i = 0; i < 30; i++) {
    await wait(500);
    if (await pingStatus(preferred, 1200)) {
      apiBaseUrl = preferred;
      return;
    }
    for (const port of FALLBACK_PORTS) {
      const candidate = `http://localhost:${port}`;
      if (candidate === preferred) continue;
      if (await pingStatus(candidate, 1200)) {
        apiBaseUrl = candidate;
        return;
      }
    }
  }
  throw new Error(`Não consegui iniciar a API do chat-repl em http://localhost:${REPL_PORT}`);
}

async function send(message) {
  await ensureServer();
  // #region agent log
  fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H15",location:"chat-repl.js:send",message:"sending chat request",data:{apiBaseUrl,messagePreview:String(message).slice(0,120),sessionId,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
  // #endregion
  const response = await fetch(`${apiBaseUrl}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, sessionId, userId: "local" })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  const data = await response.json();
  return Array.isArray(data.replies) ? data.replies : [data.reply ?? ""];
}

function prompt() {
  rl.question("Você: ", async (text) => {
    if (text.trim().toLowerCase() === "/sair") {
      if (serverProc) {
        serverProc.kill();
        serverProc = null;
      }
      rl.close();
      return;
    }

    try {
      const replies = await send(text);
      for (const reply of replies) {
        const delay = 300 + Math.floor(Math.random() * 900);
        await wait(delay);
        console.log(`Teto: ${reply}`);
      }
    } catch (error) {
      console.error("Erro:", error.message);
    }

    prompt();
  });
}

console.log("Chat iniciado. Digite /sair para encerrar.");
prompt();
