const TAKEOVER_OPTIONS = [
  { id: "done", label: "Pronto, já fiz" },
  { id: "refuse", label: "Não quero fazer / desistir" },
];

const APPROVAL_OPTIONS = [
  { id: "approve", label: "Aprovar" },
  { id: "deny", label: "Negar" },
];

function textOf(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function optionsOf(question) {
  if (!Array.isArray(question?.options)) return [];
  return question.options
    .filter((option) => option && typeof option.id === "string" && typeof option.label === "string")
    .map((option) => ({ id: option.id, label: option.label }));
}

/**
 * Traduz uma clarificação do AutoMate no pedido que a UI mostra.
 * @param {object} params
 * @param {string} requestId
 */
export function clarificationUi(params, requestId) {
  const kind = params?.kind ?? "question";
  const question = Array.isArray(params?.questions) ? params.questions[0] : undefined;
  const prompt = textOf(question?.prompt, params?.question, params?.prompt) || "Preciso da sua resposta";
  const options = optionsOf(question);
  const takeover = kind === "takeover" || kind === "manual_action" || kind === "action";

  if (takeover) {
    const choices = options.length > 0 ? options : TAKEOVER_OPTIONS;
    return {
      channel: "request_user_takeover",
      eventType: "control.request",
      request: {
        id: requestId,
        title: prompt,
        detail: "",
        question: prompt,
        input: "takeover",
        options: choices,
        acceptLabel: choices[0].label,
        denyLabel: choices[1]?.label ?? "Negar",
      },
    };
  }

  if (kind === "approval") {
    const choices = options.length > 0 ? options : APPROVAL_OPTIONS;
    return {
      channel: "ask_user",
      eventType: "permission.request",
      request: {
        id: requestId,
        question: prompt,
        input: "approval",
        options: choices,
        confirmLabel: choices[0].label,
        denyLabel: choices[1]?.label ?? "Negar",
      },
    };
  }

  const type = question?.type ?? (options.length > 0 ? "single_choice" : "free_text");
  const input = type === "free_text" || options.length === 0 ? "text" : "choice";
  return {
    channel: "ask_user",
    eventType: "permission.request",
    request: {
      id: requestId,
      question: prompt,
      input,
      ...(options.length > 0 ? { options } : {}),
      ...(type === "multiple_choice" ? { multiple: true } : {}),
    },
  };
}
