import { existsSync, rmSync, writeFileSync } from "node:fs";
import { TetoActivationStore } from "../src/core/channels/TetoActivationStore.js";
import { parseTetoSlashCommand } from "../src/integrations/whatsapp/tetoSlashCommands.js";
import { assert, ok } from "./test-helpers.js";

const emptyStore = { dm: {}, groups: {}, meta: { lastUpdated: null } };
for (const path of ["./data/test-activations-open.json", "./data/test-activations-gated.json"]) {
  if (existsSync(path)) rmSync(path);
  writeFileSync(path, `${JSON.stringify(emptyStore, null, 2)}\n`);
}

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
assert(cmd?.action === "activate_dm", "parse ativar com /");
const dotCmd = parseTetoSlashCommand(".teto-ativar");
assert(dotCmd?.action === "activate_dm", "parse ativar com .");
const gcmd = parseTetoSlashCommand("/teto-grupo-desativar");
assert(gcmd?.action === "deactivate_group", "parse grupo desativar");
const dotGcmd = parseTetoSlashCommand(".teto-grupo-desativar");
assert(dotGcmd?.action === "deactivate_group", "parse grupo desativar com .");

const openDeactPath = "./data/test-activations-open-deact.json";
if (existsSync(openDeactPath)) rmSync(openDeactPath);
const storeOpenDeact = new TetoActivationStore(openDeactPath, { activationRequired: false });
assert(storeOpenDeact.isDmActive("u-open"), "open mode dm ativo por padrao");
assert(storeOpenDeact.isGroupActive("120@g.us"), "open mode grupo ativo por padrao");
storeOpenDeact.deactivateDm("u-open");
assert(!storeOpenDeact.isDmActive("u-open"), "open mode respeita /teto-desativar");
storeOpenDeact.activateDm("u-open");
assert(storeOpenDeact.isDmActive("u-open"), "reativar dm funciona");
storeOpenDeact.deactivateGroup("120@g.us");
assert(!storeOpenDeact.isGroupActive("120@g.us"), "open mode respeita /teto-grupo-desativar");
storeOpenDeact.activateGroup("120@g.us");
assert(storeOpenDeact.isGroupActive("120@g.us"), "reativar grupo funciona");

const touchPath = "./data/test-activations-gated-touch.json";
if (existsSync(touchPath)) rmSync(touchPath);
const gatedTouch = new TetoActivationStore(touchPath, { activationRequired: true });
assert(!gatedTouch.isDmActive("u99"), "gated blocks fresh user");
gatedTouch.touchDm("u99");
assert(!gatedTouch.isDmActive("u99"), "touchDm must not auto-activate when gated");

ok("test-teto-activation");
