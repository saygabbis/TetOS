import { DEFAULTS } from "../infra/config/defaults.js";
import { ShortTermMemory } from "../core/memory/shortTerm.js";
import { LongTermMemory } from "../core/memory/longTerm.js";
import { ContextBuilder } from "../core/memory/contextBuilder.js";
import { extractFacts, extractStyle, isMeaningful } from "../core/memory/extractor.js";
import { detectTone } from "../core/memory/toneDetector.js";
import { OllamaClient } from "../core/brain/ollamaClient.js";
import { Agent } from "../core/agent/agent.js";
import { ChatService } from "../modules/chat/chatService.js";
import { ResponseProcessor } from "../modules/chat/responseProcessor.js";
import { BasicLoop } from "../modules/scheduler/basicLoop.js";
import { loadPersonality } from "../core/personality/index.js";

export function createRuntime() {
  if (DEFAULTS.ollamaMode === "cloud" && !DEFAULTS.ollamaApiKey) {
    throw new Error(
      "TETOS_OLLAMA_MODE=cloud requer TETOS_OLLAMA_API_KEY (ou OLLAMA_API_KEY). Crie uma chave em https://ollama.com/settings/keys"
    );
  }

  const shortTerm = new ShortTermMemory(DEFAULTS.maxShortTerm);
  const longTerm = new LongTermMemory(DEFAULTS.memoryPath);
  const contextBuilder = new ContextBuilder(longTerm);
  const brain = new OllamaClient({
    baseUrl: DEFAULTS.ollamaBaseUrl,
    model: DEFAULTS.model,
    apiKey: DEFAULTS.ollamaApiKey || undefined
  });
  const personality = loadPersonality(DEFAULTS.personalityPath);
  const agent = new Agent({
    personality,
    shortTerm,
    longTerm,
    brain,
    contextBuilder
  });
  const responseProcessor = new ResponseProcessor({
    maxParts: DEFAULTS.responseMaxParts,
    similarityThreshold: DEFAULTS.responseSimilarity,
    historyLimit: DEFAULTS.responseHistoryLimit
  });
  const basicLoop = new BasicLoop({
    inactiveMs: DEFAULTS.presenceInactiveMs,
    minCooldownMs: DEFAULTS.presenceMinCooldownMs,
    maxCooldownMs: DEFAULTS.presenceMaxCooldownMs,
    maxDailyPerUser: DEFAULTS.presenceMaxDailyPerUser
  });
  const chatService = new ChatService(agent, responseProcessor);

  return {
    shortTerm,
    longTerm,
    contextBuilder,
    brain,
    agent,
    responseProcessor,
    basicLoop,
    chatService
  };
}

export async function handleIncomingMessage(runtime, payload = {}) {
  const { message, messages, userId, sessionId } = payload;
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

  const input = clampContent(
    message ?? normalizedHistory?.[normalizedHistory.length - 1]?.content
  );

  if (!input) {
    const error = new Error("message is required");
    error.statusCode = 400;
    throw error;
  }

  const tone = detectTone(input);
  const existingProfile = runtime.longTerm.getProfile(safeUserId ?? "default");
  const style = extractStyle(input);
  const repeatedChars = (input.match(/([aeiou])\1{1,}/gi) ?? []).length;
  const burstMessages = input.split("\n").filter(Boolean).length;
  const styleHint = {
    ...(existingProfile?.style ?? {}),
    userIsShort: style.isShort,
    userIsLong: style.isLong,
    repeatedVowels: repeatedChars,
    userGreetingIntensity: /^(oi+|oie+|eae+|hey+)/i.test(input.trim()) ? repeatedChars : 0,
    userBurst: burstMessages > 1
  };

  const replies = await runtime.chatService.handleMessage(
    input,
    { userId: safeUserId, sessionId: safeSessionId, styleHint },
    normalizedHistory,
    tone
  );

  runtime.basicLoop.touch(safeUserId ?? "default");

  const facts = extractFacts(input);
  for (const fact of facts) {
    runtime.longTerm.save({
      tags: [fact.type],
      type: fact.type,
      value: fact.value,
      userId: safeUserId ?? "default"
    });
  }

  const profile = existingProfile;
  const counts = profile.counts ?? {};
  const nextCounts = {
    abbrev: (counts.abbrev ?? 0) + (style.usesAbbrev ? 1 : 0),
    laughter: (counts.laughter ?? 0) + (style.usesLaughter ? 1 : 0),
    emoji: (counts.emoji ?? 0) + (style.usesEmojis ? 1 : 0)
  };
  const total = Math.max(1, (counts.total ?? 0) + 1);
  const nextStyle = {
    prefersAbbrev: nextCounts.abbrev / total > 0.4,
    prefersLaughter: nextCounts.laughter / total > 0.4,
    prefersEmoji: nextCounts.emoji / total > 0.3,
    brevity: style.isShort ? "short" : style.isLong ? "long" : "medium"
  };

  runtime.longTerm.updateProfile(safeUserId ?? "default", {
    facts: {
      ...(facts.find((f) => f.type === "user_name")
        ? { name: facts.find((f) => f.type === "user_name").value }
        : {})
    },
    style: nextStyle,
    counts: { ...nextCounts, total }
  });

  if (isMeaningful(input)) {
    runtime.longTerm.addMediumTerm(safeUserId ?? "default", {
      summary: input,
      timestamp: new Date().toISOString()
    });
    runtime.longTerm.pruneMediumTerm(safeUserId ?? "default", 20);
  }

  return {
    replies,
    userId: safeUserId ?? "default",
    sessionId: safeSessionId ?? "default",
    input
  };
}
