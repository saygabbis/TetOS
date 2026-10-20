import { formatArtifactsLines } from "./automateRunsContext.js";

/** O que a Teto recebe quando uma tarefa que ela pediu ao AutoMate termina (não é fala do usuário). */
export function buildAutomateOutcomePrompt({ status, output, error, intent, artifacts, fromUser = false }) {
  const done = status === "completed";
  const who = fromUser ? "que o usuário pediu direto ao AutoMate (@automate)" : "que você pediu ao AutoMate";
  return [
    "[EVENTO DO SISTEMA — resultado do AutoMate]",
    `A tarefa ${who} no computador do usuário${intent ? ` («${intent}»)` : ""} ${done ? "foi CONCLUÍDA" : "FALHOU"}.`,
    error ? `Erro informado: ${error.slice(0, 600)}` : "",
    output ? `Resposta do AutoMate:\n${output.slice(0, 3000)}` : "(o AutoMate não devolveu texto)",
    ...formatArtifactsLines(artifacts),
    "",
    "Agora explique ao usuário, com suas palavras e no seu jeito, o que aconteceu:",
    done
      ? "- diga o resultado de forma clara e curta (o que foi feito, onde ficou). Se o AutoMate citou arquivos com caminho completo, mencione-os como link [nome](file:///…)."
      : "- explique o motivo da falha em linguagem simples (sem culpar ninguém) e o que ele pode fazer agora.",
    "- Isto NÃO é uma mensagem do usuário: não agradeça nem responda como se ele tivesse escrito.",
    "- NÃO dispare novas tarefas no computador por conta própria; se valer a pena tentar de novo, pergunte antes.",
  ]
    .filter(Boolean)
    .join("\n");
}
