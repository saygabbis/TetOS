import { PendingImageRequests, QUALITY_LABEL, fmtUsd, formatImageEstimate, parseImageArgs, usdToBrlRate } from "./imageStudio.js";
import { STYLES } from "./linkCommandRunner.js";

/**
 * .gerar / .gerarhd / .editar / .editarhd, igual no zap e no Discord.
 *  - econômico: roda na hora.
 *  - modo bom: manda a estimativa (tokens, US$, tempo) e guarda o pedido esperando "sim".
 */

export const IMAGE_COMMANDS = Object.freeze(["gerar", "gerarhd", "editar", "editarhd"]);
const HD_QUALITIES = new Set(["high", "xhigh", "max"]);
const EDITABLE = new Set(["image", "sticker", "photo"]);

export const isImageCommand = (name) => IMAGE_COMMANDS.includes(String(name ?? "").toLowerCase());
export const imageCommandNeedsMedia = (name) => /^editar/.test(String(name ?? ""));

export const pendingImageKey = PendingImageRequests.keyOf;

function usageText(command, p) {
  return command.startsWith("editar")
    ? `responde a imagem com o que mudar, tipo ${p}${command} deixa o céu roxo e coloca neve${command === "editarhd" ? "" : `\n(${p}editarhd faz no modo bom)`}`
    : `me fala o que desenhar, tipo ${p}${command} ${command === "gerarhd" ? "ultra 16:9 " : ""}gato astronauta em aquarela${command === "gerarhd" ? "" : `\n(${p}gerarhd faz no modo bom)`}`;
}

/**
 * Começa um comando de imagem.
 * @returns {Promise<{ text?: string, result?: any, caption?: string, pending?: boolean }>}
 *   text = só responder (uso, estimativa pra confirmar, erro) · result = imagem pronta pra mandar
 */
export async function startImageCommand(command, args = [], { service, isOwner = false, images = [], pendingKey, userId = "default", prefix = ".", style = STYLES.whatsapp, notify = null } = {}) {
  const p = prefix || ".";
  const cmd = String(command ?? "").toLowerCase();
  if (!service?.isEnabled?.()) return { text: "geração de imagem tá desligada agora 😕" };
  const opts = parseImageArgs(args);
  if (!opts.prompt) return { text: usageText(cmd, p) };
  const edit = cmd.startsWith("editar");
  if (edit && !service.canUseOpenAI?.()) return { text: "editar imagem precisa da OpenAI, que tá desligada agora 😕" };
  const usable = images.filter((m) => m?.path && (EDITABLE.has(m.type) || /^image\//.test(m.mimetype ?? "")) && !m.isAnimated);
  if (edit && !usable.length) return { text: `pra editar eu preciso de uma imagem: responde a foto com ${p}${cmd} <o que mudar> 🙏` };

  let tier = cmd.endsWith("hd") || HD_QUALITIES.has(opts.quality) ? "hd" : "eco";
  let note = "";
  // .gerarhd/.editarhd são só da dona (gastam os créditos dela): os outros nem caem no econômico.
  if (cmd.endsWith("hd") && !isOwner) {
    return { text: `o ${p}${cmd} é exclusivo da Gabbis 😤 usa o ${p}${edit ? "editar" : "gerar"} que é liberado pra todo mundo` };
  }
  if (tier === "hd" && !service.canUseHd?.({ isOwner })) {
    if (!service.canUseOpenAI?.()) return { text: "o modo bom precisa da OpenAI, que tá desligada agora 😕" };
    tier = "eco";
    note = "\n(o modo bom é só com a dona, então fiz no econômico)";
  }
  const plan = service.plan({
    tier,
    prompt: opts.prompt,
    quality: tier === "hd" ? opts.quality : null,
    size: opts.size,
    images: edit ? usable.slice(0, 4).map((m) => m.path) : []
  });

  if (tier === "hd") {
    service.pending.set(pendingKey, plan);
    const brlRate = await usdToBrlRate().catch(() => null);
    return { text: formatImageEstimate(plan, { style, brlRate, prefix: p }), pending: true };
  }

  await notify?.(edit ? `🖌️ editando: ${style.i(opts.prompt.slice(0, 200))}…` : `🎨 desenhando: ${style.i(opts.prompt.slice(0, 200))}…`);
  const result = edit ? await service.runPlan(plan, { userId }) : await service.generate({ prompt: opts.prompt, userId, size: opts.size });
  if (!result?.ok) return { text: `não consegui ${edit ? "editar" : "gerar"}: ${result?.error ?? "erro desconhecido"}` };
  return { result, caption: `✅ prontinho${note}` };
}

/** Roda um pedido do modo bom que a pessoa confirmou. */
export async function runConfirmedImage(plan, { service, userId = "default", style = STYLES.whatsapp, notify = null } = {}) {
  const secs = plan.estimate?.seconds ?? 35;
  await notify?.(`💎 ${plan.edit ? "editando" : "fazendo"} no modo bom… ${secs < 60 ? `uns ${secs}s` : `~${Math.round(secs / 60)} min`}`);
  const result = await service.runPlan(plan, { userId });
  if (!result?.ok) return { text: `não consegui: ${result?.error ?? "erro desconhecido"} (não foi cobrado)` };
  return {
    result,
    caption: `✅ prontinho · ${plan.modelLabel} · ${QUALITY_LABEL[plan.quality] ?? plan.quality} · ${plan.size.replace("x", "×")} · gastou ${style.b(fmtUsd(result.usd))}`
  };
}

/**
 * Resposta a um pedido pendente ("sim"/"não"). null = não era sobre isso.
 * @returns {null | { cancelled: true, text: string } | { plan: object }}
 */
export function takeImageConfirmation(text, { service, pendingKey }) {
  const r = service?.pending?.handleReply?.(pendingKey, text);
  if (!r) return null;
  if (r.cancel) return { cancelled: true, text: "beleza, cancelei 👍" };
  return { plan: r.confirm };
}
