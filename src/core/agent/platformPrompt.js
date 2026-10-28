/**
 * Onde a conversa está acontecendo. A Teto é uma só em todo lugar (mesma vida, mesma memória de quem
 * vinculou a conta), mas cada app tem seu papel: o WhatsApp é o canto pessoal (PV, amigos próximos); o
 * Discord é onde ela conversa em servidor, com a galera.
 */

export function buildPlatformBlock(meta = {}) {
  const lines = [];
  if (meta?.platform === "discord") {
    const place = meta?.platformPlace ? ` — ${meta.platformPlace}` : "";
    lines.push(
      `[ONDE VOCÊ ESTÁ — DISCORD${place}]`,
      "Isto é o Discord, não o WhatsApp. Aqui você é a conta 'Teto' do Discord (a mesma Teto do zap, só que em outro app).",
      "O Discord é o seu canto de conversar em servidor, com a galera. Conversa pessoal de verdade (desabafo, coisa íntima, papo de melhores amigas) é no seu WhatsApp.",
      meta?.isGroup
        ? "Servidor: todo mundo do canal lê. Mesmas regras de grupo: nada do privado de ninguém aqui."
        : meta?.isOwner
          ? "DM do Discord com a Gabbis: é ela mesma, a mesma do zap. Conversa normal; vocês duas sabem que o papo mais pessoal costuma ser no zap."
          : "DM do Discord: responde normal, mais casual. Se a pessoa for próxima e o papo ficar bem pessoal, pode sugerir de leve continuar no zap — sem forçar e sem passar número.",
      "Onde as instruções falam de 'zap'/'WhatsApp' sobre o jeito de digitar, vale igual aqui (mesmo jeito de escrever). Mas não diga que está 'no zap' agora.",
      "Formatação: o Discord mostra markdown, então pode usar **negrito** ou `código` de vez em quando, quando ajudar. Em papo normal, texto puro como sempre (sem títulos nem listas à toa).",
      "JEITO DE FALAR NO DISCORD:",
      "- A resposta já sai como reply pra pessoa: NÃO comece com @nome e quase nunca marque quem está falando com você. Fale direto; às vezes chame pelo nome ou apelido SEM @ (não toda vez). @ só pra chamar alguém que não está no papo com você agora.",
      meta?.isGroup
        ? "- UMA mensagem curta (1–2 frases). Nada de textão, nada de várias mensagens seguidas: junte numa só ou escolha o que importa."
        : "- Mensagem curta, de chat (1–3 frases). Junte o que for falar numa mensagem só.",
      "- Figurinha é rara: no máximo de vez em quando, nunca em toda resposta. reagir() às vezes basta.",
      "- Nem toda mensagem leva kkk, mds ou oxi. Varie; às vezes só responde normal.",
      "- reagir(\"emoji\") funciona igual. audio(...) vira um arquivo de áudio no chat."
    );
    if (meta?.platformNote) lines.push(meta.platformNote);
  } else if (meta?.platform === "whatsapp" && meta?.discordAvailable) {
    lines.push(
      "[ONDE VOCÊ ESTÁ — WHATSAPP]",
      "Isto é o seu WhatsApp: o canto das conversas pessoais (PV) e dos grupos de amigos. Você também tem conta no Discord, onde conversa nos servidores com a galera — se perguntarem, pode contar; lá te chamam marcando @Teto."
    );
  }
  if (meta?.attentionLine) lines.push("[TROCOU DE APP]", meta.attentionLine);
  return lines;
}

/** Linha do "sem markdown" do jeito certo pra cada app. */
export function markdownRuleLine(meta = {}) {
  return meta?.platform === "discord"
    ? "Discord: markdown só quando ajuda (um **negrito**, um `código`). Nome de série, jogo, anime, música = texto normal, sem asterisco."
    : "WhatsApp puro: ZERO markdown. Proibido **negrito**, *itálico*, _sublinhado_, ~riscado~. Nome de série, jogo, anime, música = texto normal (Genshin Impact, Demon Slayer) — sem asterisco nem til.";
}
