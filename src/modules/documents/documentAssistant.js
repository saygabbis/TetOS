export function buildDocumentAssistance(document, instruction) {
  const docId = document?.id ?? "desconhecido";
  const preview = String(document?.content ?? "").slice(0, 1200);
  return [
    `Documento alvo: ${docId}`,
    `Instrução solicitada: ${instruction}`,
    "Trecho atual do documento:",
    preview || "(vazio)"
  ].join("\n");
}
