import readline from "node:readline";
import { spawn } from "node:child_process";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const sessionId = `cli-${Date.now()}`;
let serverProc = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pingStatus(timeoutMs = 800) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("http://localhost:3000/status", { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function startServer() {
  const cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  serverProc = spawn(cmd, ["start"], {
    stdio: "inherit",
    shell: false,
    windowsHide: true
  });
  return serverProc;
}

async function ensureServer() {
  if (await pingStatus()) return;
  console.log("Servidor não está rodando. Iniciando `npm start`...");
  startServer();
  for (let i = 0; i < 30; i++) {
    await wait(500);
    if (await pingStatus(1200)) return;
  }
  throw new Error("Não consegui iniciar a API em http://localhost:3000");
}

async function send(message) {
  await ensureServer();
  const response = await fetch("http://localhost:3000/chat", {
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
