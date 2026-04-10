import { Agent } from "../../core/agent/agent.js";

export class ChatService {
  constructor(agent, responseProcessor, internalState) {
    this.agent = agent;
    this.responseProcessor = responseProcessor;
    this.internalState = internalState;
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
    if (/\b(teto|tete|tetozinha)\b/.test(t)) return "name";
    if (/@\d{4,}/.test(t)) return "mention";
    return null;
  }

  static pickAckVariant(trimmed) {
    const key = String(trimmed ?? "").toLowerCase();
    if (/^(valeu)$/i.test(key)) return "De nada.";
    if (/^(blz|beleza|fechado)$/i.test(key)) {
      return key.length % 2 === 0 ? "Fechou." : "Perfeito, fechou.";
    }
    return key.length % 2 === 0 ? "Blz, seguimos." : "Boa, seguimos.";
  }

  static deEcho(userMessage, assistantText) {
    const u = String(userMessage ?? "").toLowerCase();
    const a = String(assistantText ?? "").toLowerCase();

    // Targeted fixes for the most common mirror patterns observed.
    if (/(não entende|nao entende|não entendi|nao entendi|entender direito)/.test(u)) {
      if (/(não entende|nao entende|não entendi|nao entendi|entender direito)/.test(a)) {
        return "Entendi sim. O que ficou estranho pra você?";
      }
    }

    if (
      /\b(respondi tudo|eu respondi|j[áa] falei tudo|falei tudo|eu falei)\b/.test(u) &&
      /\b(falou demais|faltando|incomplet|ficou faltando)\b/.test(a)
    ) {
      return "Foi mal, entendi torto. Tudo certo então — bora seguir o papo.";
    }

    return assistantText;
  }

  static containsLoveDeclaration(text) {
    const t = String(text ?? "").toLowerCase();
    return /\b(eu\s+)?te\s+amo\b/.test(t);
  }

