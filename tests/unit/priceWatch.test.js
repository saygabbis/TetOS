import { describe, expect, it } from "vitest";
import {
  brl,
  isAccessory,
  matchScore,
  parseAliexpressSearch,
  parseBuscapeProduct,
  parseBuscapeSearch,
  parseKabumSearch,
  pickRelevant,
  queryVariants
} from "../../src/modules/priceWatch/priceParsing.js";
import { PriceWatch, itemStats, parsePriceWatchCommand } from "../../src/modules/priceWatch/priceWatch.js";

const nextHtml = (data) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;

const QUERY = "impressora 3d resina elegoo saturn 4 ultra";

function ali(id, title, price, original = null) {
  return {
    productId: id,
    title: { displayTitle: title },
    prices: {
      salePrice: { currencyCode: "BRL", minPrice: price },
      ...(original ? { originalPrice: { currencyCode: "BRL", minPrice: original } } : {})
    },
    trade: { tradeDesc: "342  vendido(s)" },
    evaluation: { starRating: 4.6 }
  };
}

const aliHtml = (items) => `<script>window._dida_config_._init_data_= { data: {"x":{"itemList":${JSON.stringify({ content: items })},"y":1}} }</script>`;

describe("leitura dos sites", () => {
  it("Buscapé: oferta solta e página que compara lojas", () => {
    const html = nextHtml({
      props: {
        initialReduxState: {
          hits: {
            hits: [
              { type: "offer", sourceId: "111", name: "Impressora 3D ELEGOO Saturn 4 Ultra", price: 3999.9, merchantName: "Magazine Luiza", url: "/lead?oid=111" },
              { type: "product", sourceId: "222", name: "Elegoo Saturn 4 Ultra 16K", price: 3800, merchantName: "Amazon", storeCount: 5, url: "/impressora-3d/elegoo-saturn-4-ultra?_lc=88" }
            ]
          }
        }
      }
    });
    const [offer, product] = parseBuscapeSearch(html);
    expect(offer).toMatchObject({ key: "buscape:offer:111", store: "Magazine Luiza", price: 3999.9, url: "https://www.buscape.com.br/lead?oid=111" });
    expect(product).toMatchObject({ key: "buscape:product:222", kind: "product", store: "5 lojas no Buscapé (melhor: Amazon)", url: "https://www.buscape.com.br/impressora-3d/elegoo-saturn-4-ultra" });
  });

  it("Buscapé: página do produto traz lojas, histórico de 40 dias e a dica", () => {
    const html = nextHtml({
      props: {
        initialReduxState: {
          offers: {
            currentProductID: "222",
            offerList: [
              { id: "9", name: "Saturn 4 Ultra", price: 3900, merchantId: "1582", sellerName: "Amazon" },
              { id: "8", name: "Saturn 4 Ultra", price: 3800, merchantId: "22905", sellerName: "Magazine Luiza" }
            ]
          },
          priceHistory: { priceHistory: { 222: { days: [{ date: "2026-10-01", price: 3700, merchantId: 22905 }, { date: "2026-10-02", price: 4100, merchantId: 1582 }] } } },
          priceTip: { 222: { priceTip: { description: "GOOD_PRICE", median_price: 3950 } } }
        }
      }
    });
    const page = parseBuscapeProduct(html);
    expect(page.offers.map((o) => o.store)).toEqual(["Magazine Luiza", "Amazon"]);
    expect(page.history).toEqual([
      { date: "2026-10-01", price: 3700, store: "Magazine Luiza" },
      { date: "2026-10-02", price: 4100, store: "Amazon" }
    ]);
    expect(page.tip).toMatchObject({ verdict: "GOOD_PRICE", median: 3950 });
  });

  it("KaBuM: usa o preço no pix e guarda o preço cheio", () => {
    const html = nextHtml({
      props: {
        pageProps: {
          data: JSON.stringify({
            catalogServer: {
              data: [
                { code: 1028132, name: "Impressora 3d Resina Elegoo Saturn 4 Ultra", price: 2946.31, priceWithDiscount: 2798.99, oldPrice: 0, available: true, friendlyName: "saturn-4-ultra" },
                { code: 5, name: "Esgotada", price: 10, available: false }
              ]
            }
          })
        }
      }
    });
    const list = parseKabumSearch(html);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: "kabum:1028132", price: 2798.99, originalPrice: 2946.31, note: "à vista no pix", url: "https://www.kabum.com.br/produto/1028132/saturn-4-ultra" });
  });

  it("AliExpress: preço em real, desconto e aviso de imposto", () => {
    const list = parseAliexpressSearch(aliHtml([ali("100", "ELEGOO SATURN 4 ULTRA 16K", 3522.98, 5517.5), ali("101", "Saturn 4 Ultra, envio do Brasil", 3552.18)]));
    expect(list[0]).toMatchObject({ key: "aliexpress:100", price: 3522.98, originalPrice: 5517.5, sold: "342 vendido(s)", rating: 4.6, note: "pode ter imposto de importação" });
    expect(list[1].note).toBe("envio do Brasil");
  });

  it("página quebrada não derruba nada", () => {
    expect(parseBuscapeSearch("<html>nada</html>")).toEqual([]);
    expect(parseKabumSearch("")).toEqual([]);
    expect(parseAliexpressSearch('"itemList":{quebrado')).toEqual([]);
    expect(parseBuscapeProduct("<html></html>")).toBeNull();
  });
});

