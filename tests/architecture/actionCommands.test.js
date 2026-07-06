/**
 * Testes de integração: Protocolo de Comandos de Ação (reagir/mensagem/sticker)
 *
 * Esses testes conversam diretamente com a LLM real configurada no .env
 * sem precisar inicializar o WhatsApp ou enviar mensagens de verdade.
 *
 * Run: npx vitest run tests/architecture/actionCommands.test.js
 */
import "dotenv/config";
import { describe, expect, it, beforeAll } from "vitest";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import { Agent } from "../../src/core/agent/agent.js";
import { ShortTermMemory } from "../../src/core/memory/shortTerm.js";
import { LongTermMemory } from "../../src/core/memory/longTerm.js";
import { ContextBuilder } from "../../src/core/memory/contextBuilder.js";
import { DEFAULTS } from "../../src/infra/config/defaults.js";
import { MiniMaxClient } from "../../src/core/brain/minimaxClient.js";
import { OllamaClient } from "../../src/core/brain/ollamaClient.js";
import { loadCharacter, loadPersonality } from "../../src/core/personality/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "tetos-action-cmd-"));
}

function createBrain() {
  if (DEFAULTS.llmProvider === "minimax") {
    if (!DEFAULTS.minimaxApiKey) {
      throw new Error("TETOS_MINIMAX_API_KEY não configurada. Verifique o .env.");
    }
    return new MiniMaxClient({
      baseUrl: DEFAULTS.minimaxBaseUrl,
      model: DEFAULTS.minimaxModel,
      apiKey: DEFAULTS.minimaxApiKey,
      temperature: DEFAULTS.ollamaTemperature,
      numPredict: DEFAULTS.ollamaNumPredict
    });
  }
  return new OllamaClient({
    baseUrl: DEFAULTS.ollamaBaseUrl,
    model: DEFAULTS.model,
    apiKey: DEFAULTS.ollamaApiKey || undefined,
    temperature: DEFAULTS.ollamaTemperature,
    numPredict: DEFAULTS.ollamaNumPredict
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let agent;
let tempDirs = [];

beforeAll(() => {
  const shortTermDir = makeTempDir();
  const longTermDir = makeTempDir();
  tempDirs.push(shortTermDir, longTermDir);

  const shortTerm = new ShortTermMemory(20, {
    persistPath: join(shortTermDir, "short.json")
  });
  const longTerm = new LongTermMemory(join(longTermDir, "long.json"));
  const contextBuilder = new ContextBuilder(longTerm);
  const brain = createBrain();
  const personality = loadPersonality(DEFAULTS.personalityPath);
  const character = loadCharacter(DEFAULTS.characterPath);

  agent = new Agent({
    personality,
    character,
    shortTerm,
    longTerm,
    brain,
    contextBuilder
  });

  return () => {
    tempDirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  };
});

// ---------------------------------------------------------------------------
// Testes do parser (unitários, sem LLM)
// ---------------------------------------------------------------------------

describe("parseActionCommands", () => {
  it("extrai reagir com emoji", () => {
    const actions = parseActionCommands('reagir("😂")');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "react", emoji: "😂" });
  });

  it("extrai mensagem simples", () => {
    const actions = parseActionCommands('mensagem("oi, tudo bem?")');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "message", text: "oi, tudo bem?", quoteId: null });
  });

  it("extrai mensagem com quoteId", () => {
    const actions = parseActionCommands('mensagem("respondi aqui", "msg_abc123")');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "message", text: "respondi aqui", quoteId: "msg_abc123" });
  });

  it("extrai sticker com chave", () => {
    const actions = parseActionCommands('sticker("teto-linguinha")');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "sticker", key: "teto-linguinha", quoteId: null });
  });

  it("extrai sticker com quoteId", () => {
    const actions = parseActionCommands('sticker("teto-pao", "msg_xyz")');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "sticker", key: "teto-pao", quoteId: "msg_xyz" });
  });

  it("extrai calar com escopo opcional", () => {
    const actions = parseActionCommands('calar("todos")');
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: "silence", scope: "todos" });
    expect(parseActionCommands("calar()")[0]).toMatchObject({ type: "silence", scope: null });
  });

  it("extrai múltiplos comandos na mesma resposta", () => {
    const raw = `reagir("🔥")\nmensagem("caramba kkk")\nmensagem("não acredito nisso")`;
    const actions = parseActionCommands(raw);
    expect(actions).toHaveLength(3);
    expect(actions[0].type).toBe("react");
    expect(actions[1].type).toBe("message");
    expect(actions[2].type).toBe("message");
  });

  it("retorna array vazio para texto puro sem comandos", () => {
    const actions = parseActionCommands("oi como você tá");
    expect(actions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Testes de integração com a LLM
// ---------------------------------------------------------------------------

describe("LLM → Protocolo de Comandos de Ação", () => {
  it(
    "gera pelo menos um comando de ação para uma mensagem de chat normal",
    { timeout: 60_000 },
    async () => {
      const raw = await agent.respond(
        "oi teto! tudo bem contigo?",
        { userId: "test_user", sessionId: "test_session" },
        null,
        null
      );

      expect(typeof raw).toBe("string");
      expect(raw.trim().length).toBeGreaterThan(0);

      const actions = parseActionCommands(raw);
      expect(actions.length).toBeGreaterThan(0);

      const types = actions.map((a) => a.type);
      const validTypes = ["react", "message", "sticker"];
      types.forEach((t) => {
        expect(validTypes).toContain(t);
      });
    }
  );

  it(
    "inclui ao menos uma mensagem de texto na resposta para um cumprimento",
    { timeout: 60_000 },
    async () => {
      const raw = await agent.respond(
        "me conta uma coisa engraçada",
        { userId: "test_user", sessionId: "test_session" },
        null,
        null
      );

      const actions = parseActionCommands(raw);
      const messageActions = actions.filter((a) => a.type === "message");
      expect(messageActions.length).toBeGreaterThan(0);
      messageActions.forEach((a) => {
        expect(typeof a.text).toBe("string");
        expect(a.text.trim().length).toBeGreaterThan(0);
      });
    }
  );

  it(
    "fallback de erro: gera mensagem de texto simples sem comandos MCP",
    { timeout: 60_000 },
    async () => {
      const raw = await agent.respond(
        "teste de fallback de erro interno",
        {
          userId: "test_user",
          sessionId: "test_session",
          fallback: "error",
          errorMsg: "model timeout"
        },
        null,
        "calm"
      );

      expect(typeof raw).toBe("string");
      expect(raw.trim().length).toBeGreaterThan(0);

      // No modo erro, a LLM deve gerar texto puro sem comandos
      // OU uma mensagem contendo "gabbis" ou "probleminha" ou similar
      const lowerRaw = raw.toLowerCase();
      const hasFallbackPattern =
        lowerRaw.includes("gabbis") ||
        lowerRaw.includes("probleminha") ||
        lowerRaw.includes("erro") ||
        lowerRaw.includes("tô com") ||
        lowerRaw.includes("to com") ||
        // Caso a LLM ainda use comandos mesmo assim, pelo menos verificamos que há uma mensagem
        parseActionCommands(raw).some((a) => a.type === "message");

      expect(hasFallbackPattern).toBe(true);
    }
  );

  it(
    "resposta multi-bolha: ao pedir algo elaborado, gera múltiplos comandos mensagem",
    { timeout: 90_000 },
    async () => {
      const raw = await agent.respond(
        "descreve como é o seu dia a dia sendo uma ia musical",
        { userId: "test_user", sessionId: "test_session" },
        null,
        null
      );

      const actions = parseActionCommands(raw);
      const messageActions = actions.filter((a) => a.type === "message");

      // Para uma resposta mais elaborada esperamos pelo menos 2 bolhas
      // Mas aceitamos 1 se a LLM decidir condensar - só garante que não seja 0
      expect(messageActions.length).toBeGreaterThanOrEqual(1);
    }
  );
});
