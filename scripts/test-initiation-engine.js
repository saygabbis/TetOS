import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InitiationQueue } from "../src/core/autonomy/initiationQueue.js";
import { InitiationEngine } from "../src/core/autonomy/initiationEngine.js";
import { TimingEngine } from "../src/core/timing/TimingEngine.js";
import { assert, ok } from "./test-helpers.js";

const dir = mkdtempSync(join(tmpdir(), "tetos-init-"));
const queuePath = join(dir, "queue.json");

try {
  const queue = new InitiationQueue(queuePath);
  const entry = queue.schedule({
    userId: "dm-157947506229421",
    sessionId: "wa-dm:157947506229421@lid",
    mode: "post_close",
    impulse: "ainda penso na bolinha de queijo",
    deferMs: 3_000_000
  });
  assert(entry?.id, "agenda iniciativa");

  const due = queue.dueEntries(Date.now() + 3_100_000);
  assert(due.length === 1, "fila vence no tempo");

  queue.cancelForUser("dm-157947506229421");
  assert(queue.pendingForUser("dm-157947506229421") === null, "cancela se usuário voltar");

  const timing = new TimingEngine({ enabled: true });
  const queuedPlan = timing.computePlan({
    queuedMode: "post_close",
    emotion: { social: 0.7 },
    trustBond: { intimacy: 0.5 },
    lastMessageAt: new Date(Date.now() - 5 * 60_000).toISOString()
  });
  assert(queuedPlan.shouldInitiateConversation, "fila dispara timing");
  assert(queuedPlan.initiateReason === "post_close", "modo da fila preservado");

  const q2 = new InitiationQueue(join(dir, "q2.json"));
  q2.schedule({
    userId: "dm-test",
    sessionId: "wa-dm:test@lid",
    mode: "thread_continue",
    impulse: "ainda quero aquela bolinha de queijo",
    deferMs: 3_000_000
  });

  const lastUserAt = new Date(Date.now() - 8 * 3600_000).toISOString();
  const engine = new InitiationEngine({
    brainOrchestrator: {
      emotion: { getSnapshot: () => ({ social: 0.72, mood: "playful", energy: 0.65 }) },
      enrichTrustForTiming: () => ({ intimacy: 0.7 }),
      timing: new TimingEngine({ enabled: true }),
      narrator: {
        buildSubconscious: () => "ficou martelando um assunto",
        buildBlocks: () => ({ conscious: "quero mandar msg", subconscious: "saudade leve" })
      },
      buildSnapshot: () => ({
        autonomous: { soloThoughts: [{ text: "tô com vontade de falar com alguém" }] }
      }),
      arbitrator: {
        run: () => ({
          winner: { source: "autonomous", action: "solo_thought_echo", weight: 0.6, detail: "vontade" }
        })
      },
      repetition: { getSnapshot: () => ({}) },
      life: { getSnapshot: () => ({}), sleep: { getSnapshot: () => ({ state: "awake" }) } },
      social: { getSnapshot: () => ({}) }
    },
    timeStore: {
      getLastMessage: () => lastUserAt,
      getLastUserMessage: () => lastUserAt,
      gapSinceUserMs: () => 8 * 3600_000
    },
    userPatterns: { isLikelyActiveNow: () => false },
    shortTerm: {
      getAll: () => [
        { role: "user", content: "nossa por favor" },
        { role: "assistant", content: "combo de bolinha de queijo fechou?" }
      ]
    },
    longTerm: { getProfile: () => ({ facts: { lastDmSessionId: "wa-dm:test@lid" } }) },
    initiationQueue: q2
  });

  const eval1 = engine.evaluateForUser("dm-test", Date.now() + 3_100_000);
  assert(eval1?.shouldInitiate, "avalia impulso generativo");
  assert(eval1.impulse.includes("bolinha"), "impulso vem da fila/thread");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

ok("test-initiation-engine");
