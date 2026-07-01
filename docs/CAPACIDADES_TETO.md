# TetOS - Capacidades da Teto

Este documento descreve, em linguagem prática, tudo que a Teto é capaz de fazer na base atual do projeto.

## Conversar

A Teto consegue:

- responder mensagens via API HTTP (`POST /chat`);
- responder mensagens no WhatsApp;
- manter histórico curto por sessão;
- adaptar tom e tamanho da resposta ao estilo do usuário;
- dividir respostas em múltiplas bolhas;
- evitar eco literal da fala do usuário;
- regenerar resposta quando percebe incoerência;
- reconhecer encerramento natural de conversa;
- escolher entre responder, silenciar, reagir ou dar uma despedida curta;
- tratar confusão do usuário com fallback mais explicativo;
- responder de forma diferente em DM e grupo;
- usar personalidade, estado interno, memória e contexto do momento no prompt.

## WhatsApp

A integração com WhatsApp via Baileys permite:

- conectar por QR Code;
- rodar em modo `single`, com um número fazendo tudo;
- rodar em modo `dual`, com uma sessão para observar/aprender e outra para responder/processar mídia;
- responder DMs;
- responder em grupos quando chamada, mencionada ou respondida;
- registrar mensagens recebidas;
- reagir a mensagens;
- enviar stickers em fluxos passivos quando há asset local;
- simular typing/presença em DMs;
- usar delay humano antes de responder;
- agrupar mensagens próximas antes de gerar resposta;
- interromper envio antigo quando chega mensagem nova;
- reconectar após quedas;
- evitar dois runners simultâneos com `.wa-runner.lock`;
- ignorar broadcasts e status;
- deduplicar mensagens repetidas após replay/reconnect.

## Ativação e Controle de Acesso

A Teto possui modo de ativação:

- `/teto-ativar` ativa resposta no privado;
- `/teto-desativar` desativa resposta no privado;
- `/teto-grupo-ativar` ativa resposta em grupo;
- `/teto-grupo-desativar` desativa resposta em grupo;
- `TETOS_ACTIVATION_REQUIRED=true` exige ativação explícita;
- owner pode ser reconhecido por JID/LID configurado;
- grupo ativado ainda exige menção, reply ou contexto para evitar intromissão.

## Grupos

Em grupos, a Teto consegue:

- diferenciar grupo de DM;
- identificar participante da mensagem;
- registrar memória de grupo;
- lembrar contexto recente de grupo;
- responder quando mencionada;
- responder quando alguém dá reply em mensagem dela;
- seguir conversando por uma janela curta após menção/reply;
- ignorar mensagens sem endereçamento;
- aprender com mensagens do grupo sem responder;
- detectar grupos maiores e entrar em modo mais passivo;
- dividir turnos de grupo quando várias pessoas falam;
- responder com quote quando apropriado;
- resolver menções a participantes pelo roster quando possível.

## Comandos de Mídia no WhatsApp

Com prefixo padrão `.`:

- `.sticker` transforma imagem, vídeo ou GIF em figurinha;
- `.fsticker` cria figurinha mantendo o conteúdo visível sem cortar;
- `.csticker` cria figurinha com crop central;
- `.toimg` converte figurinha em imagem/GIF/vídeo;
- `.optimize` comprime figurinha;
- `.removebg` remove fundo de imagem ou figurinha estática;
- `.help` mostra ajuda dos comandos.

A mídia alvo pode vir:

- na própria mensagem;
- em reply;
- do histórico recente de mídia do chat.

## Mídia e Multimodal

A Teto consegue lidar com:

- imagens;
- vídeos;
- GIFs;
- stickers;
- áudios;
- documentos de mídia enviados como arquivo.

Capacidades relacionadas:

