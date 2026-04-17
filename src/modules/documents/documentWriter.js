import { buildDocumentAssistance } from "./documentAssistant.js";

export class DocumentWriter {
  constructor({ store, brain } = {}) {
    this.store = store;
    this.brain = brain;
  }

  async assistWrite(id, instruction) {
    const current = this.store.read(id) ?? { id, content: "" };
    const assistance = buildDocumentAssistance(current, instruction);

    if (!this.brain) {
      return {
        document: this.store.write(id, `${String(current.content ?? "").trim()}\n${instruction}`.trim()),
        mode: "append-fallback"
      };
    }

    const prompt = [
      "Você vai atualizar um documento local.",
      "Reescreva o documento inteiro com base na instrução abaixo.",
      "Mantenha coerência, preserve conteúdo útil existente e aplique só o necessário.",
      "Responda apenas com o conteúdo final do documento, sem explicações.",
      assistance
    ].join("\n\n");

    const output = await this.brain.generate(prompt);
    const document = this.store.write(id, String(output ?? "").trim());
    return { document, mode: "model-assisted" };
  }
}
