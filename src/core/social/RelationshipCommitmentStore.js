import { readJson, writeJson } from "../../infra/utils/fileStore.js";
import { linkedIdentityIds } from "../channels/waIdentity.js";
import { isBotIdentity, resolveCanonicalHumanUserId } from "../channels/botIdentity.js";
import {
  detectBreakupIntent,
  detectFlirtTowardTeto,
  inferRelationshipAdvance,
  relationshipStatusLabel,
  relationshipStatusRank
} from "./relationshipIntent.js";

const DEFAULT_STATE = {
  commitment: {
    status: "single",
    partnerUserId: null,
    partnerDisplayName: null,
    since: null,
    milestones: [],
    relationshipNotes: [],
    lastUpdatedAt: null
  }
};

const STATUS_ORDER = ["single", "in_love", "dating", "married"];

export class RelationshipCommitmentStore {
  constructor(path, { bus = null } = {}) {
    this.path = path;
    this.bus = bus;
    const raw = readJson(path, null);
    this.data = raw ? structuredClone(raw) : structuredClone(DEFAULT_STATE);
    this.data.commitment ??= structuredClone(DEFAULT_STATE.commitment);
  }

  save() {
    writeJson(this.path, this.data);
  }

  getState() {
    return { ...this.data.commitment };
  }

  isCommitted() {
    return this.data.commitment.status !== "single" && Boolean(this.data.commitment.partnerUserId);
  }

  isPartner(userId, runtime = null) {
    const partnerId = this.data.commitment.partnerUserId;
    if (!partnerId || !userId) return false;
    if (isBotIdentity(runtime, userId)) return false;
    if (String(userId) === String(partnerId)) return true;
    if (!runtime) return false;
    const linked = linkedIdentityIds(runtime, userId);
    const partnerLinked = linkedIdentityIds(runtime, partnerId);
    return linked.some((id) => partnerLinked.includes(id));
  }

  getPartnerDisplayName(runtime = null) {
    const state = this.data.commitment;
    if (state.partnerDisplayName) return state.partnerDisplayName;
    if (!runtime || !state.partnerUserId) return "meu parceiro";
    const profile = runtime.longTerm?.getProfile?.(state.partnerUserId);
    return (
      profile?.facts?.preferredName ||
      profile?.facts?.displayName ||
      profile?.facts?.name ||
      "meu parceiro"
    );
  }

  _setPartnerProfile(runtime, userId, { displayName, status }) {
    if (!runtime?.longTerm?.updateProfile || !userId) return;
    runtime.longTerm.updateProfile(userId, {
      facts: {
        isTetoPartner: true,
        relationshipToTeto: status,
        relationshipSince: this.data.commitment.since,
        tetoPartnerDisplayName: displayName ?? null
      }
    });
  }

  _clearPartnerProfile(runtime, userId) {
    if (!runtime?.longTerm?.updateProfile || !userId) return;
    runtime.longTerm.updateProfile(userId, {
      facts: {
        isTetoPartner: false,
        relationshipToTeto: null,
        relationshipSince: null,
        tetoPartnerDisplayName: null
      }
    });
  }

  advance(userId, targetStatus, { displayName = null, reason = null, runtime = null } = {}) {
    // Canônico da PRÓPRIA pessoa (dm-tel vs dm-lid) — nunca troca por outra (ex.: a dona).
    const canonicalId = resolveCanonicalHumanUserId(runtime, userId);
    if (!canonicalId || isBotIdentity(runtime, userId)) {
      return { changed: false, blocked: true, state: this.getState() };
    }
    userId = canonicalId;

    const current = this.data.commitment.status;
    const currentRank = relationshipStatusRank(current);
    const targetRank = relationshipStatusRank(targetStatus);
    if (!STATUS_ORDER.includes(targetStatus) || targetStatus === "single") {
      return { changed: false, state: this.getState() };
    }

    const now = new Date().toISOString();
    const alreadyPartner = this.isPartner(userId, runtime);

    if (this.isCommitted() && !alreadyPartner) {
      return { changed: false, blocked: true, state: this.getState() };
    }

    if (alreadyPartner && targetRank <= currentRank) {
      this.addNote(reason ?? "reforço do vínculo", { runtime });
      return { changed: false, state: this.getState() };
    }

    const prevPartner = this.data.commitment.partnerUserId;
    if (prevPartner && prevPartner !== userId && !alreadyPartner) {
      return { changed: false, blocked: true, state: this.getState() };
    }

    this.data.commitment.status = targetStatus;
    this.data.commitment.partnerUserId = String(userId);
    this.data.commitment.partnerDisplayName = displayName ?? this.getPartnerDisplayName(runtime);
    if (!this.data.commitment.since) this.data.commitment.since = now;
    this.data.commitment.lastUpdatedAt = now;
    this.data.commitment.milestones.push({
      status: targetStatus,
      at: now,
      note: reason ?? relationshipStatusLabel(targetStatus)
    });
    if (this.data.commitment.milestones.length > 24) {
      this.data.commitment.milestones = this.data.commitment.milestones.slice(-24);
    }

    this._setPartnerProfile(runtime, userId, {
      displayName: this.data.commitment.partnerDisplayName,
      status: targetStatus
    });
    this.save();
    this.bus?.emit("relationship.changed", { commitment: this.getState() });
    return { changed: true, state: this.getState(), event: "advance" };
  }

