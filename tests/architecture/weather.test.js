import { describe, expect, it } from "vitest";
import { detectWeatherQuestion, formatWeatherForPrompt } from "../../src/modules/web/weather.js";

describe("clima", () => {
  it("entende pergunta de tempo e a cidade", () => {
    expect(detectWeatherQuestion("teto vai chover amanhã em Ribeirão Preto?")).toEqual({ city: "Ribeirão Preto", tomorrow: true });
    expect(detectWeatherQuestion("tá frio aí?")).toEqual({ city: null, tomorrow: false });
    expect(detectWeatherQuestion("faz tempo que não te vejo")).toBeNull();
  });
  it("monta o bloco com os dados", () => {
    const block = formatWeatherForPrompt({ place: "São Paulo, SP", now: { temp: 22, feels: 21, sky: "nublado", rain: 0 }, days: [{ min: 16, max: 25, sky: "nublado", rainChance: 30 }, { min: 15, max: 20, sky: "chuva", rainChance: 90 }] }, { tomorrow: true });
    expect(block).toContain("Agora: 22°C");
    expect(block).toContain("Amanhã: 15–20°C, chuva, 90%");
  });
});