- salvar mídia recebida em `data/media`;
- guardar histórico recente de mídia por chat;
- transcrever áudio quando o transcriber está disponível;
- analisar imagem/vídeo/GIF com adapters de visão;
- salvar análises visuais;
- aprender preferências/afinidades de mídia;
- manter memória multimodal por usuário e canal;
- injetar memória multimodal recente no prompt;
- detectar quando uma imagem parece representar a própria Kasane Teto;
- limpar/arquivar mídia antiga com rotina de retenção.

## Memória

A Teto possui várias camadas de memória:

- **short-term memory**: histórico recente por sessão;
- **long-term memory**: fatos e perfis persistidos;
- **medium-term memory**: resumos úteis recentes;
- **selective memory**: memória seletiva antes de promoção;
- **episodic memory**: episódios conversacionais;
- **group memory**: memória específica de grupos;
- **multimodal memory**: mídia + contexto;
- **user style learning**: aprendizado de estilo do usuário;
- **trust/intimacy**: vínculo gradual por usuário/canal;
- **behavior profiles**: padrões comportamentais observados.

Ela consegue:

- salvar fatos extraídos de mensagens;
- lembrar nome, pronomes, apelidos e preferências;
- adaptar resposta ao jeito de digitar do usuário;
- registrar nicknames do usuário e nicknames dados à Teto;
- promover memória seletiva para long-term;
- recuperar contexto relevante antes de responder;
- separar escopos de DM e grupo.

## Reminders

A Teto consegue:

- detectar intenção de criar lembrete em linguagem natural;
- criar reminders com texto e horário;
- listar reminders;
- concluir reminders;
- persistir reminders em `data/reminders.json`;
- varrer reminders vencidos periodicamente;
- entregar reminders vencidos pelo WhatsApp;
- registrar tentativas de entrega;
- registrar erro de entrega;
- aplicar limite de tentativas;
- aplicar retry/backoff;
- expor reminders por API (`GET /reminders`).

Filtros disponíveis:

- `open`;
- `pending`;
- `delivered`;
- `failed`.

## Documentos Locais

A Teto consegue:

- listar documentos em `data/documents`;
- ler documentos locais;
- escrever/atualizar documentos;
- usar contexto de documentos durante a conversa;
- detectar intenções relacionadas a documentos;
- executar escrita assistida com LLM;
- expor documentos por API.

Formatos pensados para uso local:

- `.txt`;
- `.md`;
- `.json`.

## Busca e Leitura Web

A Teto possui módulo de busca:

- endpoint `POST /search`;
- busca integrada ao pipeline de conversa;
- resultados podem entrar como contexto no prompt;
- adapter de leitura/busca reutilizado por módulos de mundo, música e autonomia.

Observação: a qualidade dessa capacidade depende do adapter configurado e do ambiente com acesso à rede quando aplicável.

## Operações Administrativas

A Teto consegue:

- detectar intenções administrativas explícitas;
- detectar algumas intenções administrativas em linguagem natural;
- executar operações via `POST /operations`;
- alterar estado de canais;
- usar confirmação segura para operações sensíveis;
- manter confirmações pendentes;
- cancelar operação quando o usuário nega;
- bloquear execução quando faltam permissões.

Exemplos de superfície:

- administrar canal;
- mutar/bloquear conforme operação implementada;
- ler/escrever documentos via operação;
- responder a confirmações.

## Vida, Emoção e Autonomia

O `BrainOrchestrator` dá à Teto uma camada contínua de estado interno:

- rotina de vida;
- sono e disponibilidade;
- corpo/necessidades;
- saúde;
- emoção;
- mundo/contexto;
- social graph;
- confiança e intimidade;
- música;
- repetição;
- memória orquestrada;
- pensamentos/autonomia;
- insights criativos;
- narrador consciente/subconsciente.

Essas camadas influenciam:

- se ela responde agora ou segura;
- timing de leitura/pensamento/digitação;
- humor e energia da resposta;
- iniciativa para puxar assunto;
- sensibilidade em mensagens vulneráveis;
- comportamento em horários de sono;
- foco/ocupação em atividades internas.

