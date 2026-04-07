export const DEFAULTS = {
  model: process.env.TETOS_MODEL ?? "llama3",
  ollamaBaseUrl: process.env.TETOS_OLLAMA_URL ?? "http://localhost:11434",
  memoryPath: process.env.TETOS_MEMORY_PATH ?? "./data/memory.json",
  maxShortTerm: Number(process.env.TETOS_MAX_SHORT ?? 8),
  port: Number(process.env.TETOS_PORT ?? 3000),
  personalityPath: process.env.TETOS_PERSONALITY_PATH ?? "./data/personality.json",
  maxHistory: Number(process.env.TETOS_MAX_HISTORY ?? 12),
  maxContentLength: Number(process.env.TETOS_MAX_CONTENT ?? 2000),
  maxIdLength: Number(process.env.TETOS_MAX_ID ?? 64),
  maxTags: Number(process.env.TETOS_MAX_TAGS ?? 10)
};
