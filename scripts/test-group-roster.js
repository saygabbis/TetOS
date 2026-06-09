import {
  buildContactIndex,
  buildGroupRoster,
  cleanDisplayName
} from "../src/core/channels/groupRoster.js";
import { applyWhatsAppMentions } from "../src/integrations/whatsapp/mentionResolver.js";
import { assert, ok } from "./test-helpers.js";

assert(cleanDisplayName("Gabbis( ˘ ³˘ )♥") === "Gabbis", "limpa pushName");

const runtime = {
  defaults: {
    learningTargetUserId: "5516988137617",
    ownerWaJids: ["157947506229421@lid"]
  },
  longTerm: {
    data: {
      profiles: {
        "dm-157947506229421": { facts: { name: "Gabbis( ˘ ³˘ )♥", preferredName: "Gabbis" } },
        "6283879987068": { facts: { name: "Duda ✨", waPhone: "6283879987068" } }
      }
    },
    getProfile: (id) => runtime.longTerm.data.profiles[id] ?? { facts: {} }
  },
  channelRegistry: {
    get: () => ({
      participants: ["5516988137617", "6283879987068"],
      participantJids: {
        "6283879987068": "6283879987068@s.whatsapp.net",
        "5516988137617": "5516988137617@s.whatsapp.net"
      }
    })
  },
  groupMemory: {
    byChannel: () => [
      { userId: "6283879987068", speakerName: "Duda ✨", text: "oi" }
    ]
  }
};

const index = buildContactIndex(runtime);
assert(index.get("5516988137617")?.displayName === "Gabbis", "liga dona PV → telefone grupo");

const roster = buildGroupRoster(runtime, "120363425913528764@g.us", {
  participants: ["5516988137617", "6283879987068"]
});
assert(roster.members.some((m) => m.displayName === "Gabbis"), "roster tem Gabbis");
assert(roster.members.some((m) => m.displayName === "Duda"), "roster tem Duda");

const resolved = applyWhatsAppMentions(
  "Aqui tem a Gabbis e o @6283879987068 que marca todo mundo",
  roster.members
);
assert(resolved.mentions.length >= 1, "gera menções");
assert(!resolved.text.includes("@6283879987068"), "substitui número por nome");

ok("test-group-roster");
