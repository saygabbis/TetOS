import { MultimodalMemoryStore } from "../src/core/memory/multimodalMemory.js";
import { VisualAnalysisStore } from "../src/modules/vision/visualAnalysisStore.js";
import { ChatMediaHistoryStore } from "../src/integrations/whatsapp/chatMediaHistoryStore.js";
import { MediaLearningHub } from "../src/core/media/MediaLearningHub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, ok } from "./test-helpers.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tetos-scope-"));

try {
  const mmPath = path.join(tmp, "mm.json");
  const mm = new MultimodalMemoryStore(mmPath, { maxPerScope: 3, maxTextLength: 100 });
  mm.save({ userId: "u1", channelId: "g1", message: "a", media: { type: "image" } });
  mm.save({ userId: "u1", channelId: "g2", message: "b", media: { type: "image" } });
  mm.save({ userId: "u2", channelId: "g1", message: "c", media: { type: "image" } });
  assert(mm.list("u1", "g1").length === 1, "multimodal filtra user+grupo");
  assert(mm.list("u1", "g2")[0].text === "b", "outro grupo separado");

  const va = new VisualAnalysisStore(path.join(tmp, "va.json"), { maxPerScope: 2 });
  va.save({ userId: "u1", channelId: "g1", description: "x" });
  va.save({ userId: "u1", channelId: "g2", description: "y" });
  assert(va.latestByScope("u1", "g1").length === 1, "visual por escopo");

  const hist = new ChatMediaHistoryStore(5);
  hist.add("g1@g.us", { media: { path: "/a", type: "image" }, userId: "u1" }, "u1");
  hist.add("g1@g.us", { media: { path: "/b", type: "image" }, userId: "u2" }, "u2");
  assert(hist.latest("g1@g.us", "u1").media.path === "/a", "histórico sticker por usuário no grupo");
  assert(hist.latest("g1@g.us", "u2").media.path === "/b", "outro usuário não mistura");

  const hub = new MediaLearningHub(path.join(tmp, "media.json"));
  hub.learnFromMedia({ type: "sticker", hash: "h1" }, { userId: "u1", channelId: "g1", isGroup: true });
  hub.learnFromMedia({ type: "sticker", hash: "h2" }, { userId: "u2", channelId: "g1", isGroup: true });
  hub.learnFromMedia({ type: "sticker", hash: "h1b" }, { userId: "u1", channelId: "g1", isGroup: true });
  const a1 = hub.getAffinities({ userId: "u1", channelId: "g1", isGroup: true });
  const a2 = hub.getAffinities({ userId: "u2", channelId: "g1", isGroup: true });
  assert(a1.scope.includes("u1"), "escopo inclui usuário");
  assert(a2.scope.includes("u2"), "escopo do outro usuário");
  assert(hub.ensureScope(a1.scope).stickers.h1?.count >= 1, "sticker aprendido por escopo");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

ok("test-scoped-media-memory");
