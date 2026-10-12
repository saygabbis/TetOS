import { describe, expect, it, vi } from "vitest";
import { HubAgentLink } from "../../src/integrations/automate-hub/hubAgentLink.js";

function makeLink() {
  const dispatchUiRequest = vi.fn(async () => ({ status: 202, headers: {}, body: "{}" }));
  const link = new HubAgentLink({
    config: { url: "ws://x/agent-link", agentId: "tetos", token: "t", capabilities: ["chat"] },
    dispatchUiRequest,
    uiBus: { publish: () => undefined, subscribe: () => () => undefined },
    onLog: () => undefined,
    onError: () => undefined,
  });
  return { link, dispatchUiRequest };
}

describe("mensagem do hub com resposta a outra mensagem", () => {
  it("encaminha o replyTo para a conversa (a Teto precisa saber o que o usuário referencia)", async () => {
    const { link, dispatchUiRequest } = makeLink();
    await link.handleHubMessage({
      t: "message",
      threadId: "th1",
      message: { text: "e o segundo?", meta: { replyTo: { id: "m9", role: "assistant", text: "Achei 2 arquivos: a.docx e b.docx" } } },
    });
    expect(dispatchUiRequest).toHaveBeenCalledTimes(1);
    expect(dispatchUiRequest.mock.calls[0][0]).toMatchObject({
      method: "POST",
      path: "/ui/threads/th1/messages",
      body: { text: "e o segundo?", replyTo: { id: "m9", role: "assistant", text: "Achei 2 arquivos: a.docx e b.docx" } },
    });
  });

  it("sem citação não manda replyTo", async () => {
    const { link, dispatchUiRequest } = makeLink();
    await link.handleHubMessage({ t: "message", threadId: "th1", message: { text: "oi" } });
    expect(dispatchUiRequest.mock.calls[0][0].body).toEqual({ text: "oi" });
  });
});