## Iniciativa e Presença

A Teto pode puxar assunto sozinha quando configurada:

- avalia usuários conhecidos;
- respeita cooldown;
- respeita limite diário por usuário;
- evita madrugada;
- evita usuários que pediram espaço;
- evita iniciar se o usuário está ativo demais;
- usa `InitiationEngine` e `BasicLoop`;
- envia iniciativa pelo WhatsApp quando há destino resolvido.

Configs relacionadas:

- `PRESENCE_ENABLED`;
- `PRESENCE_CHECK_MS`;
- `PRESENCE_MIN_COOLDOWN_MS`;
- `PRESENCE_MAX_COOLDOWN_MS`;
- `PRESENCE_MAX_DAILY_PER_USER`;
- `PRESENCE_INACTIVE_MS`;
- `TETOS_INITIATION_CHANCE`.

## Aprendizado e Relatórios

A Teto consegue:

- registrar eventos no learning ledger;
- anonimizar terceiros conforme configuração;
- construir perfil comportamental;
- manter foco de aprendizado;
- gerar relatório diário;
- criar timeline horária nos relatórios;
- absorver padrões a partir dos eventos;
- alimentar insights criativos;
- guardar logs de mente em modo `slim` ou `full`;
- aplicar retenção nos mind logs antigos.

## Observabilidade

A Teto expõe e persiste:

- logs estruturados;
- métricas;
- resumo de runtime;
- resumo de memória;
- resumo de reminders;
- resumo de logs;
- status operacional;
- contadores de eventos importantes.

Endpoints úteis:

- `GET /status`;
- `GET /runtime/summary`;
- `GET /logs`;
- `GET /metrics`;
- `GET /memory`;
- `GET /memory/multimodal`;
- `GET /reminders`.

## API HTTP

Principais capacidades via API:

- conversar: `POST /chat`;
- forçar nudge: `POST /nudge`;
- salvar memória: `POST /memory/save`;
- apagar memória: `POST /memory/delete`;
- buscar memória: `GET /memory/search` e `POST /memory/search`;
- limpar sessão: `POST /session/clear`;
- consultar canais: `GET /channels`;
- administrar canais: `POST /channels/admin`;
- buscar: `POST /search`;
- listar/ler/escrever documentos;
- consultar reminders;
- executar operações;
- consultar logs, métricas e status.

## Ferramentas de Manutenção

Scripts úteis:

- `npm run mind:watch` acompanha logs/mente;
- `npm run learn:focus` abre console de foco de aprendizado;
- `npm run life:distill` destila conhecimento absorvido;
- `npm run data:sanitize` sanitiza dados;
- `npm run wa:clear-sessions` limpa sessões do WhatsApp;
- `npm run test:brain:all` valida a malha de comportamento;
- `npm run test:all` roda testes principais da API/memória/chat.

## Limites e Dependências

Algumas capacidades dependem de configuração externa:

- conversa depende de Ollama local, Ollama Cloud ou MiniMax;
- busca web depende do adapter e acesso à rede;
- WhatsApp depende de sessão Baileys autenticada;
- entrega de reminders depende do runner WhatsApp conectado;
- visão/áudio dependem dos adapters e binários disponíveis;
- `.removebg` pode usar remove.bg ou fallback local conforme tipo de mídia/configuração;
- sticker-only passivo precisa de assets com os nomes esperados (`ack.webp`, `ok.webp`, `thumbs_up.webp`, `heart.webp`) ou ajuste no planner.

## Resumo Curto

A Teto não é apenas um chatbot. Ela é um runtime local com:

- conversa com memória;
- WhatsApp real;
- comandos de mídia;
- reminders entregáveis;
- documentos locais;
- busca;
- autonomia/presença;
- vida, emoção e timing;
- aprendizagem contínua;
- observabilidade e operação via API.
