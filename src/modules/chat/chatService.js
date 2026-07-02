import { Agent } from "../../core/agent/agent.js";
import {
  hasCoherenceIssues,
  isContextBlindReply,
  repairBubbleCoherence
} from "./coherenceGuards.js";
import { slimMetaForStorage } from "../../core/memory/slimMeta.js";
import { detectTetoNameCall } from "../../integrations/whatsapp/tetoNameDetect.js";
import { detectUserBoundary } from "../../core/channels/userBoundaryDetect.js";
import {
  AGENT_MEDIA_COMMANDS,
  AGENT_MEDIA_COMMAND_PATTERN,
  SAVE_STICKER_COMMAND_PATTERN,
  REPERTOIRE_MODE_COMMAND_PATTERN,
  buildMediaAction,
  isPresetStickerKey,
  isRepertoireModeCommand,
  isSaveStickerCommand,
  normalizeAgentMediaCommand,
  parseRepertoireModeEnabled
} from "../../integrations/whatsapp/agentMediaCommands.js";

export function normalizeActionCommandText(rawText = "") {
  return String(rawText ?? "")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
    .replace(/^```[\w]*\n?|\n?```$/g, "")
    .trim();
}

export function parseActionCommands(rawText) {
  const actions = [];
  const text = normalizeActionCommandText(rawText);
  
  // Captura comandos como reagir("❤️"), mensagem("Oi!", "msg_123"), sticker("chave")
  const commandRegex = /([a-zA-Z]+)\s*\(([\s\S]*?)\)/g;
  let match;
  while ((match = commandRegex.exec(text)) !== null) {
    const cmd = match[1].toLowerCase();
    const argsRaw = match[2];
    
    // Captura strings entre aspas
    const argRegex = /["']([\s\S]*?)["']/g;
    const args = [];
    let argMatch;
    while ((argMatch = argRegex.exec(argsRaw)) !== null) {
      args.push(argMatch[1]);
    }
    
    if (cmd === "reagir" || cmd === "react") {
      if (args[0]) {
        actions.push({ type: "react", emoji: args[0] });
      }
    } else if (cmd === "sticker" || cmd === "figurinha") {
      if (!args[0]) continue;
      if (isPresetStickerKey(args[0])) {
        actions.push({ type: "sticker", key: args[0], quoteId: args[1] || null });
      } else {
        const mediaAction = buildMediaAction("sticker", args[0], args.slice(1));
        if (mediaAction) actions.push(mediaAction);
      }
    } else if (cmd === "mensagem" || cmd === "message" || cmd === "responder" || cmd === "reply" || cmd === "quote") {
      if (args[0]) {
        actions.push({ type: "message", text: args[0], quoteId: args[1] || null });
      }
    } else if (isSaveStickerCommand(cmd)) {
      if (args[0]) {
        actions.push({
          type: "save_sticker",
          messageId: args[0],
          key: args[1] || null,
          label: args[2] || null
        });
      }
    } else if (cmd === "ativarrepertorio" || cmd === "ligarrepertorio") {
      actions.push({ type: "repertoire_mode", enabled: true });
    } else if (cmd === "desativarrepertorio" || cmd === "desligarrepertorio") {
      actions.push({ type: "repertoire_mode", enabled: false });
    } else if (isRepertoireModeCommand(cmd)) {
      actions.push({ type: "repertoire_mode", enabled: parseRepertoireModeEnabled(args) });
    } else {
      const mediaCmd = normalizeAgentMediaCommand(cmd);
      if (AGENT_MEDIA_COMMANDS.includes(mediaCmd) && mediaCmd !== "sticker" && args[0]) {
        const mediaAction = buildMediaAction(mediaCmd, args[0], args.slice(1));
        if (mediaAction) actions.push(mediaAction);
      } else if (cmd === "toimage" || cmd === "toimg" || cmd === "toimagem") {
        if (args[0]) {
          actions.push(buildMediaAction("toimg", args[0]) ?? { type: "toimage", messageId: args[0] });
        }
      }
    }
  }
  return actions;
}

function returnWithActions(actions) {
  const resolved = resolveOutgoingActions(actions);
  const texts = resolved
    .filter((a) => a.type === "message")
    .map((a) => a.text)
    .filter(Boolean);
  const out = texts.length ? texts : [];
  out.actions = resolved;
  return out;
}

/** Expande ações cujo text ainda contém comando cru (fallback do processor). */
export function resolveOutgoingActions(actions = []) {
  const out = [];
  for (const action of actions) {
    const raw = String(action?.text ?? "").trim();
    const looksLikeCommand =
      action?.type === "message" &&
      /^(mensagem|message|reagir|react|sticker|figurinha|responder|reply|quote|${AGENT_MEDIA_COMMAND_PATTERN}|${SAVE_STICKER_COMMAND_PATTERN}|${REPERTOIRE_MODE_COMMAND_PATTERN})\s*\(/i.test(
        raw
      );
    if (!looksLikeCommand) {
      out.push(action);
      continue;
    }
    const reparsed = parseActionCommands(raw);
    if (reparsed.length > 0) {
      out.push(...reparsed);
    } else {
      out.push(action);
    }
  }
  return out;
}

function normActionMessageId(id) {
  return String(id ?? "")
    .trim()
    .replace(/^\[?ID:\s*/i, "")
    .replace(/\]$/, "")
    .trim();
}

/** Evita reply na msg que acabou de chegar, excesso de reagir e prioriza stickers. */
export function sanitizeOutgoingActions(actions = [], meta = {}) {
  if (!Array.isArray(actions) || !actions.length) return actions;

  const triggerId = normActionMessageId(meta?.messageKey?.id ?? meta?.messageId ?? null);
  const recentIds = new Set(
    (meta?.recentHistory ?? [])
      .slice(-4)
      .map((m) => normActionMessageId(m?.messageId ?? m?.meta?.messageId))
      .filter(Boolean)
  );
  if (triggerId) recentIds.add(triggerId);

  let out = actions.map((action) => {
    if ((action.type !== "message" && action.type !== "sticker") || !action.quoteId) return action;
    const qid = normActionMessageId(action.quoteId);
    if (!qid) return { ...action, quoteId: null };
    if (recentIds.has(qid)) return { ...action, quoteId: null };
    return action;
  });

  const hasSubstantive = out.some(
    (a) =>
      a.type === "message" ||
      a.type === "sticker" ||
      a.type === "media" ||
      a.type === "toimage" ||
      a.type === "save_sticker" ||
      a.type === "repertoire_mode"
  );
  const hasExplicitReactOnly = out.some((a) => a.type === "react") && !hasSubstantive;
  if (hasSubstantive && !hasExplicitReactOnly) {
    out = out.filter((a) => a.type !== "react");
  }

  return out;
}

export class ChatService {
  constructor(agent, responseProcessor, internalState, { shortTerm = null } = {}) {
    this.agent = agent;
    this.responseProcessor = responseProcessor;
    this.internalState = internalState;
    this.shortTerm = shortTerm;
  }

  getProcessor(meta = {}) {
    const sessionId = meta?.sessionId ?? "default";
    if (this.responseProcessor?.forSession) {
      return this.responseProcessor.forSession(sessionId);
    }
    return this.responseProcessor;
  }

  recordUserTurn(message, meta = {}) {
    const sessionId = meta?.sessionId ?? "default";
    if (this.shortTerm?.add) {
      this.shortTerm.add(
        { role: "user", content: String(message ?? ""), meta: slimMetaForStorage(meta) },
        sessionId
      );
    }
  }

  static normalizeLoose(text) {
    return String(text ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9?\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static isNameQuestion(text) {
    const t = ChatService.normalizeLoose(text);
    if (!t) return false;
    return (
      /\bqual (é|e) (o )?seu nome\b/.test(t) ||
      /\bqual seu nome\b/.test(t) ||
      /\bseu nome\??\b/.test(t) ||
      /\bcomo (você|vc) (se chama|chama)\b/.test(t)
    );
  }

  static isWhoAreYouQuestion(text) {
    const t = ChatService.normalizeLoose(text);
    const hasQuem = t.includes("quem");
    const hasVoc = t.includes("voc") || /\bvc\b/.test(t);
    return hasQuem && hasVoc;
  }

  static extractGroupMention(text) {
    const t = String(text ?? "").toLowerCase();
    if (!t) return null;
    if (detectTetoNameCall(text).detected) return "name";
    if (/@\d{4,}/.test(t)) return "mention";
    return null;
  }

  static normalizeForEcho(text = "") {
    return String(text ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  static isUnjustifiedThanks(userMessage, assistantText) {
    const a = String(assistantText ?? "").toLowerCase();
    if (!/\bobrigad/.test(a)) return false;
    const u = String(userMessage ?? "").toLowerCase();
    if (/\b(obrigad|valeu|vlw|brigad|parab[eé]ns|mandou bem|me ajudou|ajudou|presente)\b/.test(u)) {
      return false;
    }
    if (/\b(amo|amei|linda|lindo|incr[ií]vel|perfeita|perfeito|maravilh|gostei)\b/.test(u)) return false;
    if (/\b(fala direito|falando torto|nao parece|não parece|parece (a )?teto)\b/.test(u)) return true;
    return true;
  }

  static deEcho(userMessage, assistantText) {
    const u = ChatService.normalizeForEcho(userMessage);
    const a = ChatService.normalizeForEcho(assistantText);
    if (!u || !a) return { text: assistantText, needsRegen: false };

    if (ChatService.isUnjustifiedThanks(userMessage, assistantText)) {
      return { text: assistantText, needsRegen: true };
    }

    const mirrorPatterns = [
      /(nao entende|nao entendi|entender direito)/,
      /(falando tudo torto|fala direito|falar direito|falando torto)/,
      /(nao parece a teto|nao parece teto|parece a teto)/,
      /\b(respondi tudo|eu respondi|ja falei tudo|falei tudo|eu falei)\b.*\b(falou demais|faltando|incomplet|ficou faltando)\b/
    ];
    for (const pattern of mirrorPatterns) {
      if (pattern.test(u) && pattern.test(a)) {
        return { text: assistantText, needsRegen: true };
      }
    }

    const uWords = u.split(" ").filter((w) => w.length > 2);
    if (uWords.length >= 3) {
      const chunk = uWords.slice(0, Math.min(6, uWords.length)).join(" ");
      if (chunk.length >= 10 && a.includes(chunk)) {
        return { text: assistantText, needsRegen: true };
      }
      const overlap = uWords.filter((w) => a.includes(w));
      if (overlap.length >= Math.max(3, Math.ceil(uWords.length * 0.6))) {
        return { text: assistantText, needsRegen: true };
      }
    }

    if (u.length > 12 && a.includes(u.slice(0, Math.min(28, u.length)))) {
      return { text: assistantText, needsRegen: true };
    }
    return { text: assistantText, needsRegen: false };
  }

  static containsLoveDeclaration(text) {
    const t = String(text ?? "").toLowerCase();
    return /\b(eu\s+)?te\s+amo\b/.test(t);
  }

  static isPositiveWellbeingReply(text) {
    let t = ChatService.normalizeLoose(text);
    t = t.replace(/^(k{2,}\s*)+/i, "").trim();
    t = t.replace(/\s+k{2,}\s*$/i, "").trim();
    if (!t) return false;
    if (/^(tudo|td|to bem|tô bem|estou bem|bem|de boa|tranquilo|tranquila|suave)$/.test(t)) {
      return true;
    }
    if (/^tud+o+$/.test(t)) return true;
    if (/^td+o+$/.test(t)) return true;
    if (/^to+ bem$/.test(t)) return true;
    if (/^t[oô]+ b[oô]+m$/.test(t)) return true;
    return false;
  }

  /** Papo encerrando: 👍, "de boa", kkk+blz — não pede resposta longa. */
  static isConversationLull(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return false;
    if (ChatService.isEmojiOnlyMessage(raw)) return true;
    if (ChatService.isPositiveWellbeingReply(raw)) return true;
    if (ChatService.isShortAcknowledgement(raw)) return true;

    let t = ChatService.normalizeLoose(raw);
    t = t.replace(/^(k{2,}\s*)+/i, "").trim();
    t = t.replace(/\s+k{2,}\s*$/i, "").trim();
    if (/^(de boa|suave|fechou|blz|beleza|show|a[ií] sim|isso|exato|combinado|fechado)$/.test(t)) {
      return true;
    }
    if (/^k{2,}$/.test(t.replace(/\s/g, ""))) return true;
    return false;
  }

  static isConversationIntent(text) {
    const t = ChatService.normalizeLoose(text);
    return /\b(so queria conversar|só queria conversar|quero conversar|to afim de conversar|vamos conversar)\b/.test(t);
  }

  static isConfusionSignal(text) {
    const t = ChatService.normalizeLoose(text);
    if (/^(que|q|quê)\??$/.test(t)) return true;
    return /\b(ta se perdendo|tá se perdendo|sem sentido|nao entendeu|não entendeu|viajou|nada a ver)\b/.test(t);
  }

  static isPingMessage(text) {
    const t = ChatService.normalizeLoose(text);
    return /^(alou|alo|alou\?|alo\?)$/.test(t);
  }

  /** Usuário chamou a Teto diretamente — nunca pode virar [SEM_RESPOSTA] ou silêncio. */
  static isDirectTetoCall(text) {
    const t = String(text ?? "").trim();
    if (!t) return false;
    if (detectUserBoundary(t).level === "hard") return false;
    if (detectTetoNameCall(t).detected) return true;
    return /\b(oi+|oie+|eae+|hey+|fala|e\s*a[ií])\b/i.test(t) && /\btet[o0]/i.test(t);
  }

  /** Só emoji / símbolo (sem palavras) — ex.: ❤️, 😂, combinações curtas. */
  static isEmojiOnlyMessage(text) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length > 64) return false;
    const letters = raw.replace(/[^\p{L}]/gu, "");
    if (letters.length > 0) return false;
    return /[\u203C-\u3299\uFE0F\u200D]|[\u{1F300}-\u{1FAFF}]|[\u2600-\u27BF]/u.test(raw);
  }

  static contextualFallbackForEmpty(userMessage) {
    const t = String(userMessage ?? "").trim();
    if (ChatService.isEmojiOnlyMessage(t)) {
      return { strategy: "emoji", hint: t };
    }
    return { strategy: "clarify", hint: t };
  }

  /**
   * Fallback terciário (depois do modelo): despedida isolada por palavra-chave.
   * O foco continua sendo [SEM_RESPOSTA] + contexto; isto só age se o modelo ainda gerou texto.
   */
  static isConversationClosure(text) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length > 160) return false;
    const t = ChatService.normalizeLoose(text);

    if (/\b(pode deixar de|nao deixa|não deixa|deixa de)\b/.test(t)) return false;

    if (/^(falou+|flw+|vlw+)(\b|\s)/i.test(t)) return true;
    if (/^(tchau+|xau+)(\b|\s)/i.test(t)) return true;

    if (/^pode deixar\b/.test(t)) return true;
    if (/^deixa\s+(quieto|pra la|pralá|comigo|assim)\b/.test(t)) return true;
    if (/^(valeu|vlw)\s+(amiga|amigo|viu|mesmo|aí|ai)\b/.test(t)) return true;
    if (/^até\s+(logo|mais|amanha|amanhã)\b/.test(t)) return true;
    if (/^tchau\b/.test(t)) return true;
    if (/\b(tchau|xau|flw|falou)\s+(tchau|xau|flw|falou)\b/i.test(t)) return true;
    if (/\b(tchau|xau|flw|falou|até mais|ate mais)\b/i.test(t) && /\b(vou|to|tô)\s+(sair|dormir|embora)\b/i.test(t)) {
      return true;
    }
    if (/\b(vou|to|tô)\s+sair\b/i.test(t) && /\b(tchau|xau|flw|falou)\b/i.test(t)) return true;
    if (/^beleza[, ]+então\b/.test(t)) return true;
    if (/^por hoje (é|e) isso\b/.test(t)) return true;
    if (/^resolvido\b/.test(t)) return true;
    if (/^ta\s+tranquilo\b|^tá\s+tranquilo\b/.test(t) && t.length < 40) return true;
    return false;
  }

  static isShortAcknowledgement(text) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length > 24) return false;
    const t = ChatService.normalizeLoose(raw);
    return /^(ok+|okey+|okay+|blz+|beleza+|suave+|fechou+|vlw+|valeu+|flw+|falou+|xau+|tchau+|ate+|até+)$/.test(t);
  }

  static isLikelyQuestion(text) {
    const raw = String(text ?? "").trim();
    if (!raw) return false;
    if (raw.endsWith("?")) return true;
    const t = ChatService.normalizeLoose(raw);
    return /^(o que|oq|quem|quando|onde|por que|porque|pq|qual|como|cadê|cade|vc|você|cê|ce|vai|ta|tá|é|eh)\b/.test(t);
  }

  static countRecentClosures(history = []) {
    const source = Array.isArray(history) ? history : [];
    const recentUser = source.filter((m) => m?.role === "user").slice(-3);
    return recentUser.filter((m) => ChatService.isConversationClosure(m.content) || ChatService.isShortAcknowledgement(m.content)).length;
  }

  static decideClosure(userText, history = []) {
    const trimmed = String(userText ?? "").trim();
    if (!trimmed) return "none";
    if (ChatService.isDirectTetoCall(trimmed)) return "none";

    const isLull = ChatService.isConversationLull(trimmed);
    const isClosure =
      ChatService.isConversationClosure(trimmed) ||
      ChatService.isShortAcknowledgement(trimmed) ||
      isLull;
    if (!isClosure) return "none";

    const source = Array.isArray(history) ? history : [];
    const lastAssistant = [...source].reverse().find((m) => m?.role === "assistant");
    const lastWasQuestion = lastAssistant?.content && ChatService.isLikelyQuestion(lastAssistant.content);

    if (lastWasQuestion && !isLull) {
      return "respond";
    }

    if (isLull) {
      if (ChatService.isEmojiOnlyMessage(trimmed)) {
        const r = Math.random();
        if (r < 0.55) return "react";
        if (r < 0.8) return "silent";
        if (r < 0.92) return "brief_farewell";
        return "respond";
      }
      const r = Math.random();
      if (r < 0.3) return "silent";
      if (r < 0.55) return "react";
      if (r < 0.76) return "brief_farewell";
      return "respond";
    }

    const assistantClosed = lastAssistant?.content
      ? ChatService.isConversationClosure(lastAssistant.content) ||
        ChatService.isShortAcknowledgement(lastAssistant.content)
      : false;
    const recentClosures = ChatService.countRecentClosures(source);

    let silentChance = 0.28;
    let reactChance = 0.42;
    if (assistantClosed) {
      silentChance = 0.38;
      reactChance = 0.48;
    } else if (recentClosures >= 2) {
      silentChance = 0.35;
      reactChance = 0.45;
    }

    const r = Math.random();
    if (r < silentChance) return "silent";
    if (r < silentChance + reactChance) return "react";
    if (r < silentChance + reactChance + 0.22) return "brief_farewell";
    return "respond";
  }

  static shouldSilentlyClose(userText, history = []) {
    return ChatService.decideClosure(userText, history) === "silent";
  }

  static shouldReactOnly(userText, history = []) {
    return ChatService.decideClosure(userText, history) === "react";
  }

  static hasImpossibleContactPrompt(text) {
    const t = String(text ?? "").toLowerCase();
    return (
      /\b(me\s+)?liga(r|me)?\s+(quando|se|depois|pra|para)\b/.test(t) ||
      /\bme\s+telefon/.test(t) ||
      /\b(chama|liga)\s+no\s+telefone\b/.test(t) ||
      /\bdá\s+uma\s+ligad/.test(t) ||
      /\bda\s+uma\s+ligad/.test(t)
    );
  }

  static hasMetaDrift(text) {
    const t = String(text ?? "").toLowerCase();
    if (/\btenta falar direito\b/.test(t) && /\b(sen[aã]o eu corrijo|corrijo pra voc[eê])\b/.test(t)) {
      return true;
    }
    if (/\bfalando tudo torto\b/.test(t)) return true;
    if (/\bt[aá] achando que n[aã]o falo como a teto\b/.test(t)) return true;
    if (/\b(quer dizer que t[aá] afim|t[aá] afim de alguma coisa)\b/.test(t)) return true;
    const hits = [
      /\bvoc[eê]\s+t[aá]\s+(procurando|querendo)\b/.test(t),
      /\bquem [ée] que t[aá] perguntando\b/.test(t),
      /\bquer dizer alguma coisa\b/.test(t),
      /\b(t[aá] afim de alguma coisa|manda logo)\b/.test(t),
      /\beu sou (a )?(kasane|teto)\b/.test(t)
    ].filter(Boolean).length;
    return hits >= 2;
  }


  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async handleMessage(message, meta = {}, history = null, tone = null) {
    const trimmed = String(message ?? "").trim();
    const thinkDelay = meta?.timingPlan?.thinkDelayMs ?? 0;
    if (thinkDelay > 0 && thinkDelay < 8000) {
      await this.sleep(Math.min(thinkDelay, 3000));
    }

    if (this.internalState?.updateBefore) {
      this.internalState.updateBefore(message, meta);
    }

    const closureDecision = meta?.closeDecision ?? ChatService.decideClosure(trimmed, history);
    if (closureDecision === "silent" || closureDecision === "react") {
      this.recordUserTurn(trimmed, meta);
      return [];
    }

    const metaWithFallback = ChatService.isConfusionSignal(trimmed)
      ? { ...meta, fallback: "ground" }
      : meta;

    let raw = await this.agent.respond(message, metaWithFallback, history, tone);
    const rawTrimmed = String(raw ?? "").trim();

    if (!rawTrimmed && ChatService.isDirectTetoCall(trimmed)) {
      raw = await this.agent.respond(
        trimmed,
        { ...metaWithFallback, fallback: "ground", skipUserRecord: true },
        history,
        tone
      );
    }

    if (Agent.isSilentReply(raw)) {
      if (ChatService.isDirectTetoCall(trimmed)) {
        raw = await this.agent.respond(
          trimmed,
          { ...metaWithFallback, fallback: "ground", skipUserRecord: true },
          history,
          tone
        );
      } else {
        const userId = meta?.userId ?? "default";
        if (this.agent?.longTerm?.updateProfile) {
          this.agent.longTerm.updateProfile(userId, {
            conversationClosedAt: new Date().toISOString()
          });
        }
        return [];
      }
    }


    const actions = sanitizeOutgoingActions(parseActionCommands(raw), meta);
    if (actions.length > 0) {
      if (this.internalState?.updateAfter) {
        const preview = actions
          .filter((a) => a.type === "message")
          .map((a) => a.text)
          .join(" ")
          .trim();
        if (preview) this.internalState.updateAfter(preview);
      }
      return returnWithActions(actions);
    }

    const processor = this.getProcessor(meta);
    const processorContext = {
      tone,
      userMessage: message,
      styleHint: meta?.styleHint ?? null,
      userPronouns: meta?.userPronouns ?? null,
      brainSnapshot: meta?.brainSnapshot ?? null,
      brainBlocks: meta?.brainBlocks ?? null,
      timingPlan: meta?.timingPlan ?? null,
      coherenceFix: meta?.coherenceFix === true,
      briefFarewell:
        closureDecision === "brief_farewell" ||
        meta?.brainSnapshot?.conversationPhase?.recommendedAction === "brief_farewell"
    };
    const safeParts = processor?.processAndGuard
      ? processor.processAndGuard(raw, processorContext)
      : processor
        ? processor.process(raw, {
            tone,
            userMessage: message,
            styleHint: meta?.styleHint ?? null,
            userPronouns: meta?.userPronouns ?? null
          })
        : [raw];

    if (!processor) {
      return raw;
    }

    const normalizedCombined = safeParts.join(" ").trim();

    if (this.internalState?.updateAfter) {
      this.internalState.updateAfter(normalizedCombined);
    }

    // Multi-message contract: if we have multiple parts, never collapse to one.
    // If repetition guard altered the combined form, keep parts but still remember the combined safe form.
    const baseParts = safeParts.length ? safeParts : [normalizedCombined];
    let needsDeEchoRegen = false;
    let resultParts = baseParts
      .map((p) => {
        const echo = ChatService.deEcho(message, p);
        if (echo.needsRegen) needsDeEchoRegen = true;
        return echo.text;
      })
      .map((part) => String(part).replace(/\s{2,}/g, " ").trim())
      .filter(Boolean);

    if (needsDeEchoRegen) {
      const regen = await this.agent.respond(
        trimmed,
        { ...meta, fallback: "ground", deEchoFix: true, skipUserRecord: true },
        history,
        tone
      );
      const regenParts = processor?.processAndGuard
        ? processor.processAndGuard(regen, { ...processorContext, deEchoFix: true })
        : [regen];
      resultParts = (regenParts ?? []).map((part) => String(part).trim()).filter(Boolean);
    }

    const hasHistory = Array.isArray(history) && history.length > 0;
    if (isContextBlindReply(resultParts, trimmed, meta)) {
      const regen = await this.agent.respond(
        trimmed,
        { ...meta, fallback: "ground", coherenceFix: true, skipUserRecord: true },
        history,
        tone
      );
      const regenParts = processor?.processAndGuard
        ? processor.processAndGuard(regen, { ...processorContext, coherenceFix: true })
        : [regen];
      resultParts = repairBubbleCoherence(
        (regenParts ?? []).map((part) => String(part).trim()).filter(Boolean)
      );
    }
    if (hasCoherenceIssues(resultParts, trimmed, { hasHistory })) {
      const regen = await this.agent.respond(
        trimmed,
        { ...meta, fallback: "ground", coherenceFix: true, skipUserRecord: true },
        history,
        tone
      );
      const regenParts = processor?.processAndGuard
        ? processor.processAndGuard(regen, { ...processorContext, coherenceFix: true })
        : [regen];
      resultParts = repairBubbleCoherence(
        (regenParts ?? []).map((part) => String(part).trim()).filter(Boolean)
      );
    }
    if (ChatService.containsLoveDeclaration(trimmed) && resultParts.length) {
      const first = resultParts[0].trim();
      if (!/^ufa!/i.test(first)) {
        resultParts[0] = `Ufa! ${first}`.trim();
      }
    }
    if (resultParts.length) {
      const first = String(resultParts[0] ?? "");
      if (ChatService.hasMetaDrift(first) || ChatService.hasImpossibleContactPrompt(first)) {
        const regen = await this.agent.respond(
          trimmed,
          { ...meta, fallback: "ground", skipUserRecord: true },
          history,
          tone
        );
        const regenParts = processor?.processAndGuard
          ? processor.processAndGuard(regen, processorContext)
          : processor
            ? processor.process(regen, processorContext)
            : [regen];
        resultParts = (regenParts ?? []).map((part) => String(part).trim()).filter(Boolean);
      }
    }

    if (!resultParts.length) {
      const fallback = ChatService.contextualFallbackForEmpty(trimmed);
      if (fallback?.strategy) {
        const metaWithFallback = { ...meta, fallback: fallback.strategy };
        const regen = await this.agent.respond(
          fallback.hint || trimmed,
          { ...metaWithFallback, skipUserRecord: true },
          history,
          tone
        );
        const regenParts = processor?.processAndGuard
          ? processor.processAndGuard(regen, processorContext)
          : processor
            ? processor.process(regen, processorContext)
            : [regen];
        resultParts = (regenParts ?? []).map((part) => String(part).trim()).filter(Boolean);
      }
    }

    if (resultParts.length) {
      const shortAffirm = /^(nunquinha|nunca+a+|jamais|de jeito nenhum|claro|com certeza|isso|isso mesmo)(\s+kk+)?$/i;
      if (shortAffirm.test(trimmed) && resultParts.length > 1) {
        resultParts = [resultParts[0]];
      }
      if (ChatService.isConversationLull(trimmed) && resultParts.length > 1) {
        resultParts = [resultParts[0]];
      }
      if (
        (closureDecision === "brief_farewell" ||
          closureDecision === "silent" ||
          ChatService.isConversationClosure(trimmed)) &&
        resultParts.length > 1
      ) {
        resultParts = [resultParts[0]];
      }
    }

    if (
      !meta?.closeDecision &&
      closureDecision !== "brief_farewell" &&
      (ChatService.shouldSilentlyClose(trimmed, history) || ChatService.shouldReactOnly(trimmed, history))
    ) {
      this.recordUserTurn(trimmed, meta);
      const sessionId = meta?.sessionId ?? "default";
      if (this.shortTerm?.popLastAssistant) {
        this.shortTerm.popLastAssistant(sessionId);
      }
      return [];
    }

    if (!resultParts.length && ChatService.isDirectTetoCall(trimmed)) {
      return returnWithActions([
        { type: "message", text: "oxi, tô aqui kkk", quoteId: null }
      ]);
    }

    const lateParsed = sanitizeOutgoingActions(
      parseActionCommands(resultParts.join("\n---\n") || raw),
      meta
    );
    if (lateParsed.length > 0) {
      return returnWithActions(lateParsed);
    }

    const defaultActions = resultParts.flatMap((p) => {
      const inner = parseActionCommands(p);
      return inner.length > 0 ? inner : [{ type: "message", text: p, quoteId: null }];
    });
    return returnWithActions(defaultActions);
  }
}
