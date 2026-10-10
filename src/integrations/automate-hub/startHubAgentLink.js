import { readHubAgentConfig } from "./hubAgentConfig.js";
import { createUiHubDispatcher } from "./uiHubDispatch.js";
import { createHubAgentLink } from "./hubAgentLink.js";

/** Inicia o cliente outbound do AutoMate Hub quando as variáveis de ambiente estão definidas. */
export function startHubAgentLinkIfConfigured({
  uiBus,
  dispatchBaseUrl,
  WebSocketImpl,
  onLog,
  onError,
}) {
  const config = readHubAgentConfig();
  if (!config) {
    return null;
  }

  const dispatchUiRequest = createUiHubDispatcher(dispatchBaseUrl);
  const link = createHubAgentLink({
    config,
    dispatchUiRequest,
    uiBus,
    WebSocketImpl,
    onLog,
    onError,
  });

  if (link) {
    const log = onLog ?? console.log;
    log(`[hub-agent] conectando a ${config.url} (id=${config.agentId})`);
  }

  return link;
}
