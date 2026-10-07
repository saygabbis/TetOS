import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUiOutgoingActions } from "../../src/integrations/automate/uiReplies.js";
import { UiMediaService, UiMediaError } from "../../src/integrations/ui/uiMediaService.js";
import { tryHandleUiCommand, autoSaveIncomingStickers } from "../../src/integrations/ui/uiMediaActions.js";
import {
  ingestAttachment,
  isValidUiMediaId,
  resolveThreadMediaRef,
  resolveUiMediaPath,
  saveUiMediaBuffer,
  toMediaRef,
} from "../../src/integrations/ui/uiMediaStore.js";
import { registerUiThreadRoutes } from "../../src/infra/api/routes/uiThreads.js";
import { DeviceRegistry } from "../../src/infra/api/auth/deviceRegistry.js";
import { DeviceGateway } from "../../src/integrations/automate/deviceGateway.js";
import { UiEventBus } from "../../src/core/events/uiEventBus.js";

const TOKEN = "tetos-dev-session";
// PNG 1x1
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tetos-uimedia-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRuntime(extra = {}) {
  return {
    defaults: {
      whatsappMediaPath: join(root, "media"),
      stickersPath: join(root, "stickers"),
      commandMediaDerivedPath: join(root, "derived"),
      commandPrefix: ".",
    },
    ...extra,
  };
}

function makeCtx(service, runtime = makeRuntime()) {
  const published = [];
  const uiBus = { publish: (e) => published.push(e) };
  const thread = { id: "t1", messages: [], updatedAt: null };
  return { ctx: { runtime, service, uiBus, thread, userId: "u1" }, published, thread, uiBus };
}

describe("uiMediaStore", () => {
  it("salva dataUrl e devolve MediaRef com url /ui/media/<id>", () => {
    const dir = join(root, "ui");
    const ref = ingestAttachment({ dataUrl: PNG_DATA_URL, name: "a.png" }, { dir });
    expect(ref.kind).toBe("image");
    expect(ref.url).toBe(`/ui/media/${ref.mediaId}`);
    expect(resolveUiMediaPath(dir, ref.mediaId)).toBeTruthy();
  });

  it("recusa ids com path traversal", () => {
    expect(isValidUiMediaId("../../etc/passwd")).toBe(false);
    expect(isValidUiMediaId("abc-12345678.png")).toBe(true);
    expect(resolveUiMediaPath(join(root, "ui"), "../x.png")).toBeNull();
  });

  it("webp vira figurinha na UI", () => {
    const dir = join(root, "ui");
    const saved = saveUiMediaBuffer(PNG, { dir, mimeType: "image/webp" });
    expect(toMediaRef(saved).kind).toBe("sticker");
  });

  it("resolveThreadMediaRef: id da mensagem, índice e última mídia", () => {
    const thread = {
      messages: [
        { id: "u-1", attachments: [{ mediaId: "a-11111111.png" }, { mediaId: "b-22222222.png" }] },
        { id: "a-1", text: "oi" },
        { id: "u-2", attachments: [{ mediaId: "c-33333333.webp" }] },
      ],
    };
    expect(resolveThreadMediaRef(thread, "u-1").mediaId).toBe("a-11111111.png");
    expect(resolveThreadMediaRef(thread, "u-1#1").mediaId).toBe("b-22222222.png");
    expect(resolveThreadMediaRef(thread, "b-22222222.png").mediaId).toBe("b-22222222.png");
    expect(resolveThreadMediaRef(thread, null).mediaId).toBe("c-33333333.webp");
    expect(resolveThreadMediaRef({ messages: [] }, null)).toBeNull();
  });
});

