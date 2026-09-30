import { useState } from "react";

export function RestrictedSource({ companyId, caseId, messageId }: { companyId: string; caseId: string; messageId: string }) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reveal() {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/messages/${encodeURIComponent(messageId)}/protected-source`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }), cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setSource(JSON.stringify(result, null, 2));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Restricted source unavailable"); }
    finally { setBusy(false); }
  }
  return <div className="mt-2 text-xs">
    <button type="button" disabled={busy} onClick={() => source ? setSource(null) : void reveal()} className="rounded border border-border px-2 py-1 disabled:opacity-50">
      {source ? "Hide restricted original" : busy ? "Opening…" : "View restricted original"}
    </button>
    {source && <div className="mt-2 rounded border border-border bg-background p-2">
      <p className="text-muted-foreground">Restricted to repair operators. This access is audited. Keep access information in Secrets; do not paste it into Clippy or ordinary case notes.</p>
      <pre className="mt-2 whitespace-pre-wrap break-all">{source}</pre>
    </div>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </div>;
}
