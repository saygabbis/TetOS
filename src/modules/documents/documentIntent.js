export function detectDocumentIntent(text) {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) return null;

  const readMatch = lower.match(
    /(?<![\p{L}])(l[eê]|leia|ler|abre|abrir|mostra|mostrar|ver|v[eê]|resume|resumir|resuma)\s+(?:pra mim\s+)?(?:o\s+|a\s+)?(?:documento|arquivo|nota)\s+([\p{L}\p{N}._-]+)/iu
  );
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
