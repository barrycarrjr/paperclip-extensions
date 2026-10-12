/**
 * Images sent in a DM, fetched from Slack so Clippy can see them.
 *
 * Slack keeps a DM's files behind the bot token. The plugin asks files.info
 * about each image, which needs the files:read bot scope and so names a
 * missing scope plainly, then downloads its url_private_download with the
 * token. Paperclip stores each image the way the app's own chat composer
 * stores one, within the caps below, which this side checks first so it
 * never downloads an image Paperclip would refuse.
 */
import { ErrorCode } from "@slack/web-api";
import { type ResolvedWorkspace, wrapSlackError } from "./slackClient.js";
import type { DmFile } from "./socketMode.js";

/** Image types Clippy can be shown; any other file keeps the plain note. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** The most images one message hands Clippy, as in the app's composer. */
export const MAX_DM_IMAGES = 8;

/** Size caps on a message's images, measured in base64, the form a model's API receives. */
export interface DmImageLimits {
  perImageBase64Bytes: number;
  totalBase64Bytes: number;
}

/**
 * Paperclip's caps on a chat turn's images, the ones its `ai.complete`
 * applies too: 10 MB of base64 for one image (7.5 MB of file), the most
 * Claude's API accepts, and 24 MB for all of a message's images (about
 * 18 MB).
 */
export const DM_IMAGE_LIMITS: DmImageLimits = {
  perImageBase64Bytes: 10 * 1024 * 1024,
  totalBase64Bytes: 24 * 1024 * 1024,
};

/** How long one download may take. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_FAILED = "the download from Slack failed";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface DmImage {
  name: string;
  mediaType: string;
  base64: string;
}

/**
 * One image, or why it could not be opened: `reason` in plain words for
 * Clippy, and `cause`, Slack's own answer for the log (null when Slack did
 * nothing wrong, as with a file that is too large).
 */
export type DmImageResult =
  | { ok: true; image: DmImage; base64Bytes: number }
  | { ok: false; reason: string; cause: string | null };

/** Whether Clippy can be shown this file: an image type it reads, with an id to fetch it by. */
export function isDmImage(file: DmFile): boolean {
  const type = file.mimetype === "image/jpg" ? "image/jpeg" : file.mimetype;
  return file.id !== null && type !== null && IMAGE_TYPES.has(type);
}

/**
 * The image type the bytes themselves show, or null for anything else, such
 * as the sign-in page Slack can send in place of a file.
 */
export function imageTypeOf(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const head = bytes.subarray(0, 12).toString("latin1");
  if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** How long `bytes` bytes are once base64-encoded. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** The largest file a base64 cap holds, in words: "7.5 MB", "18 MB". */
function fileSizeFor(base64Bytes: number): string {
  const bytes = Math.floor(base64Bytes / 4) * 3;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

/** Why a file of `bytes` bytes cannot go with the message, or null when it fits. */
function sizeProblem(bytes: number, limits: DmImageLimits, usedBase64Bytes: number): string | null {
  const base64Bytes = base64Length(bytes);
  if (base64Bytes > limits.perImageBase64Bytes) {
    return `it is over the ${fileSizeFor(limits.perImageBase64Bytes)} limit for one image`;
  }
  if (usedBase64Bytes + base64Bytes > limits.totalBase64Bytes) {
    return `with the other images in the message it is over the ${fileSizeFor(limits.totalBase64Bytes)} limit for all of them`;
  }
  return null;
}

/** Why Slack would not give the bot a file, in plain words. */
function unavailableReason(err: unknown): string {
  const e = err as { code?: string; data?: { error?: string; needed?: string } };
  if (e?.code === ErrorCode.PlatformError && e.data?.error === "missing_scope") {
    return `the Slack app is missing the ${e.data.needed ?? "files:read"} permission`;
  }
  return "Slack would not give it to the bot";
}

/** The bot token only ever goes to Slack itself. */
function isSlackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" && (hostname === "slack.com" || hostname.endsWith(".slack.com"));
  } catch {
    return false;
  }
}

/**
 * Downloads one image from a DM with the bot token, unless its size already
 * rules it out. `usedBase64Bytes` is what the message's earlier images take.
 */
export async function fetchDmImage(
  slack: ResolvedWorkspace,
  file: DmFile,
  options: { limits: DmImageLimits; usedBase64Bytes: number; fetchFile: typeof fetch },
): Promise<DmImageResult> {
  const tooLarge = (bytes: number) => sizeProblem(bytes, options.limits, options.usedBase64Bytes);
  let url: string | undefined;
  let size: number | undefined;
  try {
    const info = await slack.client.files.info({ file: file.id ?? "" });
    url = info.file?.url_private_download ?? info.file?.url_private;
    size = info.file?.size;
  } catch (err) {
    return { ok: false, reason: unavailableReason(err), cause: wrapSlackError(err) };
  }
  if (!url || !isSlackUrl(url)) {
    return { ok: false, reason: "Slack would not give it to the bot", cause: "files.info gave no Slack download address" };
  }
  const tooLargeBySlack = typeof size === "number" ? tooLarge(size) : null;
  if (tooLargeBySlack) return { ok: false, reason: tooLargeBySlack, cause: null };

  let bytes: Buffer;
  try {
    const res = await options.fetchFile(url, {
      headers: { Authorization: `Bearer ${slack.client.token ?? ""}` },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: DOWNLOAD_FAILED, cause: `the download answered HTTP ${res.status}` };
    // Slack can answer a token it will not honour for files with its sign-in
    // page and a 200, not an error.
    if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
      return {
        ok: false,
        reason: DOWNLOAD_FAILED,
        cause: "the download answered with a web page instead of the file (the bot token may lack files:read)",
      };
    }
    const declared = Number(res.headers.get("content-length") ?? Number.NaN);
    const tooLargeByHeader = Number.isFinite(declared) ? tooLarge(declared) : null;
    if (tooLargeByHeader) return { ok: false, reason: tooLargeByHeader, cause: null };
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    const error = err as Error;
    return {
      ok: false,
      reason: DOWNLOAD_FAILED,
      cause:
        error?.name === "TimeoutError"
          ? `the download took longer than ${DOWNLOAD_TIMEOUT_MS / 1000} seconds`
          : `the download failed: ${error?.message ?? String(err)}`,
    };
  }
  if (bytes.length === 0) return { ok: false, reason: "the file is empty", cause: null };
  const tooLargeByBytes = tooLarge(bytes.length);
  if (tooLargeByBytes) return { ok: false, reason: tooLargeByBytes, cause: null };
  const mediaType = imageTypeOf(bytes);
  if (!mediaType) return { ok: false, reason: "it is not a PNG, JPEG, GIF or WebP image", cause: null };
  return {
    ok: true,
    image: { name: file.name, mediaType, base64: bytes.toString("base64") },
    base64Bytes: base64Length(bytes.length),
  };
}
