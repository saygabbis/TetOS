/** Campos mínimos para relatório diário + debug leve — evita GB/dia na VPS. */
export function compactMindEntry(entry = {}) {
  const brain = entry.brain ?? {};
  const emotion = brain.emotion ?? {};
  const world = brain.worldContext ?? brain.world ?? {};
  const trustBond = brain.trustBond ?? null;
  const health = brain.health ?? emotion.health ?? [];
  const input = entry.input ?? {};
  const output = entry.output ?? {};

  const compact = {
    ts: entry.ts ?? new Date().toISOString(),
    turnId: entry.turnId ?? null,
    input: {
      ...(input.message != null ? { message: String(input.message).slice(0, 240) } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.isGroup != null ? { isGroup: input.isGroup } : {}),
      ...(input.phase ? { phase: input.phase } : {})
    },
    brain: {
      emotion: { mood: emotion.mood ?? null },
      trustBond: trustBond
        ? { trust: trustBond.trust ?? null, intimacy: trustBond.intimacy ?? null }
        : null,
      worldContext: {
        currentLocation: world.currentLocation ?? world.locationLabel ?? null,
        isTraveling: world.isTraveling ?? false
      },
      world: {
        currentLocation: world.currentLocation ?? world.locationLabel ?? null
      },
      health: Array.isArray(health)
        ? health.slice(0, 8).map((item) => ({ type: item?.type ?? item?.name ?? "unknown" }))
        : [],
      ...(brain.conscious
        ? {
            conscious: (Array.isArray(brain.conscious) ? brain.conscious : [brain.conscious])
              .slice(0, 1)
              .map((text) => String(text).slice(0, 160))
          }
        : {})
    },
    output: {
      count: output.count ?? (Array.isArray(output.replies) ? output.replies.length : 0),
      ...(Array.isArray(output.replies) && output.replies[0]
        ? { preview: String(output.replies[0]).slice(0, 160) }
        : output.processed
          ? { preview: String(output.processed).slice(0, 160) }
          : {})
    }
  };

  return compact;
}

export function buildMindRecord(entry = {}, { mode = "slim" } = {}) {
  const record = {
    ts: entry.ts ?? new Date().toISOString(),
    turnId: entry.turnId ?? `turn_${Date.now()}`,
    input: entry.input ?? {},
    brain: entry.brain ?? {},
    promptBlocksUsed: entry.promptBlocksUsed ?? [],
    llm: entry.llm ?? {},
    output: entry.output ?? {}
  };
  if (mode === "full") return record;
  return compactMindEntry(record);
}
