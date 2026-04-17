export function buildDocumentContextPayload(intent, documentModule) {
  if (!intent || !documentModule) return null;

  if (intent.type === "list") {
    return {
      kind: "list",
      text: documentModule.list().map((doc) => `- ${doc.id}`).join("\n")
    };
  }

  if (intent.type === "read") {
    const document = documentModule.read(intent.id);
    return {
      kind: "read",
      text: document?.content ?? null,
      document
    };
  }

  if (intent.type === "write") {
    const document = documentModule.read(intent.id);
    return {
      kind: "write",
      text: `Solicitação de escrita no documento ${intent.id}: ${intent.content}`,
      document
    };
  }

  return null;
}
