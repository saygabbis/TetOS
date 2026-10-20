import { describe, expect, it } from "vitest";
import { cleanTranscript, resolveWhisperModelId } from "../../src/modules/audio/audioTranscriber.js";

describe("transcrição de áudio", () => {
  it("mantém fala normal", () => {
    expect(cleanTranscript(" Oi Teto!  Tudo bem? ")).toBe("Oi Teto! Tudo bem?");
  });
  it("descarta alucinação de silêncio do Whisper", () => {
    for (const t of ["Legendas pela comunidade Amara.org", "Obrigado por assistir!", "[Música]", "...", "Ooooo", "Hmmm"]) {
      expect(cleanTranscript(t)).toBe("");
    }
  });
  it("corta repetição sem fim", () => {
    expect(cleanTranscript("kkkkkkkkkkkkkkkkkkkkkk que isso")).toBe("kkkk que isso");
    expect(cleanTranscript("não não não não não não sei")).toBe("não não sei");
  });
  it("aceita nome curto ou id do Hugging Face", () => {
    expect(resolveWhisperModelId("small")).toBe("onnx-community/whisper-small");
    expect(resolveWhisperModelId("onnx-community/whisper-large-v3-turbo")).toBe("onnx-community/whisper-large-v3-turbo");
  });
});