  static isPositiveWellbeingReply(text) {
    let t = ChatService.normalizeLoose(text);
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

  static isConversationIntent(text) {
    const t = ChatService.normalizeLoose(text);
    return /\b(so queria conversar|só queria conversar|quero conversar|to afim de conversar|vamos conversar)\b/.test(t);
  }

  static isConfusionSignal(text) {
    const t = ChatService.normalizeLoose(text);
    return /\b(ta se perdendo|tá se perdendo|sem sentido|nao entendeu|não entendeu|viajou|nada a ver)\b/.test(t);
  }

  static isPingMessage(text) {
    const t = ChatService.normalizeLoose(text);
    return /^(alou|alo|alou\?|alo\?)$/.test(t);
  }

  /** Só emoji / símbolo (sem palavras) — ex.: ❤️, 😂, combinações curtas. */
  static isEmojiOnlyMessage(text) {
    const raw = String(text ?? "").trim();
    if (!raw || raw.length > 64) return false;
    const letters = raw.replace(/[^\p{L}]/gu, "");
    if (letters.length > 0) return false;
    return /[\u203C-\u3299\uFE0F\u200D]|[\u{1F300}-\u{1FAFF}]|[\u2600-\u27BF]/u.test(raw);
  }

  static emojiOnlyReplies(text) {
    const t = String(text ?? "");
    if (/[❤💕💗💋🥰😘💖]/.test(t)) {
      const variants = [
        ["Aí ❤️", "Tô aqui."],
        ["Recebi kkk ❤️"],
        ["Bateu até aqui, mds ❤️"]
      ];
      return variants[t.length % variants.length];
    }
    if (/[😂🤣💀☠]/.test(t)) {
      return ["Kkkkk", "Tá animada hoje"];
    }
    if (/[😭😢]/.test(t)) {
      return ["Eita", "Tá tudo bem aí?"];
    }
    return ["Vi aqui 😊", "Manda mais quando quiser."];
  }

  static contextualFallbackForEmpty(userMessage) {
    const t = String(userMessage ?? "").trim();
    if (ChatService.isEmojiOnlyMessage(t)) {
      return ChatService.emojiOnlyReplies(t)[0];
    }
    return "Hm, não peguei direito — manda de novo ou explica melhor?";
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

    if (/^(falou|flw|vlw)(\s+k{2,})?$/i.test(t)) return true;
    if (/^(tchau|xau)(\s+k{2,})?$/i.test(t)) return true;

    if (/^pode deixar\b/.test(t)) return true;
    if (/^deixa\s+(quieto|pra la|pralá|comigo|assim)\b/.test(t)) return true;
    if (/^(valeu|vlw)\s+(amiga|amigo|viu|mesmo|aí|ai)\b/.test(t)) return true;
    if (/^até\s+(logo|mais|amanha|amanhã)\b/.test(t)) return true;
    if (/^tchau\b/.test(t)) return true;
    if (/^beleza[, ]+então\b/.test(t)) return true;
    if (/^por hoje (é|e) isso\b/.test(t)) return true;
    if (/^resolvido\b/.test(t)) return true;
    if (/^ta\s+tranquilo\b|^tá\s+tranquilo\b/.test(t) && t.length < 40) return true;
    return false;
  }

  static hasMetaDrift(text) {
    const t = String(text ?? "").toLowerCase();
    const hits = [
      /\bvoc[eê]\s+t[aá]\s+(procurando|querendo)\b/.test(t),
      /\bquem [ée] que t[aá] perguntando\b/.test(t),
      /\bquer dizer alguma coisa\b/.test(t),
      /\beu sou (a )?(kasane|teto)\b/.test(t)
    ].filter(Boolean).length;
    return hits >= 2;
  }

  static groundedFallback(userMessage) {
    const t = ChatService.normalizeLoose(userMessage);
    if (/^(eu)$/.test(t)) return "Te ouvi. Pode continuar que eu acompanho.";
    if (/^(sim|isso|exato|isso mesmo)$/.test(t)) return "Fechado, estamos alinhadas.";
    if (/\b(nao|não) estou\b/.test(t)) return "Tranquilo, sem pressão. A gente segue no papo normal.";
    if (/\bvoc[eê] [ée] estranha\b/.test(t)) return "Justo. Vou manter mais direto e natural daqui pra frente.";
    return "Entendi. Vou seguir exatamente no que você acabou de dizer, sem desviar.";
  }

  async handleMessage(message, meta = {}, history = null, tone = null) {
    const trimmed = String(message ?? "").trim();


    if (this.internalState?.updateBefore) {
      this.internalState.updateBefore(message, meta);
    }

    const raw = await this.agent.respond(message, meta, history, tone);

    if (Agent.isSilentReply(raw)) {
      const userId = meta?.userId ?? "default";
      if (this.agent?.longTerm?.updateProfile) {
        this.agent.longTerm.updateProfile(userId, {
          conversationClosedAt: new Date().toISOString()
        });
      }
      return [];
    }


    const parts = this.responseProcessor
      ? this.responseProcessor.process(raw, {
        tone,
        userMessage: message,
        styleHint: meta?.styleHint ?? null
      })
      : [raw];

    if (!this.responseProcessor) {
      return raw;
    }

    // Apply repetition guard without breaking multi-message continuity.
    const safeParts = parts
      .map((part) => this.responseProcessor.ensureNonRepetitive(part))
      .map((part) => String(part).replace(/\s{2,}/g, " ").trim())
      .filter(Boolean);

    const combined = safeParts.join(" ").trim();
    const safeCombined = this.responseProcessor.ensureNonRepetitive(combined);
    const normalizedCombined = String(safeCombined).replace(/\s{2,}/g, " ").trim();
    this.responseProcessor.remember(normalizedCombined);

    if (this.internalState?.updateAfter) {
      this.internalState.updateAfter(normalizedCombined);
    }

    // Multi-message contract: if we have multiple parts, never collapse to one.
    // If repetition guard altered the combined form, keep parts but still remember the combined safe form.
    const baseParts = safeParts.length ? safeParts : [normalizedCombined];
    let resultParts = baseParts
      .map((p) => ChatService.deEcho(message, p))
      .map((part) => String(part).replace(/\s{2,}/g, " ").trim())
      .filter(Boolean);
    // Avoid repetitive "como vai você?" loops after user already answered wellbeing.
    if (ChatService.isPositiveWellbeingReply(trimmed)) {
      resultParts = resultParts
        .map((part) =>
          part.replace(/\b(como vai voc[eê]\??|como voce ta\??|como você tá\??|de boa e vc\??|e vc\??|e você\??)\b/gi, "")
        )
        .map((part) => part.replace(/\s{2,}/g, " ").trim())
        .filter(Boolean);
    }
    if (ChatService.containsLoveDeclaration(trimmed) && resultParts.length) {
      const first = resultParts[0].trim();
      if (!/^ufa!/i.test(first)) {
        resultParts[0] = `Ufa! ${first}`.trim();
      }
    }
    if (resultParts.length) {
      const first = String(resultParts[0] ?? "");
      if (ChatService.hasMetaDrift(first)) {
        resultParts = [ChatService.groundedFallback(trimmed)];
      }
    }

    if (!resultParts.length) {
      resultParts = [ChatService.contextualFallbackForEmpty(trimmed)];
    }
    return resultParts;
  }
}
