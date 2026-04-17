export function buildRuntimeSummary(runtime) {
  return {
    channels: Object.keys(runtime.channelRegistry?.data?.channels ?? {}).length,
    longTermEntries: runtime.longTerm?.all?.().length ?? 0,
    selectiveEntries: runtime.selectiveMemory?.all?.().length ?? 0,
    documents: runtime.documentModule?.list?.().length ?? 0,
    metrics: runtime.metrics?.getAll?.() ?? null,
    pendingConfirmations: runtime.pendingConfirmations?.data?.entries?.length ?? 0
  };
}
