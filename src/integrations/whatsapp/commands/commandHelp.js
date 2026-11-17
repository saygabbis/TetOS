import { CATEGORIES, COMMANDS, commandsInCategory, findCategory, findCommand, closestCommand } from "./commandCatalog.js";

/**
 * Textos do .help gerados do catálogo (nada de lista escrita à mão que esquece comando).
 *  .help              → tudo, por categoria
 *  .help baixar       → só a categoria
 *  .help sticker      → explicação de um comando (apelidos, uso, exemplos)
 */

const LINE = "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈";

function scopeTag(cmd) {
  if (cmd.scope === "pv") return " _(PV)_";
  if (cmd.scope === "owner") return " _(dona)_";
  return "";
}

function shortAliases(cmd, prefix, max = 2) {
  const list = (cmd.aliases ?? []).filter((a) => a.length <= 10 && !/[^a-z0-9-]/i.test(a)).slice(0, max);
  return list.length ? ` _(${list.map((a) => `${prefix}${a}`).join(" ")})_` : "";
}

function commandLine(cmd, prefix) {
  const usage = cmd.usage ? ` ${cmd.usage}` : "";
  return `› *${prefix}${cmd.name}*${usage} — ${cmd.desc}${scopeTag(cmd)}`;
}

export function formatHelpOverview(prefix = ".", { isOwner = false, isGroup = false } = {}) {
  const p = prefix || ".";
  const out = [
    "✦ *TETO — comandos* ✦",
    `_oi! é só mandar com ${p} na frente. errou uma letra? eu entendo_ 🥖`,
    ""
  ];
  for (const cat of CATEGORIES) {
    const list = commandsInCategory(cat.id, { includeOwner: isOwner && !isGroup });
    if (!list.length) continue;
    out.push(`${cat.emoji} *${cat.title.toUpperCase()}*`);
    for (const cmd of list) out.push(commandLine(cmd, p));
    out.push("");
  }
  out.push(
    LINE,
    `💡 *${p}help <comando>* explica um (ex.: ${p}help sticker)`,
    `💡 *${p}help <categoria>* mostra só ela (ex.: ${p}help baixar)`,
    "💡 nos de mídia: *responda* a foto/vídeo/áudio ou mande o comando na *legenda*",
    "💡 também dá pra só pedir conversando: _\"teto, baixa esse vídeo em mp3\"_"
  );
  return out.join("\n").trim();
}

export function formatCategoryHelp(cat, prefix = ".", { isOwner = false, isGroup = false } = {}) {
  const p = prefix || ".";
  const list = commandsInCategory(cat.id, { includeOwner: isOwner && !isGroup });
  return [
    `${cat.emoji} *${cat.title.toUpperCase()}*`,
    "",
    ...list.map((cmd) => `${commandLine(cmd, p)}${shortAliases(cmd, p)}`),
    "",
    `_${p}help <comando> pra ver exemplos_`
  ].join("\n");
}

export function formatCommandHelp(cmd, prefix = ".") {
  const p = prefix || ".";
  const cat = CATEGORIES.find((c) => c.id === cmd.category);
  const aliases = (cmd.aliases ?? []).map((a) => `${p}${a}`);
  const lines = [`${cat?.emoji ?? "•"} *${p}${cmd.name}*${scopeTag(cmd)}`, cmd.desc];
  if (cmd.usage) lines.push("", `*uso:* ${p}${cmd.name} ${cmd.usage}`);
  for (const d of cmd.details ?? []) lines.push(`• ${d}`);
  if (cmd.examples?.length) lines.push("", "*exemplos:*", ...cmd.examples.map((e) => `  ${p}${e}`));
  if (aliases.length) lines.push("", `*também funciona:* ${aliases.join(" · ")}`);
  if (cmd.scope === "pv") lines.push("", "_só funciona no meu PV_");
  if (cmd.scope === "owner") lines.push("", "_só a dona usa, no PV_");
  return lines.join("\n");
}

/** .help [algo] → texto pronto. */
export function formatHelp(args = [], prefix = ".", ctx = {}) {
  const topic = String(args?.[0] ?? "").replace(/^[./]/, "").trim();
  if (!topic) return formatHelpOverview(prefix, ctx);
  // Nome oficial de comando > categoria > apelido ("baixar" é categoria; "sticker" é comando).
  const cmd = findCommand(topic);
  const cat = findCategory(topic);
  if (cmd && cmd.name === topic.toLowerCase()) return formatCommandHelp(cmd, prefix);
  if (cat) return formatCategoryHelp(cat, prefix, ctx);
  if (cmd) return formatCommandHelp(cmd, prefix);
  const near = closestCommand(topic);
  if (near) return `não achei *${topic}*… quis dizer *${prefix}${near.cmd.name}*?\n\n${formatCommandHelp(near.cmd, prefix)}`;
  return `não conheço *${topic}* 🤔 manda *${prefix}help* pra ver tudo`;
}

/** Linha curta pros prompts da IA: todos os comandos que ela pode rodar por conversa. */
export function formatCommandsForPrompt(prefix = ".") {
  return COMMANDS.filter((c) => c.scope !== "owner")
    .map((c) => `${prefix}${c.name}${c.usage ? ` ${c.usage}` : ""} — ${c.desc}`)
    .join("\n");
}
