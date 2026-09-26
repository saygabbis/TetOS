import { requireSession } from "../auth/sessionAuth.js";

import { handleIncomingMessage } from "../../../app/createRuntime.js";

import { applyUiOutgoingActions } from "../../../integrations/automate/uiReplies.js";
import { attachAutomateChatHistory } from "../../../integrations/automate/uiAutomateChatHistory.js";
import { normalizeSkillRefs, skillRefsPipelinePrefix } from "../../../integrations/automate/skillRefs.js";
import { parseAutomateMention, resolveUiMessageMode } from "../../../integrations/automate/parseAutomateMention.js";

import { publishAssistantTyping } from "../ui/uiEventPublishers.js";

import { readJson, writeJson } from "../../utils/fileStore.js";



function getStorePath() {
  return process.env.TETOS_UI_THREADS_PATH ?? "./data/uiThreads.json";
}

function normalizeAttachments(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const dataUrl =
        typeof item.dataUrl === "string"
          ? item.dataUrl
          : typeof item.base64 === "string"
            ? item.base64.startsWith("data:")
              ? item.base64
              : `data:${item.mimeType ?? "image/png"};base64,${item.base64}`
            : null;
      const mimeType =
        item.mimeType ??
        (dataUrl?.match(/^data:([^;]+);/)?.[1] ?? "image/png");
      const kind = item.kind ?? (String(mimeType).startsWith("image/") ? "image" : "file");
      if (!dataUrl && !item.url) return null;
      return {
        kind,
        mimeType,
        name: item.name ?? `anexo-${index + 1}`,
        url: item.url ?? dataUrl ?? undefined,
      };
    })
    .filter(Boolean);
}

function countImageAttachments(attachments) {
  return attachments.filter((a) => a.kind === "image" || String(a.mimeType ?? "").startsWith("image/")).length;
}

const DEFAULT_THREAD_PAGE = 50;
const DEFAULT_MESSAGE_PAGE = 40;

function parseLimit(raw, defaultVal, max = 200) {
  const n = Number.parseInt(String(raw ?? defaultVal), 10);
  if (!Number.isFinite(n) || n < 1) return defaultVal;
  return Math.min(n, max);
}