describe("ações de mídia na UI (paridade com o WhatsApp)", () => {
  it("sticker() do repertório vira bolha com figurinha anexada", async () => {
    const runtime = makeRuntime();
    mkdirSync(runtime.defaults.stickersPath, { recursive: true });
    writeFileSync(join(runtime.defaults.stickersPath, "teto-pao.webp"), PNG);
    const service = new UiMediaService({ runtime });
    const { ctx, published, thread } = makeCtx(service, runtime);

    await applyUiOutgoingActions({
      replies: { actions: [{ type: "message", text: "toma" }, { type: "sticker", key: "teto-pao" }] },
      thread,
      uiBus: ctx.uiBus,
      automateClient: {},
      mediaContext: { runtime, service, userId: "u1" },
    });

    expect(thread.messages).toHaveLength(2);
    const sticker = thread.messages[1];
    expect(sticker.role).toBe("assistant");
    expect(sticker.attachments[0].kind).toBe("sticker");
    expect(sticker.attachments[0].mediaId).toBeTruthy();
    expect(published.filter((e) => e.type === "message.final")).toHaveLength(2);
  });

  it("sem mediaContext, ações de mídia são ignoradas (compatibilidade)", async () => {
    const { thread, uiBus } = makeCtx({});
    await applyUiOutgoingActions({
      replies: { actions: [{ type: "sticker", key: "ack" }] },
      thread,
      uiBus,
      automateClient: {},
    });
    expect(thread.messages).toHaveLength(0);
  });

  it("media/url_download/generate_image chamam o serviço e entregam os anexos", async () => {
    const ref = { kind: "image", mediaId: "a-11111111.png", mimeType: "image/png" };
    const out = { kind: "sticker", mediaId: "b-22222222.webp", mimeType: "image/webp", url: "/ui/media/b-22222222.webp" };
    const service = {
      runMediaCommand: vi.fn(async () => ({ attachments: [out], notes: [] })),
      runUrlDownload: vi.fn(async () => ({ attachments: [out], notes: [] })),
      generateImage: vi.fn(async () => ({ attachments: [out], notes: [] })),
    };
    const { ctx, thread } = makeCtx(service);
    thread.messages.push({ id: "u-1", role: "user", text: "", attachments: [ref] });

    await applyUiOutgoingActions({
      replies: {
        actions: [
          { type: "media", command: "sticker", messageId: "u-1", args: ["10s"] },
          { type: "url_download", command: "youtube", url: "https://youtu.be/x", args: ["mp3"] },
          { type: "generate_image", prompt: "gato", caption: "pronto" },
        ],
      },
      thread,
      uiBus: ctx.uiBus,
      automateClient: {},
      mediaContext: { runtime: ctx.runtime, service, userId: "u1" },
    });

    expect(service.runMediaCommand).toHaveBeenCalledWith({ command: "sticker", args: ["10s"], ref });
    expect(service.runUrlDownload).toHaveBeenCalledWith({ command: "youtube", url: "https://youtu.be/x", args: ["mp3"] });
    expect(service.generateImage).toHaveBeenCalledWith({ prompt: "gato", userId: "u1" });
    const withAttachment = thread.messages.filter((m) => m.role === "assistant" && m.attachments?.length);
    expect(withAttachment).toHaveLength(3);
    expect(thread.messages.some((m) => m.text === "pronto")).toBe(true);
  });

  it("falha vira bolha de texto com a mensagem do erro", async () => {
    const service = {
      runMediaCommand: vi.fn(async () => {
        throw new UiMediaError("O toimg só funciona com figurinhas — use uma figurinha como anexo.");
      }),
    };
    const { ctx, thread } = makeCtx(service);
    await applyUiOutgoingActions({
      replies: { actions: [{ type: "media", command: "toimg", messageId: "x" }] },
      thread,
      uiBus: ctx.uiBus,
      automateClient: {},
      mediaContext: { runtime: ctx.runtime, service, userId: "u1" },
    });
    expect(thread.messages.at(-1).text).toContain("toimg só funciona com figurinhas");
  });

  it("react() marca a última mensagem do usuário", async () => {
    const { ctx, thread, published } = makeCtx({});
    thread.messages.push({ id: "u-1", role: "user", text: "oi" });
    await applyUiOutgoingActions({
      replies: { actions: [{ type: "react", emoji: "❤️" }] },
      thread,
      uiBus: ctx.uiBus,
      automateClient: {},
      mediaContext: { runtime: ctx.runtime, service: {}, userId: "u1" },
    });
    expect(thread.messages[0].meta.reaction).toBe("❤️");
    expect(published.at(-1).type).toBe("message.final");
  });
});

