import { describe, expect, it, beforeAll } from "vitest";
import { registerAutomateRun } from "../../src/integrations/automate/automateRunContext.js";
import { translateAutomateNotification } from "../../src/integrations/automate/eventTranslator.js";

describe("eventTranslator", () => {
  beforeAll(() => {
    registerAutomateRun({
      instructionId: "inst-1",
      runId: "run-et-1",
      threadId: "thread-et-1",
    });
  });

  it("traduz tool_call start", () => {
    const events = translateAutomateNotification("notifications/automate/tool_call", {
      instructionId: "inst-1",
      tool: "window_list",
      status: "start",
      turnId: "t1",
    });
    expect(events[0].type).toBe("plan.step");
    expect(events[0].step.state).toBe("running");
  });

  it("no fim com falha guarda os args e um trecho da saída", () => {
    const events = translateAutomateNotification("notifications/automate/tool_call", {
      instructionId: "inst-1",
      tool: "browser_click_selector",
      status: "end",
      success: false,
      turnId: "t9",
      args: { domId: "d1" },
      output: "clicked:miss elemento não clicável",
    });
    expect(events[0].step).toMatchObject({
      state: "failed",
      args: JSON.stringify({ domId: "d1" }),
      logs: ["clicked:miss elemento não clicável"],
    });
  });

  it("traduz o plano e não publica pensamento de preparação como log", () => {
    const events = translateAutomateNotification("notifications/automate/plan", {
      instructionId: "inst-1",
      items: [
        { text: "abrir o site — feito quando o título aparece", status: "pending" },
        { text: "  ", status: "done" },
        { status: "done" },
      ],
    });
    expect(events).toEqual([
      {
        type: "automate.plan",
        runId: "run-et-1",
        items: [{ text: "abrir o site — feito quando o título aparece", status: "pending" }],
      },
    ]);

    expect(
      translateAutomateNotification("notifications/automate/thinking", {
        instructionId: "inst-1",
        phase: "Planejamento",
        message: "memória, tools e contexto prontos",
      }),
    ).toEqual([]);
    expect(
      translateAutomateNotification("notifications/automate/thinking", {
        instructionId: "inst-1",
        message: "Raciocinando…",
      }),
    ).toEqual([]);
    expect(
      translateAutomateNotification("notifications/automate/thinking", {
        instructionId: "inst-1",
        phase: "Modo autônomo",
        message: "Sem perguntas — inferir e decidir",
      }),
    ).toEqual([]);
  });

  it("emite utterance em user_feedback e tool_call de resposta", () => {
    const direct = translateAutomateNotification("notifications/automate/user_feedback", {
      instructionId: "inst-1",
      message: "Pronto, abri o Bloco de Notas.",
    });
    expect(direct[0]).toMatchObject({
      type: "tool.log",
      stepId: "utterance:user_feedback",
      line: "Pronto, abri o Bloco de Notas.",
    });

    const viaTool = translateAutomateNotification("notifications/automate/tool_call", {
      instructionId: "inst-1",
      tool: "user_feedback",
      status: "done",
      args: { message: "Tudo certo." },
    });
    expect(viaTool.some((e) => e.stepId === "utterance:user_feedback")).toBe(true);
  });

  it("traduz clarification em permission.request e utterance ask_user", () => {
    const events = translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "p1",
      question: "Confirmar?",
    });
    expect(events.some((e) => e.type === "permission.request")).toBe(true);
    expect(events.some((e) => e.stepId === "utterance:ask_user:p1" && e.line === "Confirmar?")).toBe(true);
    expect(events.find((e) => e.type === "permission.request").request.input).toBeUndefined();
  });

  const permissionFor = (question) =>
    translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "p2",
      questions: [question],
    }).find((e) => e.type === "permission.request").request;

  it("pergunta aberta (free_text) pede texto, não Confirmar/Negar", () => {
    const request = permissionFor({ prompt: "O que adiciono nele?", type: "free_text" });
    expect(request.question).toBe("O que adiciono nele?");
    expect(request.input).toBe("text");
    expect(request.options).toBeUndefined();
  });

  it("escolha vira chips com os ids reais das opções", () => {
    const request = permissionFor({
      prompt: "AÇÃO DESTRUTIVA — aprovar?",
      type: "single_choice",
      options: [{ id: "approve", label: "Aprovar" }, { id: "deny", label: "Negar" }],
    });
    expect(request.input).toBe("choice");
    expect(request.options).toEqual([{ id: "approve", label: "Aprovar" }, { id: "deny", label: "Negar" }]);
    expect(request.multiple).toBeUndefined();
    expect(permissionFor({ prompt: "Quais?", type: "multiple_choice", options: [{ id: "a", label: "A" }] }).multiple).toBe(true);
  });

  it("intervenção manual (kind takeover) vira control.request com Pronto/Desistir (ids do AutoMate)", () => {
    const events = translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "t1",
      kind: "takeover",
      questions: [{ prompt: "Faça login no banco", type: "single_choice" }],
    });
    const control = events.find((e) => e.type === "control.request");
    expect(control.request).toMatchObject({ id: "t1", question: "Faça login no banco", input: "takeover" });
    expect(control.request.options.map((o) => o.id)).toEqual(["done", "refuse"]);
    expect(events.some((e) => e.type === "permission.request")).toBe(false);
  });

  it("formulário (kind form) vira input form com um campo por pergunta", () => {
    const request = translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "f1",
      kind: "form",
      context: "Dados do cadastro",
      questions: [
        { id: "email", prompt: "Email", type: "free_text", required: true, input: "email" },
        { id: "uf", prompt: "Estado", type: "single_choice", required: false, input: "select", options: [{ id: "o1", label: "SP" }] },
      ],
    }).find((e) => e.type === "permission.request").request;
    expect(request).toEqual({
      id: "f1",
      question: "Dados do cadastro",
      input: "form",
      fields: [
        { key: "email", label: "Email", type: "email", required: true },
        { key: "uf", label: "Estado", type: "select", required: false, options: [{ id: "o1", label: "SP" }] },
      ],
    });
  });

  it("aprovação de ação sensível pede Aprovar/Negar; texto livre leva as sugestões", () => {
    const approval = translateAutomateNotification("notifications/automate/clarification_needed", {
      instructionId: "inst-1",
      id: "a1",
      kind: "approval",
      questions: [{ prompt: "Apagar a pasta?", type: "single_choice", options: [{ id: "approve", label: "Aprovar" }] }],
    }).find((e) => e.type === "permission.request").request;
    expect(approval.input).toBe("approval");
    expect(permissionFor({ prompt: "Qual pasta?", type: "free_text", suggestions: ["Downloads", 3] }).suggestions).toEqual(["Downloads"]);
  });
});
