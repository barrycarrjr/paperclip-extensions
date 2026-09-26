/**
 * Browser-side client for the plugin's board API routes, plus the few host
 * routes the page uses directly (an issue's attachments, uploading a file to
 * an issue, creating a records issue). The page runs inside Paperclip, so the
 * signed-in person's session cookie authorises both.
 */
import type { BusinessApi, DocumentApi, FilingApi, HistoryApi, LinkApi } from "../domain.js";

const PLUGIN_ID = "business-records";

export interface Overview {
  today: string;
  overdueFilings: FilingApi[];
  filingsDueSoon: FilingApi[];
  documentsRenewingSoon: DocumentApi[];
}

export interface BusinessDetail {
  business: BusinessApi;
  history: HistoryApi[];
  documents: DocumentApi[];
  filings: FilingApi[];
  links: LinkApi[];
  today: string;
}

/** The parts of a host attachment record the page reads. */
export interface HostAttachment {
  id: string;
  issueId: string;
  contentType: string;
  byteSize: number;
  originalFilename: string | null;
  contentPath: string;
  createdAt: string;
}

export interface WriteResult {
  summary: string;
  [key: string]: unknown;
}

function apiUrl(path: string, companyId: string, extra?: Record<string, string>): string {
  const url = new URL(`/api/plugins/${PLUGIN_ID}/api${path}`, window.location.origin);
  url.searchParams.set("companyId", companyId);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * A refusal as a person should read it. The server writes its messages for the
 * agent too, so drop the [ECODE] prefix and any sentence that tells the agent
 * which tool to call or what JSON to send, and say what to do on this page.
 */
export function readableError(message: string): string {
  const code = /^\[(E[A-Z_]+)\]/.exec(message)?.[1] ?? null;
  const stripped = message
    .replace(/^\[E[A-Z_]+\]\s*/, "")
    .replace(/,?\s*(?:added first\s+)?(?:with|using|via)\s+business_[a-z_]+/g, "");
  const sentences = stripped.split(/(?<=\.)\s+/).filter((s) => !/\bbusiness_[a-z_]+\b|\{kind|documentId\}|\bcall again\b/.test(s));
  let text = (sentences.length > 0 ? sentences : [stripped]).join(" ");
  text = text
    .replace(/\bA user_reported source\b/g, "Your own word")
    .replace(/\buser_reported\b/g, "your own word")
    .replace(/\bagent_inference\b/g, "the agent's inference")
    .replace(/\bproofDocumentId:\s*/g, "")
    .replace(/\bproofDocumentId\b/g, "a proof document");
  if (code === "EPROOF_REQUIRED") text += " Add the proof under Documents first, then choose it here.";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

async function send<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(readableError(message));
  }
  return payload as T;
}

const apiGet = <T>(url: string) => send<T>(url);
const apiWrite = (method: "POST" | "PATCH", url: string, body: unknown) =>
  send<WriteResult>(url, { method, body: JSON.stringify(body ?? {}) });

const id = (value: string) => encodeURIComponent(value);

export const recordsApi = {
  list(companyId: string, q: string): Promise<{ businesses: BusinessApi[] }> {
    return apiGet(apiUrl("/businesses", companyId, { q }));
  },
  get(companyId: string, businessId: string): Promise<BusinessDetail> {
    return apiGet(apiUrl(`/businesses/${id(businessId)}`, companyId));
  },
  overview(companyId: string): Promise<Overview> {
    return apiGet(apiUrl("/overview", companyId));
  },

  createBusiness: (companyId: string, body: Record<string, unknown>) =>
    apiWrite("POST", apiUrl("/businesses", companyId), body),
  updateBusiness: (companyId: string, businessId: string, body: Record<string, unknown>) =>
    apiWrite("PATCH", apiUrl(`/businesses/${id(businessId)}`, companyId), body),
  setStatus: (companyId: string, businessId: string, body: Record<string, unknown>) =>
    apiWrite("POST", apiUrl(`/businesses/${id(businessId)}/status`, companyId), body),
  linkIssue: (companyId: string, businessId: string, body: { issueId: string; role: string }) =>
    apiWrite("POST", apiUrl(`/businesses/${id(businessId)}/links`, companyId), body),

  addDocument: (companyId: string, body: Record<string, unknown>) => apiWrite("POST", apiUrl("/documents", companyId), body),
  updateDocument: (companyId: string, documentId: string, body: Record<string, unknown>) =>
    apiWrite("PATCH", apiUrl(`/documents/${id(documentId)}`, companyId), body),
  removeDocument: (companyId: string, documentId: string, reason: string | null) =>
    apiWrite("POST", apiUrl(`/documents/${id(documentId)}/remove`, companyId), { reason }),

  createFiling: (companyId: string, body: Record<string, unknown>) => apiWrite("POST", apiUrl("/filings", companyId), body),
  updateFiling: (companyId: string, filingId: string, body: Record<string, unknown>) =>
    apiWrite("PATCH", apiUrl(`/filings/${id(filingId)}`, companyId), body),
  setFilingStatus: (companyId: string, filingId: string, body: Record<string, unknown>) =>
    apiWrite("POST", apiUrl(`/filings/${id(filingId)}/status`, companyId), body),
};

/** Host routes, called with the person's own session. */
export const hostApi = {
  listAttachments(issueId: string): Promise<HostAttachment[]> {
    return apiGet(new URL(`/api/issues/${id(issueId)}/attachments`, window.location.origin).toString());
  },
  uploadAttachment(companyId: string, issueId: string, file: File): Promise<HostAttachment> {
    const form = new FormData();
    form.append("file", file);
    return send(new URL(`/api/companies/${id(companyId)}/issues/${id(issueId)}/attachments`, window.location.origin).toString(), {
      method: "POST",
      body: form,
    });
  },
  createIssue(companyId: string, title: string, description: string): Promise<{ id: string; identifier: string | null }> {
    return send(new URL(`/api/companies/${id(companyId)}/issues`, window.location.origin).toString(), {
      method: "POST",
      body: JSON.stringify({ title, description, status: "backlog" }),
    });
  },
};
