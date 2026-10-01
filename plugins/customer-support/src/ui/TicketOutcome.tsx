import { useState } from "react";
export function TicketOutcome({ companyId,caseId,reviewVersion,messageId,onChanged }: { companyId: string; caseId: string; reviewVersion: number; messageId: string; onChanged: () => void }) {
  const [outcome,setOutcome] = useState("needs_follow_up"); const [basis,setBasis] = useState("not_confirmed");
  const [summary,setSummary] = useState(""); const [evidence,setEvidence] = useState("");
  const [busy,setBusy] = useState(false); const [error,setError] = useState<string | null>(null); const [notice,setNotice] = useState<string | null>(null);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/ticket/outcome`,{ method: "POST",credentials: "same-origin",headers: { "Content-Type": "application/json" },body: JSON.stringify({ companyId,expectedReviewVersion: reviewVersion,expectedMessageId: messageId,outcome,basis,summary,evidence }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setNotice(`Outcome recorded. Original thread update: ${result.delivery?.status ?? "not requested"}.${result.issueStatus === "needs_operator_review" ? " The linked work item needs manual review." : ""}`); onChanged();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not record outcome"); }
    finally { setBusy(false); }
  }
  return <form onSubmit={save} className="space-y-3 rounded-md border border-border p-3 text-sm">
    <h3 className="font-semibold">Confirm the reported problem</h3>
    <p className="text-muted-foreground">A repair operator records actual symptom evidence or verifies the requester’s confirmation. A successful command alone does not close the case. Reject unused current proposals first; running or unknown outcomes need inspection.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label>Outcome<select value={outcome} onChange={event => setOutcome(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2"><option value="needs_follow_up">Needs follow-up</option><option value="still_present">Still present / reopen</option><option value="resolved">Resolved</option></select></label>
      <label>Evidence basis<select value={basis} onChange={event => setBasis(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2"><option value="not_confirmed">Not confirmed yet</option><option value="person_confirmed">Requester confirmed; operator verified</option><option value="observed">Original symptom observed as resolved</option></select></label>
    </div>
    <label className="block">Summary<textarea required maxLength={2000} value={summary} onChange={event => setSummary(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
    <label className="block">Original symptom evidence<textarea required maxLength={2000} value={evidence} onChange={event => setEvidence(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
    <button type="submit" disabled={busy || (outcome === "resolved" && basis === "not_confirmed")} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">{busy ? "Saving…" : "Confirm and record outcome"}</button>
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status" className="text-muted-foreground">{notice}</p>}
  </form>;
}
