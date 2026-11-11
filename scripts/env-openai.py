"""Deixa o .env pronto pra API da OpenAI (gpt-6-luna), sem apagar nada do que já tem.

Uso: python3 scripts/env-openai.py [.env]
- troca TETOS_LLM_PROVIDER para openai e o gerador de imagem para openai;
- coloca o bloco da OpenAI logo abaixo de TETOS_LLM_PROVIDER, com TETOS_OPENAI_API_KEY vazio
  (se já existir uma chave lá, ela é mantida);
- faz backup em .env.bak-openai antes de mexer.
"""
import re
import shutil
import sys

path = sys.argv[1] if len(sys.argv) > 1 else ".env"
text = open(path, encoding="utf-8").read()
shutil.copyfile(path, path + ".bak-openai")

current_key = ""
m = re.search(r"^TETOS_OPENAI_API_KEY=(.*)$", text, re.M)
if m:
    current_key = m.group(1).strip()

# Tira um bloco antigo deste script (pra rodar de novo sem duplicar).
text = re.sub(r"\n# >>> OpenAI \(gpt-6-luna\)[\s\S]*?# <<< OpenAI\n", "\n", text)

block = f"""
# >>> OpenAI (gpt-6-luna) ---------------------------------------------------
# COLE A CHAVE AQUI (platform.openai.com/api-keys), sem aspas e sem espaço:
TETOS_OPENAI_API_KEY={current_key}
TETOS_OPENAI_MODEL=gpt-6-luna
# Quanto ela "pensa" antes de responder: none | low | medium | high (mais = mais caro e lento).
TETOS_OPENAI_REASONING=low
TETOS_OPENAI_WORKER_REASONING=none
TETOS_OPENAI_CODE_REASONING=medium
# flex = metade do preço nas tarefas de fundo (mente, memória); deixe vazio pra preço normal.
TETOS_OPENAI_WORKER_SERVICE_TIER=flex
# Teto por dia (US$) das tarefas de fundo; a conversa nunca é barrada. 0 = sem teto.
TETOS_OPENAI_DAILY_BUDGET_USD=0.30
# Busca na web: auto (DuckDuckGo grátis, OpenAI se falhar) | openai | duckduckgo
TETOS_SEARCH_BACKEND=auto
# Voz dos áudios: edge (grátis, a voz de sempre) | openai (gpt-4o-mini-tts)
TETOS_TTS_PROVIDER=edge
TETOS_OPENAI_TTS_VOICE=nova
# Imagem (.gerar): low | medium | high
TETOS_OPENAI_IMAGE_QUALITY=low
# <<< OpenAI
"""

if re.search(r"^TETOS_LLM_PROVIDER=.*$", text, re.M):
    text = re.sub(r"^TETOS_LLM_PROVIDER=.*$", lambda _: "TETOS_LLM_PROVIDER=openai\n" + block.rstrip("\n"), text, count=1, flags=re.M)
else:
    text = "TETOS_LLM_PROVIDER=openai\n" + block + text

if re.search(r"^TETOS_IMAGE_GEN_PROVIDER=.*$", text, re.M):
    text = re.sub(r"^TETOS_IMAGE_GEN_PROVIDER=.*$", "TETOS_IMAGE_GEN_PROVIDER=openai", text, flags=re.M)

open(path, "w", encoding="utf-8", newline="\n").write(text)
print(f"ok: {path} pronto (backup em {path}.bak-openai); chave {'mantida' if current_key else 'vazia, cole em TETOS_OPENAI_API_KEY='}")
