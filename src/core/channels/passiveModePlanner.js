export function planPassiveModeResponse({ policyReason, closeDecision, hasDirectMention = false, isQuestion = false } = {}) {
  if (closeDecision === "react") {
    return { mode: "react_only" };
  }

  if (hasDirectMention) {
    return { mode: "full" };
  }

  if (policyReason === "passive-question") {
    return Math.random() < 0.25 ? { mode: "react_only" } : { mode: "full" };
  }

  if (policyReason === "passive-random") {
    return { mode: isQuestion ? "full" : "react_only" };
  }

  return { mode: "full" };
}
