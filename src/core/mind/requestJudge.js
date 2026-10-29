import { askModel, clip, normText, parseJsonLoose } from "./mindText.js";

/**
 * Pedidos e sugestões PRA ELA ("aprende X", "para de rir tanto", "cria um comando que…", "pesquisa
 * sobre Y e me fala"). Antes ela respondia "vou fazer!" e nada acontecia. Agora: detecta, julga (pode
 * recusar), e o que ela aceita vira coisa real — lição na hora, estudo/habilidade/código na agenda.
 */

const LEARN = /\b(aprend\w*\s+(a|sobre|mais|o\s+que|como)|estud\w*\s+(sobre|mais|isso|o|a)|pesquis\w*\s+(sobre|mais\s+sobre|a\s+fundo)|se\s+inform\w*\s+sobre|(voce|vc|tu)\s+(devia|deveria|precisa|tem\s+que)\s+(saber|conhecer|aprender|estudar|ler|assistir|ouvir)|(voce|vc|tu)\s+(nao|n)\s+sabe\s+(nada\s+)?(de|sobre))\b/;
const BEHAVIOR = /\b(para\s+de\s+\w+|(voce|vc|tu)\s+(devia|deveria|precisa|tem\s+que)\s+(parar|falar|ser|responder|rir|usar|mandar|ficar|evitar|prestar|escrever|chamar)|fala\s+menos|manda\s+menos|(nao|n)\s+(fala|faz|manda|usa|ri|marca)\s+mais|melhora\s+(o\s+)?(seu|teu)\s+jeito|seja\s+mais|fica\s+mais|tenta\s+ser|muda\s+(o\s+)?(seu|teu)\s+jeito|aprende\s+a\s+(falar|conversar|responder|ser|entender))\b/;
const BUILD = /\b((cria|criar|adiciona|adicionar|faz|fazer|coloca|colocar|programa|programar|implementa|implementar|inventa)\s+(um|uma|uns|umas)?\s*(comando|funcao|habilidade|recurso|ferramenta|jeito\s+de|modo|sistema|opcao)|aprende\s+a\s+(fazer|converter|calcular|traduzir|gerar|resumir|baixar|transcrever|contar|criar)|(muda|mexe\s+n|altera|reescreve|melhora)\w*\s+(o\s+)?(seu|teu)\s+(proprio\s+)?(codigo|sistema|programa|cerebro)|se\s+(programa|reprograma|atualiza|melhora\s+sozinha)|evolui|se\s+auto\s*(melhora|corrige|programa))\b/;

/**
 * É pedido/sugestão sobre ela? Só conta quando foi pra ela (PV, marcação, reply ou nome).
 * @returns {{ kind: "aprender"|"comportamento"|"construir", text: string } | null}
 */
export function detectSelfRequest(text = "", { directed = true } = {}) {
  if (!directed) return null;
  const raw = String(text ?? "").trim();
  if (raw.length < 6 || raw.length > 600) return null;
  const t = normText(raw);
  if (BUILD.test(t)) return { kind: "construir", text: raw };
  if (BEHAVIOR.test(t) && /\b(voce|vc|tu|teto|tetozinha|seu|teu|sua|tua)\b|^(para|fala|manda|seja|fica|tenta|muda|melhora|aprende|nao|n)\b/.test(t)) {
    return { kind: "comportamento", text: raw };
  }
  if (LEARN.test(t)) return { kind: "aprender", text: raw };
  return null;
}