describe("o que é parecido", () => {
  it("marca/modelo pesam mais que a categoria; tradução do AliExpress conta", () => {
    expect(matchScore(QUERY, "ELEGOO Saturn 4 Ultra 16K")).toBeGreaterThan(0.7);
    expect(matchScore(QUERY, "Impressora 3D de resina ELEGOO Saturno 4 Ultra")).toBe(1);
    expect(matchScore(QUERY, "Impressora 3D resina Anycubic Photon Mono")).toBeLessThan(0.5);
    expect(matchScore("iphone 16 128gb", "iPhone 16 Plus 128GB")).toBeLessThan(0.85);
    expect(matchScore("iphone 16 128gb", "iPhone 16 128GB Preto")).toBe(1);
  });

  it("peça/acessório fica de fora, a não ser que pediram peça", () => {
    expect(isAccessory(QUERY, "6 PCS Filme FEP para ELEGOO Saturn 4 Ultra")).toBe(true);
    expect(isAccessory(QUERY, "Tanque de resina de metal para Saturn 4 Ultra")).toBe(true);
    expect(isAccessory("filme fep saturn 4 ultra", "6 PCS Filme FEP para ELEGOO Saturn 4 Ultra")).toBe(false);
    expect(isAccessory(QUERY, "ELEGOO SATURN 4 ULTRA 16K com tela LCD de 10 polegadas")).toBe(false);
  });

  it("busca curta só com marca/modelo", () => {
    expect(queryVariants(QUERY)).toEqual(["impressora 3d resina elegoo saturn 4 ultra", "elegoo saturn 4 ultra"]);
  });

  it("escolhe o produto, tira repetido e anúncio barato demais, ordena por parecido e preço", () => {
    const offers = [
      { key: "a", title: "ELEGOO Saturn 4 Ultra 16K", price: 3600 },
      { key: "b", title: "ELEGOO Saturn 4 Ultra 16K", price: 3500 },
      { key: "b", title: "ELEGOO Saturn 4 Ultra 16K", price: 3500 },
      { key: "c", title: "Impressora 3D de resina ELEGOO para Saturno 4 Ultra", price: 291 },
      { key: "d", title: "Filme FEP Saturn 4 Ultra", price: 200 },
      { key: "e", title: "Elegoo Mars 5 Ultra", price: 2600 }
    ];
    expect(pickRelevant(QUERY, offers).map((o) => o.key)).toEqual(["b", "a"]);
  });

  it("usado vai pro fim (com aviso) e página que compara lojas vem antes de oferta solta", () => {
    const offers = [
      { key: "u", title: "Usado: iPhone 16 128GB Verde", price: 3700 },
      { key: "o", title: "iPhone 16 128GB Preto", price: 4100, kind: "offer" },
      { key: "p", title: "iPhone 16 128GB", price: 4958, kind: "product" }
    ];
    const list = pickRelevant("iphone 16 128gb", offers);
    expect(list.map((o) => o.key)).toEqual(["p", "o", "u"]);
    expect(list[2].note).toBe("usado");
    expect(pickRelevant("iphone 16 128gb usado", offers)[0].key).toBe("u");
  });

  it("formata real e reconhece o comando", () => {
    expect(brl(3522.98)).toBe("R$ 3.522,98");
    expect(parsePriceWatchCommand(".monitorarpreco elegoo saturn 4 ultra")).toBe("elegoo saturn 4 ultra");
    expect(parsePriceWatchCommand(".monitorar preço lista")).toBe("lista");
    expect(parsePriceWatchCommand(".monitorarpreco")).toBe("");
    expect(parsePriceWatchCommand("monitorarpreco x")).toBeNull();
  });
});

