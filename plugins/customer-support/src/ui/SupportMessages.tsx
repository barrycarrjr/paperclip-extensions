import { useState } from "react";
import type { OutboundRow } from "../support-outbound.js";
export function SupportMessages({ companyId,caseId,reviewVersion,source,software,routes,rows,onChanged }: {
  companyId: string; caseId: string; reviewVersion: number; source: string; software: boolean;
  routes: { id: string; productName: string; destinationKind: string }[]; rows: OutboundRow[]; onChanged: () => void;
}) {
  const [kind,setKind] = useState(source === "slack" ? "slack_reply" : "vendor_email");
  const [routeId,setRouteId] = useState("");
  const [subject,setSubject] = useState("");
  const [body,setBody] = useState("");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null);
  async function post(action: string,data: Record<string,unknown>) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/outbound/${action}`,{ method: "POST",credentials: "same-origin",headers: { "Content-Type": "application/json" },body: JSON.stringify({ companyId,...data }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const input = "w-full rounded-md border border-border bg-background p-2 text-sm";
  const button = "rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50";
  return <section className="space-y-3 rounded-md border border-border p-3">
    <h3 className="font-semibold">Replies and vendor emails</h3>
    <p className="text-sm text-muted-foreground">Save a draft, review its exact destination and message, then approve sending. Your account needs support reply permission. Credentials stay in the channel plugin.</p>
    {(source === "slack" || software) && <div className="space-y-2">
      <label className="block text-sm">Message type<select className={input} value={kind} onChange={e => setKind(e.target.value)}>
        {source === "slack" && <option value="slack_reply">Reply in the original Slack thread</option>}
        {software && <option value="vendor_email">Email the software vendor</option>}
      </select></label>
      {kind === "vendor_email" && <>
        <label className="block text-sm">Software product<select className={input} value={routeId} onChange={e => setRouteId(e.target.value)}><option value="">Choose an email route</option>{routes.filter(r => r.destinationKind === "email").map(r => <option key={r.id} value={r.id}>{r.productName}</option>)}</select></label>
        <label className="block text-sm">Subject<input className={input} value={subject} maxLength={300} onChange={e => setSubject(e.target.value)} /></label>
      </>}
      <label className="block text-sm">Reviewed message (no passwords)<textarea className={input} rows={5} value={body} maxLength={10000} onChange={e => setBody(e.target.value)} /></label>
      <button type="button" className={button} disabled={busy || !body.trim() || (kind === "vendor_email" && (!routeId || !subject.trim()))} onClick={() => post("draft",{ kind,routeId,subject,body,expectedReviewVersion: reviewVersion })}>Save draft for review</button>
    </div>}
    {source !== "slack" && !software && <p className="text-sm text-muted-foreground">Automated replies for this source are not available yet. Use the source help desk.</p>}
    {rows.map(row => <article key={row.id} className="space-y-2 rounded-md border border-border p-3 text-sm">
      <p className="font-medium">{row.kind === "slack_reply" ? "Slack reply" : "Vendor email"} · {row.status.replaceAll("_"," ")}</p>
      <p>Via {row.provider}, account {row.account}</p>
      {row.policy_authorization && <p className="text-muted-foreground">Automatic update authorized by the company investigation policy. It does not represent human repair approval.</p>}
      <p>{row.destination.to ? `To: ${row.destination.to}` : `Workspace: ${row.destination.workspaceId} · Channel: ${row.destination.channelId} · Thread: ${row.destination.threadTs}`}</p>
      {row.destination.subject && <p>Subject: {row.destination.subject}</p>}
      <pre className="whitespace-pre-wrap break-words font-sans">{row.body}</pre>
      <details><summary className="cursor-pointer text-muted-foreground">Message fingerprint</summary><code className="break-all">{row.content_sha256}</code></details>
      {row.external_reference && <p>Provider receipt: {row.external_reference}</p>}
      {row.status === "sent" && <p>Accepted by the provider. This does not mean the recipient read it.</p>}
      {row.status === "pending" && <p>Waiting for a receipt. Refresh this case to check; do not send another copy.</p>}
      {row.status === "unknown" && <p>Delivery is uncertain. Check the provider before any new message; automatic retry is blocked.</p>}
      {row.status === "draft" && !row.policy_authorization && <button type="button" className={button} disabled={busy || row.case_review_version !== reviewVersion} onClick={() => post("send",{ deliveryId: row.id,contentSha256: row.content_sha256 })}>Approve and send this exact message</button>}
      {row.status === "draft" && row.case_review_version !== reviewVersion && <p>The case changed. Save a new reviewed draft.</p>}
      {row.status === "not_sent" && <><p>No accepted provider send was recorded. Check the connection and prepare a new reviewed message.</p>{!row.policy_authorization && <button type="button" className={button} disabled={busy} onClick={() => post("retry",{ deliveryId: row.id })}>Prepare a new retry draft</button>}</>}
    </article>)}
    <button type="button" className={button} disabled={busy} onClick={onChanged}>Refresh delivery receipts</button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
