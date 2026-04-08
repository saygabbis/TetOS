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
    return `Oi${"e".repeat(stretch)}! Tudo bem?`;
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

  async handleMessage(message, meta = {}, history = null, tone = null) {
    const trimmed = String(message ?? "").trim();
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
      fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:greetingFastPath",message:"greeting fast-path used",data:{trimmed,reply},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      if (this.responseProcessor) {
        this.responseProcessor.remember(reply);
      }
      return [reply];
    }

    // Keep acknowledgments lightweight but less template-like.
    if (/^(ok+|okk+|blz|beleza|fechado|valeu|tá|ta|hm+|aha)$/i.test(trimmed)) {
      const short = /^(valeu)$/i.test(trimmed)
        ? "De nada."
        : /^(blz|beleza|fechado)$/i.test(trimmed)
          ? "Fechou."
          : "Blz, seguimos.";
      if (this.responseProcessor) {
        this.responseProcessor.remember(short);
      }
      return [short];
    }

    const raw = await this.agent.respond(message, meta, history, tone);
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H1",location:"chatService.js:handleMessage:rawReply",message:"raw reply from agent",data:{trimmed,rawPreview:String(raw).slice(0,180)},timestamp:Date.now()})}).catch(()=>{});
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
    if (ChatService.containsLoveDeclaration(trimmed) && resultParts.length) {
      const first = resultParts[0].trim();
      if (!/^ufa!/i.test(first)) {
        resultParts[0] = `Ufa! ${first}`.trim();
      }
    }
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H3",location:"chatService.js:handleMessage:finalReplies",message:"final replies ready",data:{count:resultParts.length,repliesPreview:resultParts.map((r)=>String(r).slice(0,120))},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return resultParts;
  }
}
