import { TetoActivationStore } from "../src/core/channels/TetoActivationStore.js";
import { parseTetoSlashCommand } from "../src/integrations/whatsapp/tetoSlashCommands.js";
import { assert, ok } from "./test-helpers.js";

const storeOpen = new TetoActivationStore("./data/test-activations-open.json", { activationRequired: false });
assert(storeOpen.isDmActive("u1"), "open mode allows dm");
assert(storeOpen.isGroupActive("g1@g.us"), "open mode allows group");

const storeGated = new TetoActivationStore("./data/test-activations-gated.json", { activationRequired: true });
assert(!storeGated.isDmActive("u2"), "gated blocks until activate");
storeGated.activateDm("u2");
assert(storeGated.isDmActive("u2"), "gated allows after activate");
storeGated.activateGroup("120@g.us", { activatedBy: "u2" });
assert(storeGated.isGroupActive("120@g.us"), "group activate");

const cmd = parseTetoSlashCommand("/teto-ativar");
assert(cmd?.action === "activate_dm", "parse ativar");
const gcmd = parseTetoSlashCommand("/teto-grupo-desativar");
assert(gcmd?.action === "deactivate_group", "parse grupo desativar");

ok("test-teto-activation");
