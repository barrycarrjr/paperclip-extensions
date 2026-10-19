export interface HandOffLink { jobId: string; title: string; hostRunId: string; hostAgentId: string }
export interface HandOffResult { links: HandOffLink[]; notice: string | null }
type Fetcher = typeof fetch;

/** A request correlation ID, never an access token. Plain HTTP may lack randomUUID. */
export function newPauseRequestId(cryptoApi: Partial<Pick<Crypto, "randomUUID" | "getRandomValues">> | undefined = globalThis.crypto): string {
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return `roster-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `roster-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function serverError(payload: unknown, fallback: string): string {
  return payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : fallback;
}
// Use the board's existing authenticated plugin API. Never read another
// plugin's namespace or supply privileged host credentials from the worker.
export async function loadHandOff(companyId: string, fetcher: Fetcher = fetch, signal?: AbortSignal): Promise<HandOffResult> {
  const response = await fetcher(`/api/plugins/handoff-pipeline/api/summary?companyId=${encodeURIComponent(companyId)}`, { credentials: "include", headers: { Accept: "application/json" }, signal });
  if (response.status === 404) return { links: [], notice: "Hand-off is not installed or its summary API is unavailable. Job evidence is unavailable." };
  if (response.status === 403) return { links: [], notice: "Hand-off is not enabled or authorized for this company. Job evidence is unavailable." };
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(serverError(payload, `Hand-off request failed (${response.status}).`));
  const state = (payload as { state?: { companyId?: unknown; jobs?: unknown } } | null)?.state;
  if (state?.companyId !== companyId || !Array.isArray(state.jobs)) throw new Error("Hand-off returned an invalid or mismatched company summary.");
  const links: HandOffLink[] = [];
  for (const job of state.jobs) {
    if (!job || typeof job.id !== "string" || typeof job.title !== "string" || !Array.isArray(job.runs)) throw new Error("Hand-off returned unreadable job evidence.");
    if (job.companyId !== companyId) throw new Error("Hand-off returned job evidence from another company.");
    const seen = new Set<string>();
    // One recent provenance link per agent/job, never infer an owner from a skill.
    for (const run of [...job.runs].reverse()) {
      if (run?.mode !== "production" || typeof run.hostAgentId !== "string" || !run.hostAgentId || typeof run.hostRunId !== "string" || !run.hostRunId || seen.has(run.hostAgentId)) continue;
      seen.add(run.hostAgentId);
      links.push({ jobId: job.id, title: job.title, hostRunId: run.hostRunId, hostAgentId: run.hostAgentId });
    }
  }
  return { links, notice: null };
}
export async function pauseAgent(companyId: string, agentId: string, requestId: string, fetcher: Fetcher = fetch): Promise<void> {
  const response = await fetcher(`/api/plugins/agent-roster/api/agents/${encodeURIComponent(agentId)}/pause?companyId=${encodeURIComponent(companyId)}`, {
    method: "POST", credentials: "include", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed: true, requestId }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(serverError(payload, `Pause failed (${response.status}). Refresh the agent status before retrying.`));
  if (!(payload && typeof payload === "object" && "paused" in payload && payload.paused === true)) throw new Error("Pause returned an unreadable response. Refresh the agent status before retrying.");
}
