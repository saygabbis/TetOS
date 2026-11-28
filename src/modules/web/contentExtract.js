/**
 * Conteúdo de arquivo/link pra Teto ler e resumir sozinha (sem a pessoa copiar e colar o texto).
 * - texto/código/legenda: lê direto · docx/pptx/odt: tira o texto do XML (unzip)
 * - pdf/doc/rtf/epub…: pelo Convenus (converte pra txt) · áudio/vídeo: transcreve
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

/** A pessoa pediu resumo / explicação do conteúdo? */
export function wantsSummary(text = "") {
  return /(?<!\p{L})(resum\p{L}*|sum[aá]rio|tl;?dr|sintetiz\p{L}*|do que (se )?trata|sobre o que (é|fala)|o que (ele|ela|o v[ií]deo|o arquivo|o texto|o pdf|isso) (diz|fala)|explica (o|esse|essa|isso)|pontos principais|principais pontos|me conta o que tem)(?!\p{L})/iu.test(
    String(text)
  );
}

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "log", "srt", "vtt", "ass", "xml", "yml", "yaml", "ini", "cfg",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "c", "cpp", "h", "cs", "go", "rs", "rb", "php", "lua", "sh", "bat", "ps1", "sql", "css", "html", "htm"
]);
const OFFICE_XML = { docx: "word/document.xml", pptx: "ppt/slides/slide*.xml", odt: "content.xml", odp: "content.xml", xlsx: "xl/sharedStrings.xml", ods: "content.xml" };
const AV_EXT = new Set(["mp3", "m4a", "ogg", "opus", "wav", "flac", "aac", "mp4", "mkv", "webm", "mov", "m4v", "avi"]);

const stripXml = (s) =>
  String(s)
    .replace(/<\/(w:p|a:p|text:p|p|div|br|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}\n…(cortei aqui: o arquivo continua)` : s);

/** Extensão a partir do nome, do mime ou do caminho. */
function extOf(path, name, mime) {
  const fromName = extname(String(name || "")).slice(1).toLowerCase();
  if (fromName) return fromName;
  const m = String(mime || "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("presentationml")) return "pptx";
  if (m.includes("spreadsheetml")) return "xlsx";
  if (m.startsWith("text/")) return "txt";
  return extname(String(path)).slice(1).toLowerCase();
}

/**
 * Texto de um arquivo. Retorna { text, kind } ou null (formato que não dá pra ler).
 * @param {{ name?: string, mime?: string, convenus?: any, transcribe?: (path: string) => Promise<string|null>, maxChars?: number }} opts
 */
export async function extractFileText(path, { name = "", mime = "", convenus = null, transcribe = null, maxChars = 40_000 } = {}) {
  if (!path || !existsSync(path) || !statSync(path).size) return null;
  const ext = extOf(path, name, mime);

  if (TEXT_EXT.has(ext)) {
    const raw = readFileSync(path, "utf8");
    const text = /^html?$/.test(ext) ? stripXml(raw.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")) : raw;
    return { text: clip(text.trim(), maxChars), kind: "texto" };
  }

  if (OFFICE_XML[ext]) {
    const r = spawnSync("unzip", ["-p", path, OFFICE_XML[ext]], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, windowsHide: true });
    const text = r.status === 0 ? stripXml(r.stdout) : "";
    if (text) return { text: clip(text, maxChars), kind: ext };
  }

  if (AV_EXT.has(ext) && typeof transcribe === "function") {
    const text = await transcribe(path).catch(() => null);
    if (text) return { text: clip(String(text).trim(), maxChars), kind: "transcrição" };
    return null;
  }

  if (convenus?.convertFile) {
    for (const to of ["txt", "md", "html"]) {
      try {
        const out = await convenus.convertFile(path, to, { name: name || undefined });
        if (out?.path && existsSync(out.path)) {
          const raw = readFileSync(out.path, "utf8");
          const text = to === "html" ? stripXml(raw) : raw.trim();
          if (text) return { text: clip(text, maxChars), kind: ext || "arquivo" };
        }
      } catch {
        /* tenta o próximo formato */
      }
    }
  }
  return null;
}

/** Bloco do prompt com o conteúdo do arquivo (vai só no prompt, não no histórico). */
export function formatFileContextBlock({ name = "", text = "", kind = "", summary = false } = {}) {
  if (!text) return null;
  return [
    `[ARQUIVO QUE TE MANDARAM${name ? ` — ${name}` : ""}${kind ? ` (${kind})` : ""}] — você abriu e leu:`,
    text,
    summary
      ? "Pediram resumo/explicação: responda com base SÓ nesse conteúdo, os pontos principais em bolhas curtas do seu jeito (pode usar 1 bolha um pouco maior com tópicos se o conteúdo for grande). Não peça pra colarem o texto: você já tem."
      : "Use esse conteúdo pra responder o que perguntarem sobre o arquivo. Não peça pra colarem o texto: você já tem."
  ].join("\n");
}