function fakeSources(results) {
  const calls = [];
  return {
    calls,
    sources: { aliexpress: { label: "AliExpress" } },
    async search(query, opts) {
      calls.push({ query, opts });
      return { offers: typeof results === "function" ? results() : results, errors: [] };
    },
    async buscapeProduct() {
      return null;
    }
  };
}

const offer = (key, title, price, extra = {}) => ({ key, source: "aliexpress", kind: "offer", title, price, store: "AliExpress", url: `https://x/${key}`, ...extra });

describe("monitor", () => {
  const ctx = (extra = {}) => ({ platform: "whatsapp", chatId: "123@g.us", userId: "u1", isGroup: true, ...extra });

  it("busca → opções numeradas → escolhe várias → monitora", async () => {
    let t = Date.parse("2026-11-03T12:00:00Z");
    const results = [offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3522.98, { originalPrice: 5517.5 }), offer("ali:2", "ELEGOO Saturn 4 Ultra 12K", 3027.63), offer("ali:3", "Elegoo Saturn 4 Ultra Combo", 6271.99)];
    const src = fakeSources(results);
    const pw = new PriceWatch({ sources: src, now: () => t });
    const said = [];
    const list = await pw.command(QUERY, ctx({ say: (m) => said.push(m) }));
    expect(said[0]).toContain("procurando");
    expect(list).toContain("*1.*");
    expect(list).toContain("R$ 3.027,63");
    expect(await pw.handleSelection("oi gente", ctx())).toBeNull();
    const done = await pw.handleSelection("1 e 2", ctx({ userId: "u2" }));
    expect(done).toContain("tô monitorando");
    const w = pw.state.watches[0];
    expect(w.items.map((i) => i.key)).toEqual(["ali:2", "ali:1"]);
    expect(w.pool.map((p) => p.key)).toEqual(["ali:3"]);
    expect(await pw.handleSelection("1", ctx())).toBeNull(); // a busca já foi usada
    expect(pw.formatList(ctx())).toContain("menor agora R$ 3.027,63");
  });

  it("avisa quando baixa (menor preço já visto), sumiu e parecido bem mais barato; histórico com datas", async () => {
    let t = Date.parse("2026-11-03T12:00:00Z");
    let offers = [offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3500), offer("ali:9", "ELEGOO Saturn 4 Ultra 16K loja B", 3600)];
    const pw = new PriceWatch({ sources: fakeSources(() => offers), now: () => t, digestHour: -1 });
    const sent = [];
    pw.registerSender("whatsapp", async ({ chatId, text }) => sent.push({ chatId, text }));
    await pw.command(QUERY, ctx());
    await pw.handleSelection("1", ctx());

    t += 4 * 3600_000;
    offers = [offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3290), offer("ali:9", "ELEGOO Saturn 4 Ultra 16K loja B", 3600)];
    await pw.tick();
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe("123@g.us");
    expect(sent[0].text).toContain("▼ baixou");
    expect(sent[0].text).toContain("R$ 3.500,00 → *R$ 3.290,00*");
    expect(sent[0].text).toContain("menor preço que já vi");

    // Sem mudança: não manda nada.
    t += 4 * 3600_000;
    await pw.tick();
    expect(sent).toHaveLength(1);

    // Outra loja parecida bem mais barata (≥ 8%).
    t += 4 * 3600_000;
    offers = [offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3290), offer("ali:9", "ELEGOO Saturn 4 Ultra 16K loja B", 2900)];
    await pw.tick();
    expect(sent.at(-1).text).toContain("achei parecido mais barato");

    // Some da busca 3 vezes seguidas → aviso.
    offers = [offer("ali:9", "ELEGOO Saturn 4 Ultra 16K loja B", 2900)];
    for (let i = 0; i < 3; i++) {
      t += 4 * 3600_000;
      await pw.tick();
    }
    expect(sent.at(-1).text).toContain("sumiu da busca");

    const detail = pw.formatDetail(ctx(), "1");
    expect(detail).toContain("menor: R$ 3.290,00");
    expect(detail).toContain("maior: R$ 3.500,00 (03/11)");
    expect(detail).toContain("-6,0% desde que comecei");
  });

  it("aviso que não saiu fica guardado e vai depois", async () => {
    let t = Date.parse("2026-11-03T12:00:00Z");
    let offers = [offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3500)];
    const pw = new PriceWatch({ sources: fakeSources(() => offers), now: () => t, digestHour: -1, logger: { warn() {} } });
    let online = false;
    const sent = [];
    pw.registerSender("whatsapp", async ({ text }) => {
      if (!online) throw new Error("zap offline");
      sent.push(text);
    });
    await pw.command(QUERY, ctx());
    await pw.handleSelection("todos", ctx());
    t += 4 * 3600_000;
    offers = [offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3300)];
    await pw.tick();
    expect(pw.state.watches[0].outbox).toHaveLength(1);
    online = true;
    t += 60_000;
    await pw.tick();
    expect(sent).toHaveLength(1);
    expect(pw.state.watches[0].outbox).toHaveLength(0);
  });

  it("resumo do dia depois da hora marcada, uma vez por dia", async () => {
    let t = Date.parse("2026-11-03T11:00:00Z"); // 08h em SP
    const pw = new PriceWatch({ sources: fakeSources([offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3500)]), now: () => t, digestHour: 10 });
    const sent = [];
    pw.registerSender("whatsapp", async ({ text }) => sent.push(text));
    await pw.command(QUERY, ctx());
    await pw.handleSelection("1", ctx());
    t = Date.parse("2026-11-04T12:00:00Z"); // 09h do dia seguinte
    await pw.tick();
    expect(sent.filter((s) => s.includes("resumo do dia"))).toHaveLength(0);
    t = Date.parse("2026-11-04T13:30:00Z"); // 10h30
    await pw.tick();
    await pw.tick();
    expect(sent.filter((s) => s.includes("resumo do dia"))).toHaveLength(1);
  });

  it("parar: só o chat dono da monitoração, e para de checar", async () => {
    let t = Date.parse("2026-11-03T12:00:00Z");
    const src = fakeSources([offer("ali:1", "ELEGOO Saturn 4 Ultra 16K", 3500)]);
    const pw = new PriceWatch({ sources: src, now: () => t, digestHour: -1 });
    await pw.command(QUERY, ctx());
    await pw.handleSelection("1", ctx());
    expect(await pw.command("parar 1", ctx({ chatId: "outro@g.us" }))).toBe("não tô monitorando nada aqui");
    expect(await pw.command("parar 1", ctx())).toContain("parei de olhar");
    const before = src.calls.length;
    t += 10 * 3600_000;
    await pw.tick();
    expect(src.calls.length).toBe(before);
    expect(await pw.command("lista", ctx())).toContain("não tô monitorando nada");
  });

  it("estatísticas juntam o histórico do Buscapé com o dela", () => {
    const now = Date.parse("2026-11-03T12:00:00Z");
    const item = {
      price: 3800,
      external: [
        { date: "2026-08-01", price: 4200, store: "Amazon" },
        { date: "2026-09-15", price: 3600, store: "Magazine Luiza" }
      ],
      history: [{ t: "2026-11-01T12:00:00Z", p: 3900 }, { t: "2026-11-03T12:00:00Z", p: 3800 }]
    };
    const st = itemStats(item, now);
    expect(st.lowest).toMatchObject({ price: 3600, store: "Magazine Luiza" });
    expect(st.highest.price).toBe(4200);
    expect(st.windows[30].price).toBe(3800);
    expect(st.windows[90].price).toBe(3600);
    expect(st.changeSinceStart).toBeCloseTo(-2.56, 1);
  });
});
