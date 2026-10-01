import { useState } from "react";
export function TicketProgress({ companyId,caseId,companyPrefix,job,onChanged }: {
  companyId: string; caseId: string; companyPrefix?: string | null;
  job: { issue_id: string | null; status: string; target_address: string | null; failure_code: string | null }; onChanged: () => void;
}) {
  const [busy,setBusy] = useState(false); const [error,setError] = useState<string | null>(null);
  async function resume() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/ticket/resume`, { method: "POST",credentials: "same-origin",headers: { "Content-Type": "application/json" },body: JSON.stringify({ companyId }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not resume investigation"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-2 rounded-md border border-border p-3 text-sm">
    <h3 className="font-semibold">Automatic investigation · {job.status.replaceAll("_"," ")}</h3>
    {job.issue_id && <a href={`${companyPrefix ? `/${companyPrefix}` : ""}/issues/${job.issue_id}`} className="text-primary underline">Open assigned support work</a>}
    {job.target_address && <p>Computer: {job.target_address}</p>}
    {job.failure_code && <p className="text-muted-foreground">Investigation needs an operator review. Check the company policy, agent, issue and connection. No automatic retry or repair was authorized.</p>}
    {job.status === "needs_operator" && <div><p className="text-muted-foreground">After reviewing the cause, a repair operator can resume diagnostic work under the current policy. This does not approve repairs or resend uncertain messages.</p><button type="button" disabled={busy} onClick={() => void resume()} className="mt-2 rounded-md border border-border px-3 py-1.5 disabled:opacity-50">{busy ? "Queuing…" : "Reviewed: resume investigation"}</button></div>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </section>;
}