describe("comandos com prefixo digitados na UI", () => {
  it(".sticker usa a mídia anexada na própria mensagem", async () => {
    const ref = { kind: "image", mediaId: "a-11111111.png", mimeType: "image/png" };
    const service = { runMediaCommand: vi.fn(async () => ({ attachments: [], notes: ["ok"] })) };
    const { ctx, thread } = makeCtx(service);
    thread.messages.push({ id: "u-1", role: "user", text: ".sticker 10s", attachments: [ref] });
    const handled = await tryHandleUiCommand(ctx, ".sticker 10s");
    expect(handled).toBe(true);
    expect(service.runMediaCommand).toHaveBeenCalledWith({ command: "sticker", args: ["10s"], ref });
  });

  it("aliases e downloads: .fig / .yt <link> mp3", async () => {
    const service = {
      runMediaCommand: vi.fn(async () => ({ attachments: [], notes: [] })),
      runUrlDownload: vi.fn(async () => ({ attachments: [], notes: [] })),
    };
    const { ctx, thread } = makeCtx(service);
    thread.messages.push({ id: "u-1", role: "user", text: "", attachments: [{ mediaId: "a-11111111.png" }] });
    await tryHandleUiCommand(ctx, ".fig");
    expect(service.runMediaCommand.mock.calls[0][0].command).toBe("sticker");
    await tryHandleUiCommand(ctx, ".yt https://youtu.be/abc mp3");
    expect(service.runUrlDownload).toHaveBeenCalledWith({
      command: "youtube",
      url: "https://youtu.be/abc",
      args: ["mp3"],
    });
  });

  it(".help e .repertorio on/off", async () => {
    const setRepertoireMode = vi.fn();
    const service = { setRepertoireMode, isRepertoireModeOn: () => false };
    const { ctx, thread } = makeCtx(service);
    expect(await tryHandleUiCommand(ctx, ".help")).toBe(true);
    expect(thread.messages.at(-1).text).toContain("Comandos TetOS");
    expect(await tryHandleUiCommand(ctx, ".repertorio on")).toBe(true);
    expect(setRepertoireMode).toHaveBeenCalledWith("u1", true);
    expect(await tryHandleUiCommand(ctx, ".repertorio off")).toBe(true);
    expect(setRepertoireMode).toHaveBeenCalledWith("u1", false);
  });

  it("texto comum e comandos desconhecidos não são interceptados", async () => {
    const { ctx } = makeCtx({});
    expect(await tryHandleUiCommand(ctx, "oi teto")).toBe(false);
    expect(await tryHandleUiCommand(ctx, ".naoexiste")).toBe(false);
    expect(await tryHandleUiCommand(ctx, "...")).toBe(false);
  });

  it("modo repertório ligado salva figurinhas recebidas", async () => {
    const saveToRepertoire = vi.fn(async () => ({ key: "rep-1" }));
    const service = { isRepertoireModeOn: () => true, saveToRepertoire };
    const { ctx, thread } = makeCtx(service);
    const saved = await autoSaveIncomingStickers(ctx, [
      { kind: "sticker", mediaId: "s-11111111.webp" },
      { kind: "image", mediaId: "i-22222222.png" },
    ]);
    expect(saved).toHaveLength(1);
    expect(saveToRepertoire).toHaveBeenCalledTimes(1);
    expect(thread.messages.at(-1).text).toContain("rep-1");
  });
});

