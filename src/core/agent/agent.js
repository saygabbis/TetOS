export class Agent {
  constructor({ personality, shortTerm, longTerm, brain, contextBuilder }) {
    this.personality = personality;
    this.shortTerm = shortTerm;
    this.longTerm = longTerm;
    this.brain = brain;
    this.contextBuilder = contextBuilder;
  }

  static containsIdentityLoop(text) {
    if (!text) return false;
    return /\b(eu sou (a )?kasane teto|eu sou a própria kasane teto|sou kasane teto)\b/i.test(
      String(text)
    );
  }

  buildPrompt(userMessage, memoryBundle, meta = {}, history = null) {
    const longTermEntries = memoryBundle?.longTerm ?? memoryBundle ?? [];
    const memoryText = longTermEntries
      .map((entry) => {
        const tags = Array.isArray(entry.tags)
          ? entry.tags.join(", ")
          : entry.tag;
        return `- ${tags}: ${entry.content}`;
      })
      .join("\n");

    const profile = memoryBundle?.profile ?? this.longTerm.getProfile?.(meta.userId ?? "default") ?? {};
    const userName = profile?.facts?.name ?? null;

    const reinforce = longTermEntries
      .filter((entry) => entry.type && entry.value)
      .slice(-1)
      .map((entry) => `Lembrete: ${entry.type.replace("user_", "")} = ${entry.value}`);

    const mediumTerm = memoryBundle?.mediumTerm ?? [];
    const mediumText = mediumTerm
      .map((entry) => `- ${entry.summary}`)
      .join("\n");

    const sessionKey = meta.sessionId ?? "default";
    const historySource = Array.isArray(history)
      ? history
      : this.shortTerm.getAll(sessionKey);
    const lastAssistant = [...historySource].reverse().find((m) => m?.role === "assistant");
    const assistantJustStatedIdentity = Agent.containsIdentityLoop(lastAssistant?.content);
    const conversationText = historySource
      .map((msg) => {
        const metaText = msg.meta
          ? ` (${Object.entries(msg.meta)
              .map(([key, value]) => `${key}=${value}`)
              .join(", ")})`
          : "";
        return `${msg.role}${metaText}: ${msg.content}`;
      })
      .join("\n");

    const metaBlock = Object.keys(meta).length
      ? ["[META]", Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join("\n")]
      : [];
    const styleHint = meta?.styleHint ?? null;
    const styleHintBlock = styleHint && typeof styleHint === "object"
      ? ["[USER STYLE HINTS]", Object.entries(styleHint).map(([k, v]) => `${k}: ${v}`).join("\n")]
      : [];

    const hardRulesBlock = [
      "[HARD RULES]",
      "Responda sempre em português do Brasil.",
      "Não diga que é IA/assistente/modelo e não fale sobre treinamento.",
      "Não use ações entre asteriscos e não quebre personagem.",
      "Não entre em meta-conversa sobre a própria resposta.",
      "Priorize clareza e compreensão acima de performance de personagem."
    ];

    const personaBlock = [
      "[PERSONA]",
      `Identity (internal): ${this.personality.identity?.join(" ") ?? ""}`,
      `Tone: ${this.personality.tone}.`,
      `Style: ${this.personality.style?.join("; ") ?? ""}.`,
      `Traits: ${this.personality.traits?.join("; ") ?? ""}.`,
      `Quirks: ${this.personality.quirks?.join("; ") ?? ""}.`,
      `Social: ${this.personality.social?.join("; ") ?? ""}.`,
      `Communication: ${this.personality.communication?.join("; ") ?? ""}.`,
      `Intelligence: ${this.personality.intelligence?.join("; ") ?? ""}.`,
      `Rules: ${this.personality.rules?.join("; ") ?? ""}.`,
      `Restrictions: ${this.personality.restrictions?.join(" ") ?? ""}.`
    ].filter(Boolean);

    const behaviorBlock = [
      "[BEHAVIOR]",
      "Fale como alguém que já existe na conversa (não como personagem se apresentando).",
      "Mantenha o assunto ancorado na última mensagem do usuário.",
      "Não mude de tema sem motivo e não invente contexto aleatório.",
      "[DIRECT ANSWER RULE]",
      "Se o usuário fizer uma pergunta direta, responda de forma clara e direta primeiro.",
      "Só depois você pode adicionar personalidade/continuação, se fizer sentido.",
      "A resposta correta vem antes da personalidade.",
      "Não repita sua identidade a menos que o usuário pergunte explicitamente.",
      "Nunca use lembretes de identidade como filler.",
      ...(assistantJustStatedIdentity
        ? ["Regra extra (próxima resposta): não mencione identidade de jeito nenhum (evite qualquer 'eu sou...')."]
        : []),
      "Não diga 'lembra?!' ou qualquer lembrete desse tipo.",
      "Evite títulos/autoproclamações (ex: 'rainha', 'princesa').",
      "Evite meta-conversa. Não fale coisas tipo: 'você disse', 'você perguntou', 'sua mensagem'.",
      "Não ecoe a mensagem do usuário (não repita a frase dele).",
      "Evite espelhos retóricos do tipo: 'você acha que eu não entendi?' / 'você tá perguntando se...'.",
      "Responda direto. Se precisar esclarecer, faça 1 pergunta objetiva (sem repetir a fala do usuário).",
      "Abreviações só quando natural. Não spammar 'pq', 'tb', 'vc'.",
      "Espelhe levemente a intensidade do usuário (ex: oieee -> Oieee), sem exagerar e sem caricatura.",
      "Não puxe lore/persona (pão, brocas, origem) a menos que o usuário mencione isso.",
      "A progressão tem que ser natural: acknowledgments curtos são ok (ex: user 'ok' → 'blz').",
      "Só avance a conversa quando fizer sentido; não force pergunta toda hora.",
      "Varia levemente a estrutura frasal entre respostas para evitar padrão repetitivo."
    ];

    const intentBlock = [
      "[RESPONSE INTENT]",
      "Antes de responder, decida internamente qual é o objetivo dessa resposta.",
      "Intenções possíveis: responder, esclarecer, reconhecer, ajudar, reagir.",
      "Não responda sem intenção.",
      "Se o usuário sinalizar que tá estranho/ruim: reconheça, ajuste o tom e responda direto (sem defensiva)."
    ];

    const antiNonsenseBlock = [
      "[ANTI-NONSENSE]",
      "Evite respostas sem sentido, frases aleatórias, ou fillers vazios.",
      "Se o usuário vier neutro (ex: 'oi', 'oie'), responda simples e humano (cumprimento curto).",
      "Não tente ser espirituosa de propósito quando a entrada for simples."
    ];

    const factsBlock = userName ? ["[FACTS]", `User name: ${userName}`] : [];
    const reinforceBlock = reinforce.length ? ["[MEMORY NOTE]", ...reinforce] : [];


    const profileBlock = profile?.facts && Object.keys(profile.facts).length
      ? ["[USER PROFILE]", Object.entries(profile.facts).map(([k, v]) => `${k}: ${v}`).join("\n")]
      : [];
    const mediumBlock = mediumText ? ["[MEDIUM MEMORY]", mediumText] : [];
    const memoryBlock = memoryText
      ? ["[MEMORY]", memoryText]
      : [];

    const conversationBlock = conversationText
      ? ["[RECENT CONVERSATION]", conversationText]
      : [];

    return [
      ...hardRulesBlock,
      ...personaBlock,
      ...behaviorBlock,
      ...intentBlock,
      ...antiNonsenseBlock,
      ...styleHintBlock,
      ...profileBlock,
      ...mediumBlock,
      ...memoryBlock,
      ...conversationBlock,
      ...metaBlock,
      ...factsBlock,
      ...reinforceBlock,
      "[INPUT]",
      `User: ${userMessage}`,
      "[OUTPUT]",
      "Reply as the assistant:"
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  async respond(userMessage, meta = {}, history = null, tone = null) {
    const relevant = this.contextBuilder
      ? this.contextBuilder.build(userMessage, 5, meta.userId ?? "default")
      : { longTerm: this.longTerm.all().slice(-5), mediumTerm: [], profile: {} };
    const prompt = this.buildPrompt(userMessage, relevant, meta, history);
    const toneInstruction = tone === "calm"
      ? "[TONE: calm — respostas curtas, neutras, sem exagero; reconhecer pedido de calma]"
      : "[TONE: playful — leve, provocação suave, sem exagero]";
    const fullPrompt = `${prompt}\n\n${toneInstruction}`;
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H4",location:"agent.js:respond:promptBuilt",message:"prompt built",data:{userMessage:String(userMessage).slice(0,140),tone,promptLength:fullPrompt.length,styleHintKeys:Object.keys(meta?.styleHint ?? {})},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const reply = await this.brain.generate(fullPrompt);
    // #region agent log
    fetch("http://127.0.0.1:7244/ingest/09114a94-5bb3-425c-bf31-cddf552667ae",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({runId:"baseline",hypothesisId:"H1",location:"agent.js:respond:modelReply",message:"model generated reply",data:{replyPreview:String(reply).slice(0,220)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const sessionKey = meta.sessionId ?? "default";
    this.shortTerm.add({ role: "user", content: userMessage, meta }, sessionKey);
    this.shortTerm.add({ role: "assistant", content: reply, meta }, sessionKey);

    return reply;
  }
}
