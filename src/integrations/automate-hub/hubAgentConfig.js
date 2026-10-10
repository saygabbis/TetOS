const DEFAULT_AGENT_ID = "tetos";
const DEFAULT_CAPABILITIES = ["chat", "rpc"];

/**
 * Configuração do cliente outbound AutoMate Hub (`/agent-link`).
 * Ativo somente quando URL e token estão definidos.
 */
export function readHubAgentConfig(env = process.env) {
  const url = env.TETOS_HUB_AGENT_URL?.trim() ?? "";
  const token = env.TETOS_HUB_AGENT_TOKEN?.trim() ?? "";
  if (!url || !token) {
    return null;
  }

  const agentId = env.TETOS_HUB_AGENT_ID?.trim() || DEFAULT_AGENT_ID;
  const capabilitiesRaw = env.TETOS_HUB_AGENT_CAPABILITIES?.trim();
  const capabilities = capabilitiesRaw
    ? capabilitiesRaw.split(/[,;\s]+/).map((c) => c.trim()).filter(Boolean)
    : DEFAULT_CAPABILITIES;

  const heartbeatMs = Number(env.TETOS_HUB_AGENT_HEARTBEAT_MS ?? 25_000);
  const reconnectMinMs = Number(env.TETOS_HUB_AGENT_RECONNECT_MIN_MS ?? 1_000);
  const reconnectMaxMs = Number(env.TETOS_HUB_AGENT_RECONNECT_MAX_MS ?? 60_000);

  return {
    url,
    agentId,
    token,
    capabilities,
    protocol: 1,
    heartbeatMs: Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : 25_000,
    reconnectMinMs: Number.isFinite(reconnectMinMs) && reconnectMinMs > 0 ? reconnectMinMs : 1_000,
    reconnectMaxMs: Number.isFinite(reconnectMaxMs) && reconnectMaxMs > 0 ? reconnectMaxMs : 60_000,
  };
}
