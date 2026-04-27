import "dotenv/config";
import { DEFAULTS } from "../infra/config/defaults.js";
import { FocusConfigStore } from "../core/learning/focusConfigStore.js";

function printUsage() {
  console.log("Uso:");
  console.log("  npm run learn:focus -- set <foco> [notas]");
  console.log("  npm run learn:focus -- reset");
  console.log("  npm run learn:focus -- show");
}

function main() {
  const store = new FocusConfigStore(DEFAULTS.learningFocusPath);
  const [, , action, ...rest] = process.argv;
  if (!action) {
    printUsage();
    process.exit(1);
  }
  if (action === "set") {
    const focus = rest[0];
    const notes = rest.slice(1).join(" ");
    if (!focus) {
      console.error("Informe o foco.");
      process.exit(1);
    }
    const state = store.setFocus(focus, notes);
    console.log(JSON.stringify({ status: "ok", state }, null, 2));
    return;
  }
  if (action === "reset") {
    const state = store.reset();
    console.log(JSON.stringify({ status: "ok", state }, null, 2));
    return;
  }
  if (action === "show") {
    console.log(JSON.stringify({ status: "ok", state: store.get() }, null, 2));
    return;
  }
  printUsage();
  process.exit(1);
}

main();
