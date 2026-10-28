import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Logs do Discord em dois arquivos por dia, pra ler sem se perder:
 *   chat-AAAA-MM-DD.log       o que foi dito (mensagens das pessoas e da Teto), como uma conversa;
 *   decisoes-AAAA-MM-DD.log   o que ela entendeu/decidiu (respondeu, ignorou, guardou pra depois, ficou quieta e por quê).
 * Horário de São Paulo. Fica em data/logs/discord (fora do git).
 */
export function createDiscordLog({ dir = "./data/logs/discord", timeZone = "America/Sao_Paulo", now = () => new Date(), echo = null } = {}) {
  let ready = false;
  const stamp = () => {
    const d = now();
    const day = new Intl.DateTimeFormat("sv-SE", { timeZone }).format(d);
    const time = new Intl.DateTimeFormat("pt-BR", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d);
    return { day, time };
  };
  const write = (kind, line) => {
    try {
      if (!ready) {
        mkdirSync(dir, { recursive: true });
        ready = true;
      }
      const { day, time } = stamp();
      appendFileSync(join(dir, `${kind}-${day}.log`), `[${time}] ${line}\n`);
    } catch {
      /* log nunca derruba nada */
    }
  };
  const oneLine = (text) => String(text ?? "").replace(/\s*\n\s*/g, " ⏎ ").slice(0, 600);

  return {
    /** Fala de alguém (ou da Teto) num lugar ("#geral @ Servidor", "DM"). */
    chat(place, who, text) {
      write("chat", `${place} | ${who}: ${oneLine(text)}`);
    },
    /** Decisão: o que fez com a mensagem e por quê. */
    decision(place, who, what, why = "") {
      const line = `${place} | ${who} → ${what}${why ? ` (${why})` : ""}`;
      write("decisoes", line);
      echo?.(`[discord] ${line}`);
    }
  };
}
