/**
 * O que a Teto sabe sobre os PCs do usuário (o hub manda no `ready`/`devices` e avisa em `presence`) e sobre o que o
 * AutoMate faz. Fica em memória: é o estado atual, não histórico.
 */

/** @type {Map<string, { id: string, name: string, online: boolean, profile: string | null, platform: string | null, capabilities: object | null }>} */
const devices = new Map();

const OS_LABEL = { win32: "Windows", darwin: "macOS", linux: "Linux" };
const PROFILE_LABEL = {
  delegate: "recebe tarefas inteiras",
  direct: "só ferramentas avulsas",
  full: "tarefas inteiras e ferramentas avulsas",
};

function str(v, max = 80) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** Substitui a lista (frame `ready`/`devices` do hub). */
export function setAutomateDevices(list) {
  devices.clear();
  if (!Array.isArray(list)) return;
  for (const d of list) {
    if (!d || typeof d.id !== "string") continue;
    devices.set(d.id, {
      id: d.id,
      name: str(d.name) || d.id,
      online: d.online !== false,
      profile: str(d.profile, 20) || null,
      platform: str(d.platform, 20) || null,
      capabilities: d.capabilities && typeof d.capabilities === "object" ? d.capabilities : null,
    });
  }
}

/** Um PC ligou ou desligou (frame `presence`). */
export function setAutomateDevicePresence(deviceId, online) {
  const known = devices.get(deviceId);
  if (known) devices.set(deviceId, { ...known, online: Boolean(online) });
}

export function listAutomateDevices() {
  return [...devices.values()];
}

/** Descrição curta do que o AutoMate faz (vale para qualquer canal). */
export const AUTOMATE_ABILITIES =
  "O AutoMate opera o computador do usuário: abre e usa apps e sites, clica e digita, lê a tela, mexe em arquivos, planilhas e documentos e roda automações, uma tarefa por vez em cada PC. Durante a tarefa ele pode perguntar algo ao usuário no app (escolhas com «Outro» ou texto), pedir vários dados num formulário (email, CPF, endereço…) e, para senha, 2FA, login ou CAPTCHA, pedir que o usuário faça e confirme — ele nunca pede senha. No fim mostra o resultado (texto, arquivos, prints) no cartão da tarefa, e você recebe esse resultado para explicar ao usuário.";

/** Bloco de prompt com o que o AutoMate faz e os PCs ligados (vazio sem PCs conhecidos). */
export function formatAutomateCapabilitiesBlock(list = listAutomateDevices()) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const online = list.filter((d) => d.online);
  const lines = online.map((d) => {
    const os = d.platform ? OS_LABEL[d.platform] ?? d.platform : "sistema não informado";
    const caps = d.capabilities;
    const noScreen = caps && (caps.gui === false || caps.screen === false || caps.display === "none");
    const profile = d.profile ? `; ${PROFILE_LABEL[d.profile] ?? d.profile}` : "";
    return `- "${d.name}": ${os}${profile}${noScreen ? "; sem interface gráfica: só terminal, arquivos e rede" : ""}`;
  });
  return [
    "[AUTOMATE — O QUE ELE FAZ]",
    AUTOMATE_ABILITIES,
    online.length
      ? "PCs ligados agora:"
      : "Nenhum PC com AutoMate está ligado agora: não prometa ação no computador; diga que o AutoMate está desligado.",
    ...lines,
  ];
}
