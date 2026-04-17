export function buildMemorySummary(runtime) {
  return {
    longTerm: runtime.longTerm?.all?.().length ?? 0,
    selective: runtime.selectiveMemory?.all?.().length ?? 0,
    multimodal: runtime.multimodalMemory?.list?.().length ?? 0
  };
}
