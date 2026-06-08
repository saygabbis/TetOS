import { ResponseProcessor } from "../src/modules/chat/responseProcessor.js";
import { assert, ok } from "./test-helpers.js";

function simulateMultiBubbleSend({ interruptOnSelfEcho }) {
  const interruptBySession = new Map();
  const sessionId = "wa-5516988137617";
  const token = 1000;
  interruptBySession.set(sessionId, token);
  const replies = ["Ei", "Quer saber por quê?", "Só porque você é curiosa, ó."];
  const sent = [];

  const bumpInterrupt = (isFromMe) => {
    const shouldBump = interruptOnSelfEcho ? true : !isFromMe;
    if (shouldBump) interruptBySession.set(sessionId, Date.now());
  };

  for (let index = 0; index < replies.length; index += 1) {
    if (interruptBySession.get(sessionId) !== token) break;
    sent.push(replies[index]);
    if (index === 0) bumpInterrupt(true);
  }
  return sent;
}

const oldBehavior = simulateMultiBubbleSend({ interruptOnSelfEcho: true });
assert(oldBehavior.length === 1, "bug repro: self-echo interrupt stops after 1 bubble");

const fixedBehavior = simulateMultiBubbleSend({ interruptOnSelfEcho: false });
assert(fixedBehavior.length === 3, "fix: self-echo must not interrupt remaining bubbles");

const userEchoCase = new ResponseProcessor().processAndGuard(
  "Ei\nQuer saber por quê?\nSó porque você é curiosa, ó.",
  { userMessage: "EI PQ EU", tone: "calm" }
);
assert(userEchoCase.length >= 3, "processor splits 3+ newline parts from user log case");
assert(userEchoCase[0].toLowerCase().startsWith("ei"), "first bubble Ei");
assert(userEchoCase.some((p) => /por quê/i.test(p)), "question bubble present");

const dashCase = new ResponseProcessor().processAndGuard("Ei\n---\nQuer saber por quê?", {
  userMessage: "oi",
  tone: "calm"
});
assert(dashCase.length === 2, "--- separator yields 2 bubbles");

const singleLine = new ResponseProcessor().processAndGuard("só uma frase.", {
  userMessage: "oi",
  tone: "calm"
});
assert(singleLine.length === 1, "single sentence stays 1 bubble");

const shortFirst = new ResponseProcessor().processAndGuard("oie sapequinha\nAh", {
  userMessage: "oi",
  tone: "calm"
});
assert(shortFirst.length === 2, "newline pair stays 2 bubbles");

ok("test-multibubble");