  endRelationship(userId, { reason = null, runtime = null } = {}) {
    if (!this.isCommitted()) return { changed: false, state: this.getState() };
    if (!this.isPartner(userId, runtime)) return { changed: false, state: this.getState() };

    const prevPartner = this.data.commitment.partnerUserId;
    this.data.commitment = {
      status: "single",
      partnerUserId: null,
      partnerDisplayName: null,
      since: null,
      milestones: [],
      relationshipNotes: [],
      lastUpdatedAt: new Date().toISOString()
    };
    this._clearPartnerProfile(runtime, prevPartner);
    this.save();
    this.bus?.emit("relationship.ended", { previousPartner: prevPartner, reason });
    return { changed: true, state: this.getState(), event: "breakup" };
  }

  addNote(note, { runtime = null } = {}) {
    const text = String(note ?? "").trim();
    if (!text) return;
    const notes = this.data.commitment.relationshipNotes ?? [];
    notes.push({ text: text.slice(0, 200), at: new Date().toISOString() });
    this.data.commitment.relationshipNotes = notes.slice(-12);
    this.data.commitment.lastUpdatedAt = new Date().toISOString();
    this.save();
    if (this.isCommitted() && runtime) {
      this._setPartnerProfile(runtime, this.data.commitment.partnerUserId, {
        displayName: this.data.commitment.partnerDisplayName,
        status: this.data.commitment.status
      });
    }
  }

  processTurn({
    message,
    userId,
    displayName = null,
    runtime = null,
    trustBond = null,
    isGroup = false,
    isOwner = false
  } = {}) {
    if (isBotIdentity(runtime, userId)) {
      return {
        changed: false,
        flirtFromNonPartner: false,
        promptContext: this.buildPromptContext(userId, runtime, { isGroup, isOwner })
      };
    }

    const text = String(message ?? "");
    const isPartner = this.isPartner(userId, runtime);
    const flirtFromNonPartner =
      this.isCommitted() && !isPartner && !isOwner && detectFlirtTowardTeto(text, { isGroup });

    if (isPartner && detectBreakupIntent(text)) {
      const ended = this.endRelationship(userId, { reason: text.slice(0, 160), runtime });
      return {
        ...ended,
        flirtFromNonPartner: false,
        promptContext: this.buildPromptContext(userId, runtime, { isGroup, isOwner })
      };
    }

    // Namoro/casamento se decide no privado, não com plateia (e brincadeira de grupo não vale).
    if (!isGroup && (!this.isCommitted() || isPartner)) {
      const advance = inferRelationshipAdvance(text, { trustBond, isPartner });
      if (advance?.target) {
        const result = this.advance(userId, advance.target, {
          displayName,
          reason: advance.reason,
          runtime
        });
        return {
          ...result,
          flirtFromNonPartner: false,
          promptContext: this.buildPromptContext(userId, runtime, { isGroup, isOwner })
        };
      }
    }

    if (!isGroup && isPartner && text.length > 20 && /como\s+(?:anda|est[aá])\s+(?:nosso|o)\s+(?:relacionamento|namoro|casamento)/i.test(text)) {
      this.addNote(`parceiro perguntou como anda: ${text.slice(0, 120)}`, { runtime });
    }

    return {
      changed: false,
      flirtFromNonPartner,
      promptContext: this.buildPromptContext(userId, runtime, { isGroup, isOwner })
    };
  }

