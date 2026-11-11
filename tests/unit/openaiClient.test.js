import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAIClient, OpenAIBudgetError, extractOutputText } from "../../src/core/brain/openaiClient.js";
import { OpenAIUsageMeter, costOf } from "../../src/core/brain/openaiUsage.js";
import { SearchAdapter } from "../../src/modules/web/searchAdapter.js";

const okResponse = (text, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: "gpt-6-luna",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text, annotations: extra.annotations ?? [] }] }],
    usage: { input_tokens: 1000, output_tokens: 200, input_tokens_details: { cached_tokens: 0 } },
    ...extra.data
  })
});

const meter = () => new OpenAIUsageMeter({ path: "", dailyBudgetUsd: 0.01 });

afterEach(() => vi.unstubAllGlobals());

describe("OpenAIClient", () => {
  it("manda pra /responses com raciocínio e folga de tokens, e lê o texto", async () => {
    const fetchMock = vi.fn(async () => okResponse("oii"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIClient({ apiKey: "k", numPredict: 400, reasoningEffort: "low", usage: meter() });
    expect(await client.generate("fala")).toBe("oii");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("gpt-6-luna");
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_output_tokens).toBeGreaterThan(400);
    expect(body.temperature).toBeUndefined();
    expect(body.store).toBe(false);
  });

  it("sem raciocínio manda temperature; se o modelo recusar, tira e repete", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => '{"error":{"message":"Unsupported parameter: temperature"}}' })
      .mockResolvedValueOnce(okResponse("beleza"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIClient({ apiKey: "k", reasoningEffort: "none", temperature: 0.7 });
    expect(await client.generate("x")).toBe("beleza");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0.7);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).temperature).toBeUndefined();
  });

  it("resposta incompleta (só raciocinou) tenta de novo com mais espaço", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] })
      })
      .mockResolvedValueOnce(okResponse("pronto"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIClient({ apiKey: "k", numPredict: 100, reasoningEffort: "none" });
    expect(await client.generate("x")).toBe("pronto");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_output_tokens).toBe(400);
  });

  it("imagens locais viram input_image na última mensagem do usuário", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tetos-oai-"));
    const img = join(dir, "a.png");
    writeFileSync(img, Buffer.from([1, 2, 3]));
    const fetchMock = vi.fn(async () => okResponse("um gato"));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OpenAIClient({ apiKey: "k" });
    expect(await client.chat([{ role: "system", content: "descreva" }, { role: "user", content: "o que é?" }], { imagePaths: [img] })).toBe("um gato");
    const input = JSON.parse(fetchMock.mock.calls[0][1].body).input;
    expect(input[0].role).toBe("developer");
    expect(input[1].content[1]).toMatchObject({ type: "input_image", image_url: "data:image/png;base64,AQID" });
  });

  it("tarefa de fundo para no teto diário; conversa continua", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse("ok")));
    const usage = meter();
    usage.add(0.02, "mente");
    const worker = new OpenAIClient({ apiKey: "k", usage });
    const chat = new OpenAIClient({ apiKey: "k", usage, critical: true });
    await expect(worker.generate("x")).rejects.toBeInstanceOf(OpenAIBudgetError);
    expect(await chat.generate("x")).toBe("ok");
  });

  it("stream junta os deltas", async () => {
    const sse = [
      'data: {"type":"response.output_text.delta","delta":"oi "}',
      'data: {"type":"response.output_text.delta","delta":"tudo bem?"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
      ""
    ].join("\n");
    const body = new Response(sse).body;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body })));
    const chunks = [];
    const client = new OpenAIClient({ apiKey: "k" });
    expect(await client.generateStream("x", (c) => chunks.push(c))).toBe("oi tudo bem?");
    expect(chunks).toEqual(["oi ", "tudo bem?"]);
  });

  it("busca na web devolve os links citados", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse("Choveu ontem.", { annotations: [{ type: "url_citation", url: "https://g1.globo.com/x", title: "G1" }] })
      )
    );
    const adapter = new SearchAdapter({ backend: "openai", openai: new OpenAIClient({ apiKey: "k" }) });
    const results = await adapter.search("chuva sp");
    expect(results[0]).toMatchObject({ url: "https://g1.globo.com/x", title: "G1" });
    expect(results[0].snippet).toContain("Choveu");
  });
});

describe("custo", () => {
  it("calcula pelo preço do gpt-6-luna", () => {
    expect(costOf("gpt-6-luna", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6, 5);
    expect(extractOutputText({ output_text: "a" })).toBe("a");
  });
});
