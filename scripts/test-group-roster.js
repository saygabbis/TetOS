import {
  buildContactIndex,
  buildGroupRoster,
  cleanDisplayName
} from "../src/core/channels/groupRoster.js";
import {
  addProfileNicknames,
  buildIdentityIndex,
  captureTetoNicknamesFromReplies,
  normalizeIncomingMentions,
  recordWaIdentity
} from "../src/core/channels/waIdentity.js";
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
        "dm-157947506229421": {
          facts: {
            name: "Gabbis( ˘ ³˘ )♥",
            preferredName: "Gabbis",
            waLid: "157947506229421",
            waPhone: "5516988137617",
            waRemoteJid: "157947506229421@lid"
          }
        },
        "6283879987068": { facts: { name: "Duda ✨", waPhone: "6283879987068" } },
        "187995030323304": {
          facts: {
            name: "Ana",
            waLid: "187995030323304",
            waPhone: "5516997140666"
          }
        }
      }
    },
    getProfile: (id) => runtime.longTerm.data.profiles[id] ?? { facts: {} },
    updateProfile: (id, patch) => {
      runtime.longTerm.data.profiles[id] = {
        ...(runtime.longTerm.data.profiles[id] ?? {}),
        ...patch,
        facts: { ...(runtime.longTerm.data.profiles[id]?.facts ?? {}), ...(patch.facts ?? {}) }
      };
    }
  },
  channelRegistry: {
    get: () => ({
      participants: ["5516988137617", "6283879987068", "187995030323304"],
      participantJids: {
        "6283879987068": "6283879987068@s.whatsapp.net",
        "5516988137617": "5516988137617@s.whatsapp.net",
        "187995030323304": "187995030323304@lid"
      },
      participantPhones: {
        "187995030323304": "5516997140666"
      }
    }),
    recordParticipantJid: () => {},
    recordParticipantLink: () => {}
  },
  groupMemory: {
    byChannel: () => [
      { userId: "6283879987068", speakerName: "Duda ✨", text: "oi" }
    ]
  }
};

const index = buildContactIndex(runtime);
assert(index.get("5516988137617")?.displayName === "Gabbis", "liga dona PV → telefone grupo");
assert(index.get("157947506229421")?.displayName === "Gabbis", "liga LID → Gabbis");
assert(index.get("187995030323304")?.displayName === "Ana", "liga LID Ana");

const roster = buildGroupRoster(runtime, "120363425913528764@g.us", {
  participants: ["5516988137617", "6283879987068", "187995030323304"]
});
assert(roster.members.some((m) => m.displayName === "Gabbis"), "roster tem Gabbis");
assert(roster.members.some((m) => m.displayName === "Duda"), "roster tem Duda");
assert(roster.members.some((m) => m.displayName === "Ana"), "roster tem Ana");

const resolved = applyWhatsAppMentions(
  "Aqui tem a Gabbis e o @6283879987068 que marca todo mundo",
  roster.members
);
assert(resolved.mentions.length >= 1, "gera menções");
assert(resolved.text.includes("@6283879987068"), "texto usa @dígitos para Baileys");

const lidMention = applyWhatsAppMentions("@187995030323304 vem aqui", roster.members);
assert(lidMention.mentions.some((j) => j.includes("5516997140666") || j.includes("187995030323304")), "menção Ana com jid");
assert(
  lidMention.text.includes("@5516997140666") || lidMention.text.includes("@187995030323304"),
  "texto com marca numérica"
);

const normalized = normalizeIncomingMentions(
  "@187995030323304 falou comigo",
  buildIdentityIndex(runtime),
  ["187995030323304@lid"]
);
assert(normalized.includes("@Ana"), "normaliza menção LID antes do LLM");

recordWaIdentity(runtime, {
  userId: "187995030323304",
  remoteJid: "120363425913528764@g.us",
  participantJid: "187995030323304@lid",
  participantPhone: "5516997140666",
  pushName: "Ana",
  channelId: "120363425913528764@g.us",
  isGroup: true
});
assert(
  runtime.longTerm.data.profiles["187995030323304"]?.facts?.waPhone === "5516997140666",
  "grava tel no perfil LID"
);

addProfileNicknames(runtime, "dm-157947506229421", { userNick: "Gabi" });
assert(
  runtime.longTerm.data.profiles["dm-157947506229421"]?.facts?.preferredName === "Gabi",
  "salva apelido pedido pelo usuário"
);
assert(
  runtime.longTerm.data.profiles["5516988137617"]?.facts?.nicknames?.includes("Gabi"),
  "propaga apelido para id ligado (tel)"
);

addProfileNicknames(runtime, "dm-157947506229421", { tetoNick: "bb" });
const rosterWithNick = buildGroupRoster(runtime, "120363425913528764@g.us", {
  participants: ["5516988137617"]
});
const gabbisMember = rosterWithNick.members.find((m) => m.displayName === "Gabi" || m.displayName === "Gabbis");
assert(gabbisMember?.tetoNicknames?.includes("bb"), "roster lista apelido da Teto");

const captured = captureTetoNicknamesFromReplies(
  ["Gabi, vem cá", "minha princesa Duda"],
  { displayName: "Gabbis", existing: [] }
);
assert(captured.includes("Gabi"), "captura vocativo no início");
assert(captured.includes("Duda"), "captura minha princesa X");

const nickMention = applyWhatsAppMentions("@Gabi olha isso", rosterWithNick.members);
assert(nickMention.mentions.length >= 1, "menção por apelido gera jid");

ok("test-group-roster");
