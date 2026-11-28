import { describe, expect, it, vi } from "vitest";
import { CALL_JOIN_RE, CALL_LEAVE_RE, spokenFromActions } from "../../src/integrations/discord/discordVoiceCall.js";
import { attachWhatsAppCallHandler } from "../../src/integrations/whatsapp/actions/waCalls.js";
import { parseActionCommands } from "../../src/modules/chat/chatService.js";

describe("call do Discord", () => {
  it("entende pedido de entrar e sair", () => {
    expect(CALL_JOIN_RE.test("teto entra na call")).toBe(true);
    expect(CALL_JOIN_RE.test("vem pro voice teto")).toBe(true);
    expect(CALL_JOIN_RE.test("bora call?")).toBe(true);
    expect(CALL_JOIN_RE.test("que voz bonita")).toBe(false);
    expect(CALL_LEAVE_RE.test("teto sai da call")).toBe(true);
  });

  it("fala o texto das mensagens e áudios, ignora o resto", () => {
    const s = spokenFromActions([
      { type: "message", text: "oii" },
      { type: "sticker", key: "x" },
      { type: "voice", text: "tudo bem?" }
    ]);
    expect(s).toBe("oii. tudo bem?");
  });

  it("call(\"entrar\") vira ação de call", () => {
    const actions = parseActionCommands('call("entrar")\nmensagem("bora!")');
    expect(actions.some((a) => a.type === "voice_call" && a.op === "join")).toBe(true);
    const out = parseActionCommands('call("sair")');
    expect(out.some((a) => a.type === "voice_call" && a.op === "leave")).toBe(true);
  });
});

describe("ligação no zap", () => {
  function setup({ mode = "online", owner = true } = {}) {
    const handlers = {};
    const socket = {
      ev: { on: (ev, fn) => (handlers[ev] = fn) },
      rejectCall: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {})
    };
    const runtime = {
      defaults: { ownerJids: owner ? ["5511999999999@s.whatsapp.net"] : [] },
      ownerIdentityIds: owner ? ["dm-5511999999999"] : [],
      tetoActivation: { isDmActive: () => true },
      brainOrchestrator: { life: { availability: () => ({ mode }) } },
      voiceNotes: null
    };
    vi.useFakeTimers();
    attachWhatsAppCallHandler(socket, runtime, { log: { log() {}, warn() {} }, random: () => 0 });
    return { socket, fire: async (call) => { const p = handlers.call([call]); await vi.advanceTimersByTimeAsync(8000); await p; } };
  }

  it("recusa e responde; insistiu = outra resposta", async () => {
    const { socket, fire } = setup();
    const call = { id: "c1", from: "5511888888888@s.whatsapp.net", status: "offer" };
    await fire(call);
    expect(socket.rejectCall).toHaveBeenCalledWith("c1", call.from);
    expect(socket.sendMessage).toHaveBeenCalledTimes(1);
    const first = socket.sendMessage.mock.calls[0][1].text;
    await fire({ ...call, id: "c2" });
    const second = socket.sendMessage.mock.calls[1][1].text;
    expect(second).not.toBe(first);
    vi.useRealTimers();
  });

  it("ligação de grupo: só recusa", async () => {
    const { socket, fire } = setup();
    await fire({ id: "g", from: "123@g.us", status: "offer", isGroup: true });
    expect(socket.rejectCall).toHaveBeenCalled();
    expect(socket.sendMessage).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
