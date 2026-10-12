import { describe, expect, it } from "vitest";
import {
  formatAutomateCapabilitiesBlock,
  listAutomateDevices,
  setAutomateDevicePresence,
  setAutomateDevices,
} from "../../src/integrations/automate/automateCapabilities.js";
import { formatActiveRunsBlock, formatAutomateRunsBlock } from "../../src/integrations/automate/automateRunsContext.js";

describe("o que a Teto sabe do AutoMate", () => {
  it("lista os PCs ligados com sistema, perfil e se têm tela; presença atualiza", () => {
    setAutomateDevices([
      { id: "a", name: "Casa", online: true, profile: "delegate", platform: "win32", capabilities: { gui: true, screen: true } },
      { id: "b", name: "Servidor", online: true, profile: "full", platform: "linux", capabilities: { display: "none", gui: false } },
      { id: "c", name: "Notebook", online: false, profile: "delegate", platform: "darwin" },
    ]);
    const block = formatAutomateCapabilitiesBlock().join("\n");
    expect(block).toContain("[AUTOMATE — O QUE ELE FAZ]");
    expect(block).toContain("nunca pede senha");
    expect(block).toContain('- "Casa": Windows; recebe tarefas inteiras');
    expect(block).toContain('- "Servidor": Linux; tarefas inteiras e ferramentas avulsas; sem interface gráfica');
    expect(block).not.toContain("Notebook");

    setAutomateDevicePresence("c", true);
    expect(formatAutomateCapabilitiesBlock().join("\n")).toContain('- "Notebook": macOS');
    setAutomateDevicePresence("a", false);
    setAutomateDevicePresence("b", false);
    setAutomateDevicePresence("c", false);
    expect(formatAutomateCapabilitiesBlock().join("\n")).toContain("Nenhum PC com AutoMate está ligado agora");
    setAutomateDevices([]);
    expect(listAutomateDevices()).toEqual([]);
    expect(formatAutomateCapabilitiesBlock()).toEqual([]);
  });

  it("execuções: resposta das que terminaram e o que roda em outras conversas", () => {
    const runs = formatAutomateRunsBlock([
      { title: "exporta", status: "completed", deviceName: "Casa", startedAt: "2026-01-10T17:00:00Z", endedAt: "2026-01-10T17:05:00Z", output: "Salvei   em C:/x.pdf" },
    ]).join("\n");
    expect(runs).toContain("— respondeu: Salvei em C:/x.pdf");
    const active = formatActiveRunsBlock([{ title: "baixa notas", status: "running", deviceName: "Casa", startedAt: "2026-01-10T17:00:00Z", threadId: "t2" }]).join("\n");
    expect(active).toContain("[RODANDO AGORA EM OUTRAS CONVERSAS]");
    expect(active).toContain("- «baixa notas» — em andamento no PC \"Casa\"");
    expect(formatActiveRunsBlock(undefined)).toEqual([]);
  });
});