function parseOffset(raw) {
  const n = Number.parseInt(String(raw ?? 0), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

const DEFAULT_THREAD_TITLES = new Set(
  ["nova conversa", "conversa", "new conversation", "new chat"].map((s) => s.toLowerCase()),
);

function isDefaultThreadTitle(title) {
  const t = String(title ?? "").trim().toLowerCase();
  return t.length === 0 || DEFAULT_THREAD_TITLES.has(t);
}

function suggestThreadTitleFromText(text, maxLen = 42) {
  const clean = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!clean) return null;
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, maxLen - 1)}…`;
}

function findReusableEmptyThread(threadStore) {
  const candidates = [...threadStore.values()].filter((t) => (t.messages ?? []).length === 0);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return candidates[0];
}

function paginateMessages(messages, { limit, before }) {
  const sorted = [...(messages ?? [])].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  let end = sorted.length;
  if (before) {
    const idx = sorted.findIndex((m) => m.id === before);
    end = idx >= 0 ? idx : 0;
  }
  const start = Math.max(0, end - limit);
  return { messages: sorted.slice(start, end), hasMore: start > 0 };
}



function loadThreadStore() {

  const data = readJson(getStorePath(), { threads: [] });

  const map = new Map();

  for (const t of data.threads ?? []) {

    map.set(t.id, t);

  }

  return map;

}



function persistThreadStore(threadStore) {

  writeJson(getStorePath(), { threads: [...threadStore.values()] });

}

function purgeEmptyThreads(threadStore) {
  let removed = false;
  for (const [id, thread] of threadStore) {
    if ((thread.messages ?? []).length === 0) {
      threadStore.delete(id);
      removed = true;
    }
  }
  if (removed) persistThreadStore(threadStore);
}



function ensureThread(threadStore, id, title = "Conversa") {

  if (!threadStore.has(id)) {

    threadStore.set(id, {

      id,

      title,

      updatedAt: new Date().toISOString(),

      messages: [],

    });

    persistThreadStore(threadStore);

  }

  return threadStore.get(id);

}



export function registerUiThreadRoutes(app, runtime, uiBus, automateClient, deviceRegistry, deviceGateway) {

  const threadStore = loadThreadStore();

  attachAutomateChatHistory(uiBus, { threadStore, persistThreadStore });

  app.get("/ui/threads", requireSession, (req, res) => {
    purgeEmptyThreads(threadStore);
    const limit = parseLimit(req.query.limit, DEFAULT_THREAD_PAGE);
    const offset = parseOffset(req.query.offset);

    let threads = [...threadStore.values()]
      .filter((t) => (t.messages ?? []).length > 0)
      .map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt,
      badge: t.badge,
    }));

    if (threads.length === 0) {
      const seeded = ensureThread(threadStore, "thread-1", "Corte do vídeo de viagem");
      if ((seeded.messages ?? []).length === 0) {
        seeded.messages.push({
          id: "seed-welcome",
          role: "assistant",
          text: "Oi — posso conversar, lembrar de coisas ou ajudar no computador com o AutoMate.",
          createdAt: new Date().toISOString(),
        });
        persistThreadStore(threadStore);
      }
      threads.push({
        id: seeded.id,
        title: seeded.title,
        updatedAt: seeded.updatedAt,
        badge: "agent",
      });
    }

    threads.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    const page = threads.slice(offset, offset + limit);
    const hasMore = offset + page.length < threads.length;

    return res.json({ threads: page, hasMore });
  });



  app.post("/ui/threads", requireSession, (req, res) => {
    const reuseEmpty = req.body?.reuseEmpty !== false;
    const title = String(req.body?.title ?? "Nova conversa").trim() || "Nova conversa";

    if (reuseEmpty) {
      const existing = findReusableEmptyThread(threadStore);
      if (existing) {
        return res.json({
          thread: {
            id: existing.id,
            title: existing.title,
            updatedAt: existing.updatedAt,
          },
          reused: true,
        });
      }
    }

    const id = `thread-${Date.now()}`;
    const thread = ensureThread(threadStore, id, title);
    thread.badge = req.body?.badge;
    persistThreadStore(threadStore);

    return res.json({ thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt } });
  });

  app.delete("/ui/threads/:id", requireSession, (req, res) => {
    const thread = threadStore.get(req.params.id);
    if (!thread) {
      return res.status(404).json({ error: "Thread não encontrada" });
    }
    if ((thread.messages ?? []).length > 0) {
      return res.status(400).json({ error: "Só é possível remover conversas vazias" });
    }
    threadStore.delete(req.params.id);
    persistThreadStore(threadStore);
    return res.json({ ok: true });
  });

  app.patch("/ui/threads/:id", requireSession, (req, res) => {
    const thread = threadStore.get(req.params.id);
    if (!thread) {
      return res.status(404).json({ error: "Thread não encontrada" });
    }
    const title = String(req.body?.title ?? "").trim();
    if (!title) {
      return res.status(400).json({ error: "title é obrigatório" });
    }
    thread.title = title;
    thread.updatedAt = new Date().toISOString();
    persistThreadStore(threadStore);
    uiBus.publish({
      type: "thread.updated",
      threadId: thread.id,
      title: thread.title,
      updatedAt: thread.updatedAt,
    });
    return res.json({
      thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt },
    });
  });



  app.get("/ui/threads/:id", requireSession, (req, res) => {
    const thread = ensureThread(threadStore, req.params.id);
    return res.json({
      id: thread.id,
      title: thread.title,
      messages: [],
    });
  });

  app.get("/ui/threads/:id/messages", requireSession, (req, res) => {
    const thread = ensureThread(threadStore, req.params.id);
    const limit = parseLimit(req.query.limit, DEFAULT_MESSAGE_PAGE);
    const before = req.query.before ? String(req.query.before) : undefined;
    const { messages, hasMore } = paginateMessages(thread.messages, { limit, before });
    return res.json({ messages, hasMore });
  });

  app.post("/ui/threads/:id/messages", requireSession, async (req, res) => {

    const thread = ensureThread(threadStore, req.params.id);

    const text = req.body?.text ?? "";

    const attachments = normalizeAttachments(req.body?.attachments);
    const skillRefs = normalizeSkillRefs(req.body?.skillRefs);

    if (!text.trim() && attachments.length === 0 && skillRefs.length === 0) {

      return res.status(400).json({ error: "text, attachments ou skillRefs é obrigatório" });

    }

    publishAssistantTyping(uiBus, thread.id, true);

    const userMsg = {

      id: `u-${Date.now()}`,

      role: "user",

      text,

      createdAt: new Date().toISOString(),

      ...(attachments.length ? { attachments } : {}),

    };

    const imageCount = countImageAttachments(attachments);

    const automateMention = parseAutomateMention(text);
    const uiMode = resolveUiMessageMode(req.body?.mode, text);
    if (imageCount > 0 || skillRefs.length > 0 || uiMode === "automate") {
      userMsg.meta = {
        ...(imageCount > 0
          ? {
              insights: {
                count: imageCount,
                analyzed: true,
                stub: true,
              },
            }
          : {}),
        ...(skillRefs.length > 0 ? { skillRefs } : {}),
        ...(uiMode === "automate" ? { route: "automate" } : {}),
      };
    }

    const isFirstMessage = (thread.messages ?? []).length === 0;
    thread.messages.push(userMsg);

    thread.updatedAt = new Date().toISOString();

    if (isFirstMessage && isDefaultThreadTitle(thread.title)) {
      const suggested = suggestThreadTitleFromText(text);
      if (suggested) {
        thread.title = suggested;
        uiBus.publish({
          type: "thread.updated",
          threadId: thread.id,
          title: thread.title,
          updatedAt: thread.updatedAt,
        });
      }
    }

    persistThreadStore(threadStore);

    for (const media of attachments) {

      uiBus.publish({

        type: "attachment",

        threadId: thread.id,

        messageId: userMsg.id,

        media,

      });

    }

    uiBus.publish({ type: "message.final", threadId: thread.id, message: userMsg });



    const userId = req.body?.userId ?? "ui-user";

    const sessionId = thread.id;



    try {
      const mode = uiMode;

      const rawPipelineText =
        (automateMention.hasAutomate ? automateMention.intentText : text.trim()) ||
        (skillRefs.length > 0
          ? "Executar conforme as skills referenciadas pelo usuário."
          : imageCount > 0
            ? `[${imageCount} imagem(ns) anexada(s) na conversa UI]`
            : "");
      const pipelineWithSkills =
        skillRefs.length > 0
          ? `${skillRefsPipelinePrefix(skillRefs)}${rawPipelineText}`
          : rawPipelineText;

      const assistantDraftId = `a-${Date.now()}-stream`;
      const onLlmToken =
        mode === "chat"
          ? (chunk) => {
              if (!chunk) return;
              uiBus.publish({
                type: "message.delta",
                threadId: thread.id,
                messageId: assistantDraftId,
                text: chunk,
              });
            }
          : undefined;

      if (mode === "automate") {
        await applyUiOutgoingActions({
          replies: {
            actions: [
              {
                type: "automate",
                intent: pipelineWithSkills,
                ...(skillRefs.length ? { skillRefs } : {}),
              },
            ],
          },
          thread,
          uiBus,
          automateClient,
        });
      } else {
        const { replies } = await handleIncomingMessage(runtime, {
          message: pipelineWithSkills,
          userId,
          sessionId,
          channelId: "ui-desktop",
          onLlmToken,
          uiAssistantMessageId: assistantDraftId,
        });

        await applyUiOutgoingActions({
          replies,
          thread,
          uiBus,
          automateClient,
          assistantMessageId: assistantDraftId,
        });

        if (imageCount > 0) {
          const lastAssistant = [...thread.messages].reverse().find((m) => m.role === "assistant");
          if (lastAssistant) {
            lastAssistant.meta = {
              ...(lastAssistant.meta ?? {}),
              insights: {
                count: imageCount,
                analyzed: true,
                stub: true,
              },
            };
            if (attachments.length) {
              lastAssistant.attachments = attachments;
            }
            uiBus.publish({
              type: "message.final",
              threadId: thread.id,
              message: lastAssistant,
            });
          }
        }
      }

      persistThreadStore(threadStore);

    } catch (err) {

      uiBus.publish({

        type: "run.status",

        runId: `run-${Date.now()}`,

        status: "failed",

        error: err?.message ?? "erro no pipeline",

      });

    } finally {

      publishAssistantTyping(uiBus, thread.id, false);

    }



    return res.json({ ok: true });

  });



  app.post("/ui/runs/permission", requireSession, async (req, res) => {

    const { requestId, clarificationId, answer, answers } = req.body ?? {};

    const id = clarificationId ?? requestId;

    const payload =

      answers && typeof answers === "object"

        ? answers

        : { q1: String(answer ?? "") };

    await automateClient.answer(id, payload);

    return res.json({ ok: true });

  });



  app.post("/ui/runs/control", requireSession, async (req, res) => {

    const { requestId, clarificationId, answer, answers } = req.body ?? {};

    const id = clarificationId ?? requestId;

    const payload =

      answers && typeof answers === "object"

        ? answers

        : { q1: String(answer ?? "") };

    await automateClient.answer(id, payload);

    return res.json({ ok: true });

  });



  app.post("/ui/runs/:runId/stop", requireSession, async (_req, res) => {

    await automateClient.interrupt();

    return res.json({ ok: true });

  });



  app.post("/ui/devices/:id/revoke", requireSession, (req, res) => {

    const ok = deviceRegistry.revoke(req.params.id);

    if (ok && deviceGateway?.closeDevice) {
      deviceGateway.closeDevice(req.params.id);
    }

    return res.json({ ok });

  });



  app.post("/ui/devices/:id/issue", requireSession, (req, res) => {

    const entry = deviceRegistry.issue(req.params.id, req.body?.userId ?? "default");

    return res.json({

      device: { id: entry.id, createdAt: entry.createdAt },

      token: entry.token,

    });

  });



  app.get("/ui/devices", requireSession, (_req, res) => {
    const devices = deviceRegistry.list().map((d) => ({
      ...d,
      online: deviceGateway?.isDeviceConnected?.(d.id) ?? false,
    }));
    return res.json({ devices });
  });

}


