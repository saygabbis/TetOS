/** Comandos de download por URL do agente — equivalentes aos comandos com "." do WhatsApp. */

export const AGENT_URL_DOWNLOAD_COMMANDS = Object.freeze([
  "youtube",
  "yt",
  "twitter",
  "x",
  "tt",
  "instagram",
  "insta",
  "reddit",
  "rd",
  "tiktok",
  "tk",
  "ttok",
  "facebook",
  "fb",
  "download",
  "dl",
  "baixar",
  "thumbnail",
  "thumb"
]);

export const AGENT_URL_DOWNLOAD_ALIASES = Object.freeze({
  yt: "youtube",
  x: "twitter",
  tt: "twitter",
  insta: "instagram",
  rd: "reddit",
  tk: "tiktok",
  ttok: "tiktok",
  fb: "facebook",
  dl: "download",
  baixar: "download",
  thumb: "thumbnail"
});

export const AGENT_URL_DOWNLOAD_COMMAND_PATTERN =
  "youtube|yt|twitter|x|tt|instagram|insta|reddit|rd|tiktok|tk|ttok|facebook|fb|download|dl|baixar|thumbnail|thumb";

export function normalizeAgentUrlDownloadCommand(cmd) {
  const raw = String(cmd ?? "").toLowerCase();
  return AGENT_URL_DOWNLOAD_ALIASES[raw] ?? raw;
}

export function isAgentUrlDownloadCommand(cmd) {
  return AGENT_URL_DOWNLOAD_COMMANDS.includes(String(cmd ?? "").toLowerCase());
}

export function buildUrlDownloadAction(command, url, extraArgs = []) {
  const cmd = normalizeAgentUrlDownloadCommand(command);
  if (!AGENT_URL_DOWNLOAD_COMMANDS.includes(String(command ?? "").toLowerCase()) || !url) {
    return null;
  }
  return {
    type: "url_download",
    command: cmd,
    url: String(url).trim(),
    args: Array.isArray(extraArgs) ? extraArgs.filter(Boolean) : []
  };
}
