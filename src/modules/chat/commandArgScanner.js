/**
 * Lê os argumentos de um comando de ação (`mensagem("…")`, `computador("…")`) de forma robusta para texto livre.
 *
 * O leitor antigo fechava o comando no primeiro `)` e o argumento na primeira aspa: uma mensagem com Markdown
 * (`[arquivo](file:///C:/a.docx)`), parênteses ou apóstrofo (`d'água`) era cortada no meio. Aqui:
 *  - a string só termina numa aspa seguida de `,` ou `)` (ou do fim do texto);
 *  - `\"` e `\'` são aspas escapadas;
 *  - parênteses e outras aspas dentro do texto não encerram nada.
 */

function skipSpaces(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * @param {string} text texto completo da resposta da IA
 * @param {number} start índice logo depois do `(` do comando
 * @returns {{ args: string[], end: number } | null} `end` = índice depois do `)`. null se não deu para ler com segurança.
 */
export function scanCommandArgs(text, start) {
  const args = [];
  let i = skipSpaces(text, start);

  while (i < text.length) {
    if (text[i] === ")") return { args, end: i + 1 };
    const quote = text[i];

    if (quote === '"' || quote === "'") {
      let j = i + 1;
      let buf = "";
      let closed = false;
      while (j < text.length) {
        const c = text[j];
        if (c === "\\" && (text[j + 1] === '"' || text[j + 1] === "'")) {
          buf += text[j + 1];
          j += 2;
          continue;
        }
        if (c === quote) {
          const k = skipSpaces(text, j + 1);
          if (k >= text.length || text[k] === "," || text[k] === ")") {
            closed = true;
            break;
          }
        }
        buf += c;
        j++;
      }
      if (!closed) return null;
      args.push(buf);
      i = skipSpaces(text, j + 1);
      if (text[i] === ",") i = skipSpaces(text, i + 1);
      continue;
    }

    // Argumento sem aspas (número, palavra): vai até a próxima vírgula ou ao fecha-parêntese.
    let j = i;
    while (j < text.length && text[j] !== "," && text[j] !== ")") j++;
    if (j >= text.length) return null;
    const token = text.slice(i, j).trim();
    if (token) args.push(token);
    i = text[j] === "," ? skipSpaces(text, j + 1) : j;
  }
  return null;
}
