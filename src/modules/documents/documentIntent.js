export function detectDocumentIntent(text) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  const readMatch = lower.match(/\b(ler|abre|abrir|mostrar|ver)\s+(?:o\s+)?(?:documento|arquivo|nota)\s+([\w.-]+)/i);
  if (readMatch?.[2]) {
    return { type: "read", id: readMatch[2].trim() };
  }

  const writeMatch = raw.match(/\b(?:salva|salvar|escreve|escrever|atualiza|atualizar)\s+(?:no\s+)?(?:documento|arquivo|nota)\s+([\w.-]+)\s*[:\-]\s*([\s\S]+)/i);
  if (writeMatch?.[1] && writeMatch?.[2]) {
    return {
      type: "write",
      id: writeMatch[1].trim(),
      content: writeMatch[2].trim()
    };
  }

  if (/\b(lista|listar|quais)\b.*\b(documentos|arquivos|notas)\b/i.test(lower)) {
    return { type: "list" };
  }

  return null;
}