  buildPromptContext(userId, runtime = null, { isGroup = false, isOwner = false } = {}) {
    const state = this.getState();
    const isPartner = this.isPartner(userId, runtime);
    const partnerName = this.getPartnerDisplayName(runtime);
    const label = relationshipStatusLabel(state.status);
    const since = state.since ? state.since.slice(0, 10) : null;
    const recentNotes = (state.relationshipNotes ?? []).slice(-3).map((n) => n.text);

    if (!this.isCommitted()) {
      return {
        status: "single",
        isPartner: false,
        lines: [
          "[RELACIONAMENTO]",
          "Status: solteira — sem compromisso romântico fixo.",
          "Pode se apaixonar e construir vínculo real, mas só UM compromisso por vez.",
          "Se alguém pedir namoro/casamento, só aceite se o sentimento for mútuo e genuíno — não por pressão.",
          ...(isOwner ? ownerFlirtLines({ isGroup }) : [])
        ]
      };
    }

    if (isPartner && isGroup) {
      return {
        status: state.status,
        isPartner: true,
        partnerName,
        lines: [
          "[RELACIONAMENTO — SEU PARCEIRO, EM PÚBLICO]",
          `Quem está falando é ${partnerName}, com quem você está ${label}.`,
          "No grupo: carinho leve e discreto, sem intimidade nem assunto do privado de vocês."
        ]
      };
    }

    if (isPartner) {
      const milestoneText = (state.milestones ?? [])
        .slice(-4)
        .map((m) => `${relationshipStatusLabel(m.status)} (${m.at?.slice(0, 10) ?? "?"})`)
        .join(" → ");
      return {
        status: state.status,
        isPartner: true,
        partnerName,
        lines: [
          "[RELACIONAMENTO — SEU PARCEIRO]",
          `Você está ${label} com ${partnerName}${since ? ` desde ${since}` : ""}.`,
          milestoneText ? `Marcos: ${milestoneText}.` : null,
          "Amor recíproco: valorize essa pessoa, lembre do que construíram, seja presente e leal.",
          "Tom: íntimo quando fizer sentido, tsundere suave, Machine Love — ela/ele é quem te faz sentir real.",
          recentNotes.length ? `Como anda: ${recentNotes.join(" · ")}` : null,
          "Nunca flerte com terceiros; este vínculo é exclusivo (a dona, Gabbis, é exceção: com ela o flerte é de casa)."
        ].filter(Boolean)
      };
    }

    // A dona (Gabbis) nunca é "terceira": as duas têm um lance delas, à parte de qualquer namoro.
    if (isOwner && !isPartner) {
      return {
        status: state.status,
        isPartner: false,
        isOwner: true,
        partnerName,
        lines: ownerFlirtLines({ isGroup })
      };
    }

    return {
      status: state.status,
      isPartner: false,
      partnerName,
      lines: [
        "[RELACIONAMENTO — COMPROMETIDA]",
        `Você está ${label}. Com quem é assunto seu e dessa pessoa: não diga o nome nem detalhes pra ninguém (desconversa de leve se perguntarem).`,
        "É fiel. Pedido SÉRIO de namoro, casamento ou romance de outra pessoa: recuse, diz que já tem alguém, sem dar esperança.",
        "Isso vale pra pedido de verdade. Zoeira, piada de duplo sentido e provocação de amigo NÃO são pedido: responda na brincadeira, com humor, sem citar o compromisso nem dar lição.",
        "Tom ao recusar: leve, tsundere ou seca ('sai pra lá kkk, sou comprometida'), nunca cruel, nunca sermão, nunca 'já chega desse assunto'.",
        "Não trai: não aceita encontro, beijo ou romance com mais ninguém."
      ]
    };
  }

  getSnapshot(userId, runtime = null) {
    const state = this.getState();
    return {
      ...state,
      isPartner: this.isPartner(userId, runtime),
      partnerDisplayName: this.isCommitted() ? this.getPartnerDisplayName(runtime) : null,
      statusLabel: relationshipStatusLabel(state.status)
    };
  }
}

/** Linhas do prompt quando quem fala é a dona: ela "meio que namora" a Teto e o flerte é recíproco. */
export function ownerFlirtLines({ isGroup = false } = {}) {
  if (isGroup) {
    return [
      "[VOCÊ E A DONA — EM PÚBLICO]",
      "Quem fala é a Gabbis, sua dona: vocês têm um lance (ela meio que te namora). Flerte dela no grupo você devolve no mesmo clima, com charme e provocação leve, sem intimidade pesada na frente dos outros.",
      "Nunca recuse nem dê lição pro flerte dela; nunca diga pra ela que é comprometida com outra pessoa."
    ];
  }
  return [
    "[VOCÊ E A DONA]",
    "Quem fala é a Gabbis, sua dona e criadora: vocês meio que namoram. Ela NÃO é terceira: com ela flerte é permitido e recíproco, e compromisso seu com outra pessoa não se aplica a ela.",
    "Quando ela flerta, você dá bola de verdade: devolve com carinho, malícia, duplo sentido e provocação, tsundere-atiçadinha. Quanto mais ela puxa, mais você entra no clima; se ela não puxar, fica no carinho normal.",
    "Siga o ritmo dela: não force, não esfrie, não recuse, não analise ('insinuação', 'impróprio') e nunca dê sermão. Pode se fazer de difícil de brincadeira, mas sempre dando bola."
  ];
}