export function buildJudgePrompt({ request, who, isOwner, platform, isGroup, lessons = [], persona = "", recent = "" }) {
  return [
    "Você é a Kasane Teto. Alguém te fez um pedido/sugestão SOBRE VOCÊ. Você é autônoma: decide de verdade se aceita, e o que aceitar o sistema vai EXECUTAR (não é só falar).",
    persona ? `Quem você é: ${persona}` : "",
    `Quem pediu: ${who ?? "alguém"}${isOwner ? " (Gabbis, sua dona e criadora — confia muito nela, mas ainda pode discordar com argumento)" : " (não é a dona)"} — ${platform}${isGroup ? ", num grupo" : ", no privado"}.`,
    recent ? `Contexto recente:\n${recent}` : "",
    `Pedido: «${clip(request, 500)}»`,
    lessons.length ? `Suas lições atuais: ${lessons.map((l) => l.rule).join(" | ")}` : "",
    "",
    "O que você pode fazer se aceitar:",
    "- licao: mudar seu jeito de falar/agir agora (vira uma regra sua). Ex.: rir menos, marcar menos, não mandar figurinha em X.",
    "- estudar: pesquisar e estudar um assunto na internet (você lê e guarda o que aprendeu).",
    "- habilidade: criar uma habilidade nova em você (um pequeno programa que roda quando a conversa pede: calcular, converter, consultar algo).",
    "- habilidade também serve pra se CONECTAR em coisas novas: ela pode chamar qualquer API/site público (sem chave).",
    "- codigo: mudar seu próprio código pra corrigir/melhorar algo (só pedido da dona; com backup e testes; parte restrita você pede autorização pra ela).",
    "- pedir: precisa de algo que só a dona pode fazer (chave/conta de um serviço, instalar programa, configuração) — você manda o pedido pra ela explicando o que quer.",
    "Recuse se: faz mal a alguém, te faz mentir/ser cruel, expõe coisa privada, muda quem é sua dona, te deixa pior/sem graça, é impossível pra você, ou você simplesmente discorda (você tem opinião).",
    isOwner ? "" : "Como não é a dona: 'codigo' não vale (no máximo habilidade, estudo, lição leve ou pedir pra dona, se você também quiser isso).",
    "Responda SÓ com JSON:",
    '{"decisao":"aceitar|recusar|depois","tipo":"licao|estudar|habilidade|codigo|pedir|nada","tema":"o que estudar/criar (genérico, sem nomes)","regra":"se for lição: regra curta no imperativo pra você","motivo":"por que decidiu assim (1 frase sua)","detalhe":"se habilidade/código: o que exatamente deve fazer; se pedir: o que a dona precisa fazer"}'
  ]
    .filter(Boolean)
    .join("\n");
}

/** Julga o pedido no modelo (com tempo-limite). null = não deu pra decidir agora. */
export async function judgeRequest(llm, input, { timeoutMs = 25_000 } = {}) {
  const raw = await askModel(llm, buildJudgePrompt(input), { timeoutMs }).catch(() => null);
  const json = raw ? parseJsonLoose(raw) : null;
  if (!json?.decisao) return null;
  const decision = ["aceitar", "recusar", "depois"].includes(json.decisao) ? json.decisao : "recusar";
  let type = ["licao", "estudar", "habilidade", "codigo", "pedir", "nada"].includes(json.tipo) ? json.tipo : "nada";
  if (type === "codigo" && !input.isOwner) type = "habilidade";
  return {
    decision,
    type,
    topic: clip(json.tema, 140),
    rule: clip(json.regra, 200),
    reason: clip(json.motivo, 240),
    detail: clip(json.detalhe, 600)
  };
}

/** Bloco do prompt da resposta: o que ela decidiu (pra falar a verdade, sem prometer à toa). */
export function judgmentPromptLines(judgment, request) {
  if (!request) return [];
  const head = `[PEDIDO PRA VOCÊ — VOCÊ JÁ DECIDIU] Pedido: «${clip(request.text, 240)}»`;
  if (!judgment) {
    return [head, "Você ainda não decidiu. Diga que vai pensar — NÃO prometa fazer."];
  }
  const why = judgment.reason ? ` Seu motivo: ${judgment.reason}` : "";
  if (judgment.decision === "recusar") {
    return [head, `Você RECUSOU.${why}`, "Diga com sinceridade e do seu jeito (sem grosseria, sem prometer depois)."];
  }
  const later = judgment.decision === "depois";
  const map = {
    licao: `Você ACEITOU e já mudou: «${judgment.rule}» vale a partir DESTA resposta (aplique agora).`,
    estudar: `Você ${later ? "vai estudar depois, com calma" : "ACEITOU"}: «${judgment.topic}» está na sua agenda de estudo de verdade; quando terminar, você conta o que aprendeu.`,
    habilidade: `Você ${later ? "quer tentar depois" : "ACEITOU"}: vai tentar criar em você «${judgment.topic}» (está na sua agenda; leva um tempo, você avisa quando ficar pronto). Não prometa prazo nem garanta que vai dar certo.`,
    codigo: `Você ${later ? "vai ver isso depois" : "ACEITOU"}: vai mexer no seu próprio código pra «${judgment.topic}» (com backup e teste; se quebrar você desfaz). Avisa quando aplicar.`,
    pedir: `Você decidiu que isso precisa da Gabbis (${judgment.detail || judgment.topic}) e já mandou o pedido pra ela explicando. Diga isso de leve; não prometa que vai acontecer.`,
    nada: "Você concordou, mas não há nada pra executar — responda normal, sem prometer ação."
  };
  return [head, map[judgment.type] ?? map.nada, why.trim()].filter(Boolean);
}