describe("rotas de mídia da UI", () => {
  async function startApp(runtime, service) {
    const prevToken = process.env.TETOS_UI_SESSION_TOKEN;
    const prevPath = process.env.TETOS_UI_THREADS_PATH;
    process.env.TETOS_UI_SESSION_TOKEN = TOKEN;
    process.env.TETOS_UI_THREADS_PATH = join(root, "threads.json");
    const app = express();
    app.use(express.json());
    const uiBus = new UiEventBus();
    const deviceRegistry = new DeviceRegistry();
    const deviceGateway = new DeviceGateway({ deviceRegistry, uiBus });
    registerUiThreadRoutes(app, { ...runtime, uiMediaService: service }, uiBus, {}, deviceRegistry, deviceGateway);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      base,
      close: () => {
        server.close();
        process.env.TETOS_UI_SESSION_TOKEN = prevToken;
        process.env.TETOS_UI_THREADS_PATH = prevPath;
        if (prevToken === undefined) delete process.env.TETOS_UI_SESSION_TOKEN;
        if (prevPath === undefined) delete process.env.TETOS_UI_THREADS_PATH;
      },
    };
  }
  const auth = { Authorization: `Bearer ${TOKEN}` };

  it("upload → download com token por query; sem token = 401; traversal = 404", async () => {
    const runtime = makeRuntime();
    const service = new UiMediaService({ runtime });
    const { base, close } = await startApp(runtime, service);
    try {
      const up = await fetch(`${base}/ui/media`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "image/png", "X-File-Name": encodeURIComponent("foto é.png") },
        body: PNG,
      });
      expect(up.status).toBe(200);
      const { media } = await up.json();
      expect(media.kind).toBe("image");
      expect(media.name).toBeTruthy();

      const noAuth = await fetch(`${base}${media.url}`);
      expect(noAuth.status).toBe(401);

      const ok = await fetch(`${base}${media.url}?token=${TOKEN}`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("image/png");
      expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);

      const evil = await fetch(`${base}/ui/media/..%2F..%2Fpackage.json?token=${TOKEN}`);
      expect(evil.status).toBe(404);

      const empty = await fetch(`${base}/ui/media`, { method: "POST", headers: { ...auth, "Content-Type": "image/png" } });
      expect(empty.status).toBe(400);
    } finally {
      close();
    }
  });

  it("repertório: lista, serve arquivo e entrega anexo pronto para enviar", async () => {
    const runtime = makeRuntime();
    mkdirSync(runtime.defaults.stickersPath, { recursive: true });
    writeFileSync(join(runtime.defaults.stickersPath, "teto-pao.webp"), PNG);
    const service = new UiMediaService({ runtime });
    const { base, close } = await startApp(runtime, service);
    try {
      const list = await (await fetch(`${base}/ui/stickers`, { headers: auth })).json();
      expect(list.stickers.map((s) => s.key)).toContain("teto-pao");

      const file = await fetch(`${base}/ui/stickers/teto-pao/file?token=${TOKEN}`);
      expect(file.status).toBe(200);
      expect(file.headers.get("content-type")).toContain("image/webp");

      const use = await fetch(`${base}/ui/stickers/teto-pao/use`, { method: "POST", headers: auth });
      expect((await use.json()).media.kind).toBe("sticker");

      const missing = await fetch(`${base}/ui/stickers/..%2Fx/file?token=${TOKEN}`);
      expect(missing.status).toBe(404);
    } finally {
      close();
    }
  });

  it("POST /ui/threads/:id/messages com '.sticker' + anexo executa o comando sem chamar o LLM", async () => {
    const runtime = makeRuntime();
    const output = { kind: "sticker", mimeType: "image/webp", mediaId: "o-99999999.webp", url: "/ui/media/o-99999999.webp" };
    const service = new UiMediaService({ runtime });
    service.runMediaCommand = vi.fn(async () => ({ attachments: [output], notes: [] }));
    const { base, close } = await startApp(runtime, service);
    try {
      const res = await fetch(`${base}/ui/threads/t-cmd/messages`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text: ".sticker", attachments: [{ kind: "image", dataUrl: PNG_DATA_URL, name: "a.png" }] }),
      });
      expect(res.status).toBe(200);
      expect(service.runMediaCommand).toHaveBeenCalledTimes(1);
      const call = service.runMediaCommand.mock.calls[0][0];
      expect(call.command).toBe("sticker");
      expect(call.ref.mediaId).toMatch(/\.png$/);

      const msgs = await (await fetch(`${base}/ui/threads/t-cmd/messages`, { headers: auth })).json();
      expect(msgs.messages[0].attachments[0].url).toMatch(/^\/ui\/media\//);
      expect(msgs.messages[0].attachments[0].url).not.toContain("data:");
      expect(msgs.messages.at(-1).attachments[0].kind).toBe("sticker");
    } finally {
      close();
    }
  });

  it("botões da UI: POST /ui/threads/:id/media-actions", async () => {
    const runtime = makeRuntime();
    const service = new UiMediaService({ runtime });
    service.runMediaCommand = vi.fn(async () => ({ attachments: [], notes: ["Fundo removido."] }));
    const { base, close } = await startApp(runtime, service);
    try {
      const bad = await fetch(`${base}/ui/threads/t-act/media-actions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "rm -rf" }),
      });
      expect(bad.status).toBe(400);

      const ok = await fetch(`${base}/ui/threads/t-act/media-actions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ command: "removebg", args: ["forte"], mediaRef: "latest" }),
      });
      expect((await ok.json()).ok).toBe(true);
      expect(service.runMediaCommand).toHaveBeenCalledWith({ command: "removebg", args: ["forte"], ref: null });
    } finally {
      close();
    }
  });
});
