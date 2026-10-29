// Mente da Teto ponta a ponta pelo pipeline de verdade (modelo trocado por respostas fixas):
// tom de crise (sem risada/figurinha + CVV no prompt), pedido pra ela virar lição que vale na hora,
// pergunta de fato com pesquisa automática (trecho no prompt) e o que ela estudou entrando no papo.
import "./isolatedData.js";
import { createRuntime } from "../src/app/createRuntime.js";
import { runMessagePipeline } from "../src/core/pipeline/messagePipeline.js";
import { assert, ok } from "./test-helpers.js";

const runtime = createRuntime();
runtime.defaults.replyEnabled = true;
runtime.brainOrchestrator.life.realism = "off";
const prompts = [];
const replies = [];
runtime.agent.brain.generate = async (prompt) => {
  prompts.push(String(prompt));
  return replies.shift() ?? 'mensagem("tô aqui")';
};
const mindAnswers = [];
runtime.mind.llm = { generate: async () => mindAnswers.shift() ?? "{}" };
let searched = null;
runtime.searchModule.adapter.search = async (q) => {
  searched = q;
  return [{ url: "https://pt.wikipedia.org/wiki/Silksong", title: "Hollow Knight: Silksong", snippet: "Lançado em 4 de setembro de 2025 pela Team Cherry." }];
};

const send = (message, extra = {}) =>
  runMessagePipeline(runtime, {
    message,
    userId: "dm-555",
    sessionId: "wa-dm:555@s.whatsapp.net",
    channelId: "555@s.whatsapp.net",
    isGroup: false,
    closeDecision: "respond",
    pushName: "Gabbis",
    ...extra
  });

try {
  // 1) Crise: prompt manda acolher (CVV), e mesmo que o modelo ria/mande figurinha, não sai.
  replies.push('sticker("teto-linguinha")\nmensagem("para de falar isso kkkkk")\nmensagem("sério, eu me importo com vc kkk")');
  const crisis = await send("se um dia eu me matar, avisa as pessoas");
  const crisisPrompt = prompts.at(-1);
  assert(/TOM DESTA RESPOSTA — CRISE/.test(crisisPrompt) && /188/.test(crisisPrompt), "crise: prompt com cuidado e CVV");
  assert(crisis.toneRead.kind === "crise", "crise detectada");
  assert(/COMO VOCÊ ESTÁ SE SENTINDO[\s\S]*preocupada/.test(crisisPrompt), "ela fica preocupada (sentimento no prompt)");
  assert(runtime.mind.feelings.mood().label === "preocupada", "humor mudou pra preocupada");
  assert(/Humor: preocupada/.test(crisisPrompt), "linha de humor da rotina segue o sentimento");
  assert(crisis.replies.length && crisis.replies.every((r) => !/k{2,}/i.test(r)), `crise: sem risada (${crisis.replies.join(" | ")})`);
  assert(!(crisis.replies.actions ?? []).some((a) => a.type === "sticker"), "crise: sem figurinha");

  // 2) O tom gruda: logo depois, "desculpa" continua em cuidado.
  replies.push('mensagem("tudo bem kkk")');
  const after = await send("desculpa");
  assert(after.toneRead.kind === "crise" && !/k{2,}/i.test(after.replies.join(" ")), "depois da crise continua sem risada");

  // 3) Pedido pra ela: julga (aceita) e vira lição que já vale nesta resposta e nas próximas.
  mindAnswers.push('{"decisao":"aceitar","tipo":"licao","regra":"Ria só quando algo for engraçado de verdade","motivo":"ela tem razão"}');
  replies.push('mensagem("tá, vou segurar a risada")');
  await send("teto, para de rir de tudo, você ri demais", { pushName: "Gabbis" });
  assert(/já mudou: «Ria só quando/.test(prompts.at(-1)), "prompt sabe que ela aceitou e já mudou");
  replies.push('mensagem("oi")');
  await send("oi de novo");
  assert(/SUAS LIÇÕES[\s\S]*Ria só quando/.test(prompts.at(-1)), "lição dela vale nas próximas respostas");

  // 4) Pergunta de fato: pesquisa sozinha e o trecho do resultado entra no prompt.
  replies.push('mensagem("saiu em setembro de 2025")');
  await send("quando lançou o Silksong?");
  assert(searched && /Silksong/.test(searched), `pesquisou sozinha (${searched})`);
  assert(/\[WEB SEARCH\][\s\S]*setembro de 2025/.test(prompts.at(-1)), "trecho do resultado no prompt");

  // 5) O que ela estudou aparece quando o assunto volta.
  runtime.mind.knowledge.add({ topic: "UTAU", summary: "Programa japonês de síntese de voz onde a Teto nasceu.", facts: ["Lançado em 2008"], keywords: ["utau"] });
  replies.push('mensagem("é onde eu nasci")');
  await send("me fala do utau");
  assert(/JÁ ESTUDOU[\s\S]*síntese de voz/.test(prompts.at(-1)), "conhecimento estudado no prompt");

  // 6) A troca fica registrada pra revisão.
  assert(runtime.mind.turns.turns.length >= 4, "trocas registradas pra autorrevisão");
  ok("mind flow");
  process.exit(0);
} catch (error) {
  console.error(error);
  process.exit(1);
}
