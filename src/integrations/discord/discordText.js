/**
 * Texto entre Discord e a Teto: menções/canais/emojis viram texto legível pra ela, e o "@nome" que ela
 * escreve vira menção de verdade (<@id>) — só de quem está no papo, nunca @everyone.
 */

const MAX_LEN = 1900;

/** Texto da mensagem como a Teto lê: <@123> → @Nome, <#123> → #canal, <:emoji:123> → :emoji:. */
export function readableContent(message, { botId = null } = {}) {
  let text = String(message?.content ?? "");
  const nameOf = (id) => {
    if (botId && id === botId) return "Teto";
    const member = message?.mentions?.members?.get?.(id) ?? message?.guild?.members?.cache?.get?.(id);
    const user = message?.mentions?.users?.get?.(id) ?? message?.client?.users?.cache?.get?.(id);
    return member?.displayName ?? user?.globalName ?? user?.username ?? "alguém";
  };
  // Marcação dela no começo é só o "chamado" — o resto é a mensagem.
  if (botId) text = text.replace(new RegExp(`^\\s*<@!?${botId}>[\\s,:]*`), "");
  text = text
    .replace(/<@!?(\d+)>/g, (_, id) => `@${nameOf(id)}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${message?.guild?.roles?.cache?.get?.(id)?.name ?? "cargo"}`)
    .replace(/<#(\d+)>/g, (_, id) => `#${message?.guild?.channels?.cache?.get?.(id)?.name ?? "canal"}`)
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<t:(\d+)(?::\w)?>/g, (_, s) => new Date(Number(s) * 1000).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }));
  return text.trim();
}

const normalizeName = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * "@Gabbis" → "<@id>" usando quem está no papo (`people`: [{ id, names: [...] }]). Aceita prefixo
 * único ("@gab" → Gabbis) ou parte do nome ("@gabbis" → saygabbis). Retorna o texto e os ids marcados (pro allowedMentions).
 */
export function applyOutgoingMentions(text, people = []) {
  const ids = new Set();
  const index = people.flatMap((p) => (p.names ?? []).filter(Boolean).map((n) => ({ id: p.id, key: normalizeName(n) }))).filter((x) => x.key);
  // Nome com espaço ("Neguinho mais malandro"): a menção vale pelo nome inteiro — senão sobrava
  // "<@id> mais malandro" (o resto do nome escrito depois da marcação).
  const words = (n) => String(n ?? "").trim().split(/\s+/).filter(Boolean);
  const restPattern = (rest) => new RegExp(`^\\s+${rest.map(escapeRe).join("\\s+")}(?![\\p{L}\\p{N}])`, "iu");
  const multiWord = people.flatMap((p) => (p.names ?? []).filter((n) => words(n).length > 1).map((n) => ({ id: p.id, words: words(n) })));

  const src = String(text ?? "");
  const re = /(^|[\s(])@([\p{L}\p{N}_.\-]{2,32})/gu;
  let out = "";
  let pos = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const [all, lead, raw] = m;
    const key = normalizeName(raw);
    if (!key || key === "everyone" || key === "here") continue;
    const exact = [...new Set(index.filter((x) => x.key === key).map((x) => x.id))];
    const byFirstWord = () => [...new Set(multiWord.filter((x) => normalizeName(x.words[0]) === key).map((x) => x.id))];
    const byPrefix = () => [...new Set(index.filter((x) => x.key.startsWith(key)).map((x) => x.id))];
    // Parte do nome ("@gabbis" → "saygabbis"), só com 4+ letras e se for uma pessoa só.
    const byPart = () => (key.length >= 4 ? [...new Set(index.filter((x) => x.key.includes(key)).map((x) => x.id))] : []);
    const found = [exact, byFirstWord(), byPrefix(), byPart()].find((list) => list.length > 0) ?? [];
    if (found.length !== 1) continue;
    const id = found[0];
    let end = m.index + all.length;
    // "@Neguinho mais malandro": come o resto do nome que veio escrito depois.
    for (const name of multiWord.filter((x) => x.id === id && normalizeName(x.words[0]) === key)) {
      const tail = src.slice(end).match(restPattern(name.words.slice(1)));
      if (tail) {
        end += tail[0].length;
        break;
      }
    }
    ids.add(id);
    out += `${src.slice(pos, m.index)}${lead}<@${id}>`;
    pos = end;
    re.lastIndex = end;
  }
  out += src.slice(pos);
  return { text: out, userIds: [...ids] };
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quebra textos longos (limite do Discord é 2000) sem cortar palavra no meio quando dá. */
export function splitForDiscord(text, max = MAX_LEN) {
  const parts = [];
  let rest = String(text ?? "").trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

/** Nome de quem falou, do jeito que aparece no servidor. */
export function speakerNameOf(message) {
  return message?.member?.displayName ?? message?.author?.globalName ?? message?.author?.username ?? "alguém";
}

/** Onde ela está, pro prompt: "#geral no servidor X" ou "DM". */
export function placeLabel(channel) {
  if (!channel) return null;
  if (channel.isDMBased?.()) return "DM do Discord";
  const name = channel.name ? `#${channel.name}` : "um canal";
  return channel.guild?.name ? `${name} no servidor ${channel.guild.name}` : name;
}
