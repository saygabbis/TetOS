export class ChatService {
  constructor(agent, responseProcessor) {
    this.agent = agent;
    this.responseProcessor = responseProcessor;
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
    const hasVoc = t.includes("voc");
    return (
      (hasQuem && hasVoc) ||
      /\be\s+voc/.test(t) ||
      /\be (voce|vc)\??\s*$/.test(t)
    );
  }

  static isSimpleGreeting(text) {
    const t = ChatService.normalizeLoose(text);
    return /^(oi+|oie+|ola+|eae+|hey+|oxi+)$/.test(t);
  }

  static greetingReply(text) {
    const raw = String(text ?? "").toLowerCase();
    const stretch = Math.min(3, Math.max(1, ((raw.match(/e{2,}/g) ?? [""]).join("").length || 1)));
    const variants = [
      `Oi${"e".repeat(stretch)}! Tudo bem?`,
      `Oie${"e".repeat(Math.max(0, stretch - 1))}! Como cê tá?`,
      `Oi${"e".repeat(stretch)}! Bora conversar?`
    ];
    return variants[raw.length % variants.length];
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

    return assistantText;
  }

  static containsLoveDeclaration(text) {
    const t = String(text ?? "").toLowerCase();
    return /\b(eu\s+)?te\s+amo\b/.test(t);
  }

  static isPositiveWellbeingReply(text) {
    const t = ChatService.normalizeLoose(text);
    return /^(tudo|td|to bem|tô bem|estou bem|bem|de boa|tranquilo|tranquila|suave)$/.test(t);
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
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H8",location:"chatService.js:handleMessage:entry",message:"chat entry",data:{trimmedPreview:trimmed.slice(0,120),tone,hasHistory:Array.isArray(history)&&history.length>0,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:entry",message:"incoming message",data:{trimmed,tone,hasHistory:Array.isArray(history)&&history.length>0},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    // Direct answer fast-path: name questions must be answered directly.
    if (ChatService.isNameQuestion(trimmed)) {
      const replies = ["Sou a Teto. E você?"];
      // #region agent log
      fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:nameFastPath",message:"name fast-path used",data:{trimmed,replies},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (this.responseProcessor) {
        this.responseProcessor.remember(replies.join(" "));
      }
      return replies;
    }

    // Direct identity answer: keep short and natural.
    if (ChatService.isWhoAreYouQuestion(trimmed)) {
      const reply = "Sou a Teto.";
      // #region agent log
      fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:identityFastPath",message:"identity fast-path used",data:{trimmed,reply},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (this.responseProcessor) {
        this.responseProcessor.remember(reply);
      }
      return [reply];
    }

    if (ChatService.isSimpleGreeting(trimmed)) {
      const reply = ChatService.greetingReply(trimmed);
      // #region agent log
      fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H9",location:"chatService.js:handleMessage:greetingFastPath",message:"greeting fast path triggered",data:{trimmed,reply,pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      // #region agent log
      fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:greetingFastPath",message:"greeting fast-path used",data:{trimmed,reply},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (this.responseProcessor) {
        this.responseProcessor.remember(reply);
      }
      return [reply];
    }

    if (ChatService.isPingMessage(trimmed)) {
      const reply = "Tô aqui sim.";
      if (this.responseProcessor) this.responseProcessor.remember(reply);
      return [reply];
    }

    if (ChatService.isPositiveWellbeingReply(trimmed)) {
      const replies = [
        "Aí sim, bom demais.",
        "Boa! Fico feliz de verdade.",
        "Perfeito, então bora continuar."
      ];
      const pick = replies[trimmed.length % replies.length];
      if (this.responseProcessor) {
        this.responseProcessor.remember(pick);
      }
      return [pick];
    }

    if (ChatService.isConversationIntent(trimmed)) {
      const reply = "Perfeito, então vamos de papo leve. Quer começar por algo aleatório ou por como foi seu dia?";
      if (this.responseProcessor) {
        this.responseProcessor.remember(reply);
      }
      return [reply];
    }

    if (ChatService.isConfusionSignal(trimmed)) {
      const reply = "Justo. Me alinhei agora: vou manter no que você acabou de falar, sem viajar. Pode continuar.";
      if (this.responseProcessor) {
        this.responseProcessor.remember(reply);
      }
      return [reply];
    }

    if (/^qual (o )?meu nome\??$/i.test(ChatService.normalizeLoose(trimmed))) {
      const profile = this.agent?.longTerm?.getProfile?.(meta?.userId ?? "default");
      const knownName = String(profile?.facts?.name ?? "").trim();
      const reply = knownName
        ? `Seu nome é ${knownName}.`
        : "Você ainda não me disse seu nome com clareza.";
      if (this.responseProcessor) this.responseProcessor.remember(reply);
      return [reply];
    }

    // Keep acknowledgments lightweight but less template-like.
    if (/^(ok+|okk+|blz|beleza|fechado|valeu|tá|ta|hm+|aha)$/i.test(trimmed)) {
      const short = ChatService.pickAckVariant(trimmed);
      if (this.responseProcessor) {
        this.responseProcessor.remember(short);
      }
      return [short];
    }

    const raw = await this.agent.respond(message, meta, history, tone);
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H10",location:"chatService.js:handleMessage:raw",message:"raw model reply",data:{rawPreview:String(raw).slice(0,200),pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H1",location:"chatService.js:handleMessage:rawReply",message:"raw reply from agent",data:{trimmed,rawPreview:String(raw).slice(0,180)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H10",location:"chatService.js:handleMessage:context",message:"context used",data:{historyCount:Array.isArray(history)?history.length:0,metaKeys:Object.keys(meta ?? {}),pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
      .map((part) => String(part).trim())
      .filter(Boolean);

    const combined = safeParts.join(" ").trim();
    const safeCombined = this.responseProcessor.ensureNonRepetitive(combined);
    this.responseProcessor.remember(safeCombined);

    // Multi-message contract: if we have multiple parts, never collapse to one.
    // If repetition guard altered the combined form, keep parts but still remember the combined safe form.
    const baseParts = safeParts.length ? safeParts : [safeCombined];
    let resultParts = baseParts.map((p) => ChatService.deEcho(message, p)).filter(Boolean);
    // Avoid repetitive "como vai você?" loops after user already answered wellbeing.
    if (ChatService.isPositiveWellbeingReply(trimmed)) {
      resultParts = resultParts
        .map((part) => part.replace(/\b(como vai voc[eê]\??|como voce ta\??|como você tá\??)\b/gi, ""))
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
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:finalReplies",message:"final replies ready",data:{count:resultParts.length,repliesPreview:resultParts.map((r)=>String(r).slice(0,120))},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    // #region agent log
    fetch("http://127.0.0.1:7350/ingest/5ccc4511-cedf-4c03-a962-2f6ef0a264f8",{method:"POST",headers:{"Content-Type":"application/json","X-Debug-Session-Id":"c4ae5b"},body:JSON.stringify({sessionId:"c4ae5b",runId:"conversation-debug",hypothesisId:"H11",location:"chatService.js:handleMessage:final",message:"final replies",data:{parts:resultParts.length,repliesPreview:resultParts.map((r)=>String(r).slice(0,100)),pid:process.pid},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return resultParts;
  }
}
