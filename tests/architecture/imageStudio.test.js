import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ImageCostStats,
  PendingImageRequests,
  estimateImage,
  formatImageEstimate,
  imageUsageUsd,
  parseImageArgs
} from "../../src/core/media/imageStudio.js";
import { ImageGenerationService } from "../../src/core/media/imageGenerationService.js";
import { startImageCommand, takeImageConfirmation } from "../../src/core/media/imageCommands.js";
import { stripHdWords, wantsHdImage } from "../../src/core/media/imageGenerationIntent.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";
import { slashToCommand } from "../../src/integrations/discord/discordCommands.js";

describe("imagem: opções, custo e estimativa", () => {
  it("lê qualidade/formato só no começo", () => {
    expect(parseImageArgs(["ultra", "16:9", "2k", "cidade", "flutuante"])).toMatchObject({ quality: "xhigh", aspect: "16:9", big: true, size: "2560x1440", prompt: "cidade flutuante" });
    expect(parseImageArgs(["gato", "em", "alta", "montanha"])).toMatchObject({ quality: null, size: "1024x1024", prompt: "gato em alta montanha" });
    expect(parseImageArgs(["9:16", "teto"]).size).toBe("864x1536");
  });

  it("custo pelo usage real (medido: flare low 824 tokens, sunburst high 1756)", () => {
    const low = imageUsageUsd("gpt-image-2.6-flare", { input_tokens: 24, input_tokens_details: { text_tokens: 24, image_tokens: 0 }, output_tokens: 824 });
    const high = imageUsageUsd("gpt-image-2.6-sunburst", { input_tokens: 24, input_tokens_details: { text_tokens: 24, image_tokens: 0 }, output_tokens: 1756 });
    expect(low).toBeCloseTo(0.0248, 3);
    expect(high).toBeCloseTo(0.0528, 3);
  });

  it("estimativa escala com resolução e aprende com o uso real", () => {
    const stats = new ImageCostStats({ path: join(mkdtempSync(join(tmpdir(), "img-")), "s.json") });
    const base = estimateImage({ model: "gpt-image-2.6-sunburst", quality: "high", size: "1024x1024", stats });
    const big = estimateImage({ model: "gpt-image-2.6-sunburst", quality: "high", size: "2048x2048", stats });
    expect(base.outputTokens).toBe(1756);
    expect(big.outputTokens).toBe(1756 * 4);
    expect(base.learned).toBe(false);
    stats.observe({ model: "gpt-image-2.6-sunburst", quality: "high", size: "1024x1024", usage: { output_tokens: 2000 }, seconds: 30 });
    const after = estimateImage({ model: "gpt-image-2.6-sunburst", quality: "high", size: "1024x1024", stats });
    expect(after.learned).toBe(true);
    expect(after.outputTokens).toBe(2000);
  });

  it("texto da estimativa pede sim e mostra US$/R$", () => {
    const plan = { edit: false, modelLabel: "GPT Image 2.6 Sunburst", quality: "high", size: "1024x1024", inputImages: 0, estimate: { outputTokens: 1756, inputTokens: 30, usd: 0.053, seconds: 34, learned: true } };
    const text = formatImageEstimate(plan, { brlRate: 5.5 });
    expect(text).toMatch(/US\$ 0,053/);
    expect(text).toMatch(/R\$ 0,29/);
    expect(text).toMatch(/sim/);
  });
});

describe("confirmação do modo bom", () => {
  it("sim confirma, não cancela, outra coisa deixa pendente, expira", () => {
    let now = 0;
    const p = new PendingImageRequests({ ttlMs: 1000, now: () => now });
    p.set("k", { prompt: "x" });
    expect(p.handleReply("k", "e aí?")).toBeNull();
    expect(p.handleReply("k", "sim!")).toEqual({ confirm: { prompt: "x" } });
    p.set("k", { prompt: "y" });
    expect(p.handleReply("k", "não")).toEqual({ cancel: { prompt: "y" } });
    p.set("k", { prompt: "z" });
    now = 5000;
    expect(p.handleReply("k", "sim")).toBeNull();
  });

  const service = () => new ImageGenerationService({ provider: "openai", openai: { apiKey: "teste" } });

  it(".gerarhd da dona guarda o pedido e responde a estimativa, sem gastar", async () => {
    const svc = service();
    const run = vi.spyOn(svc, "runPlan");
    const out = await startImageCommand("gerarhd", ["ultra", "gato"], { service: svc, isOwner: true, pendingKey: "k" });
    expect(out.pending).toBe(true);
    expect(out.text).toMatch(/Sunburst/);
    expect(run).not.toHaveBeenCalled();
    const answer = takeImageConfirmation("pode", { service: svc, pendingKey: "k" });
    expect(answer.plan).toMatchObject({ tier: "hd", model: "gpt-image-2.6-sunburst", quality: "xhigh", prompt: "gato" });
  });

  it("quem não é a dona cai no econômico", async () => {
    const svc = service();
    vi.spyOn(svc, "generate").mockResolvedValue({ ok: true, buffer: Buffer.from("x"), filePath: "/tmp/x.png" });
    const out = await startImageCommand("gerarhd", ["gato"], { service: svc, isOwner: false, pendingKey: "k" });
    expect(svc.generate).toHaveBeenCalled();
    expect(out.caption).toMatch(/econômico/);
    expect(svc.pending.peek("k")).toBeNull();
  });

  it(".editar sem imagem pede a imagem; econômico usa o Flare", async () => {
    const svc = service();
    expect((await startImageCommand("editar", ["fundo", "roxo"], { service: svc, pendingKey: "k" })).text).toMatch(/imagem/);
    const plan = svc.plan({ tier: "eco", prompt: "x", images: ["/a.png"] });
    expect(plan).toMatchObject({ model: "gpt-image-2.6-flare", quality: "low", edit: true });
  });
});

describe("IA pedindo imagem caprichada", () => {
  it("ações viram comandos do modo bom/edição", () => {
    const actions = parseActionCommands(`gerarImagemHD("teto no espaço", "ultra", "16:9")\neditarImagem("3EB0ABCDEF123456", "fundo de praia")`);
    expect(actions).toEqual([
      { type: "run_command", text: ".gerarhd ultra 16:9 teto no espaço" },
      { type: "run_command", text: ".editar 3EB0ABCDEF123456 fundo de praia" }
    ]);
  });

  it("pedido natural em alta qualidade", () => {
    expect(wantsHdImage("teto na praia em alta qualidade")).toBe(true);
    expect(wantsHdImage("um hd externo")).toBe(false);
    expect(stripHdWords("dragão em 4k no modelo bom")).toBe("dragão");
  });

  it("slash /gerar e /editar no Discord", () => {
    const opt = (v) => ({ getString: (k) => v[k] ?? null, getBoolean: (k) => v[k] ?? null, getNumber: () => null, getInteger: () => null });
    expect(slashToCommand("gerar", opt({ descricao: "gato" }))).toEqual({ command: "gerar", args: ["gato"] });
    expect(slashToCommand("gerar", opt({ descricao: "gato", modo: "ultra", formato: "16:9", "2k": true }))).toEqual({ command: "gerarhd", args: ["ultra", "16:9", "2k", "gato"] });
    expect(slashToCommand("editar", opt({ pedido: "fundo roxo", modo: "alta" }))).toEqual({ command: "editarhd", args: ["alta", "fundo roxo"] });
  });
});
