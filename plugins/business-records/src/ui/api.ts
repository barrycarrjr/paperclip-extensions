/**
 * Browser-side client for the plugin's read-only board API routes.
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

function apiUrl(path: string, companyId: string, extra?: Record<string, string>): string {
  const url = new URL(`/api/plugins/${PLUGIN_ID}/api${path}`, window.location.origin);
  url.searchParams.set("companyId", companyId);
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function apiGet<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export const recordsApi = {
  list(companyId: string, q: string): Promise<{ businesses: BusinessApi[] }> {
    return apiGet(apiUrl("/businesses", companyId, { q }));
  },
  get(companyId: string, businessId: string): Promise<BusinessDetail> {
    return apiGet(apiUrl(`/businesses/${encodeURIComponent(businessId)}`, companyId));
  },
  overview(companyId: string): Promise<Overview> {
    return apiGet(apiUrl("/overview", companyId));
  },
};
