import { createHmac, timingSafeEqual } from "node:crypto";

const VAPI_BASE = "https://api.vapi.ai";

export interface VapiClientOptions {
  apiKey: string;
  webhookSecret: string | null;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  expectStatus?: number[];
}

export interface VapiResponse<T> {
  status: number;
  body: T | null;
}

export async function vapiRequest<T = unknown>(
  opts: VapiClientOptions,
  pathPart: string,
  reqOpts: RequestOptions = {},
): Promise<VapiResponse<T>> {
  const url = new URL(VAPI_BASE + pathPart);
  if (reqOpts.query) {
    for (const [k, v] of Object.entries(reqOpts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiKey}`,
    Accept: "application/json",
  };
  if (reqOpts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: reqOpts.method ?? "GET",
      headers,
      body: reqOpts.body !== undefined ? JSON.stringify(reqOpts.body) : undefined,
    });
  } catch (err) {
    throw new Error(`[EVAPI_NETWORK] ${(err as Error).message}`);
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after") ?? "?";
    throw new Error(`[EVAPI_RATE_LIMIT] retry after ${retryAfter}s`);
  }

  const expectOk =
    reqOpts.expectStatus && reqOpts.expectStatus.length > 0
      ? reqOpts.expectStatus.includes(res.status)
      : res.ok;

  let body: unknown = null;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      // tolerate empty / malformed JSON
    }
  }

  if (!expectOk) {
    const message =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    throw new Error(mapStatusToErrorCode(res.status, message));
  }

  return { status: res.status, body: body as T | null };
}

function mapStatusToErrorCode(status: number, msg: string): string {
  if (status === 401) return `[EVAPI_AUTH] ${msg}`;
  if (status === 403) return `[EVAPI_FORBIDDEN] ${msg}`;
  if (status === 404) return `[EVAPI_NOT_FOUND] ${msg}`;
  if (status === 422) return `[EVAPI_INVALID] ${msg}`;
  if (status >= 500) return `[EVAPI_SERVER_${status}] ${msg}`;
  return `[EVAPI_${status}] ${msg}`;
}

/**
 * Vapi signs webhook payloads with HMAC-SHA256 over the raw request body
 * using the webhook secret. The signature is sent as `x-vapi-signature`
 * (hex-encoded). Constant-time compare to avoid timing leaks.
 *
 * Returns true if the signature is valid OR if no secret is configured
 * (in which case the operator is opting out of verification — we log a
 * warning at config-load time so they know).
 */
export function verifyVapiWebhookSignature(
  webhookSecret: string | null,
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!webhookSecret) return true; // opted out
  if (!signatureHeader) return false;

  const expected = createHmac("sha256", webhookSecret)
    .update(rawBody)
    .digest("hex");

  // Strip optional `sha256=` prefix some providers use.
  const provided = signatureHeader.replace(/^sha256=/i, "").trim();

  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}
