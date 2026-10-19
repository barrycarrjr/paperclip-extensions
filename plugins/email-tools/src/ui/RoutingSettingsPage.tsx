import { useState } from "react";
import { useHostContext, usePluginAction, usePluginData, type PluginSettingsPageProps } from "@paperclipai/plugin-sdk/ui";
import { uiErrorText } from "./error-text.js";

export interface RoutingPanelData {
  mode: string; configReason?: string; destinations: Array<{ key: string; label: string }>; total: number; followups?: number; hasMore: boolean;
  rows: Array<{ id: string; status: string; sender: string; subject: string; receivedAt: string; note: string;
    candidates: string[]; destination: { key: string; label: string } | null; frozen: boolean; canRoute?: boolean; routeUnavailableReason?: string; canRetryFollowups?: boolean;
    issueIdentifier: string | null; wake: string; audit: string; followupError?: string | null; handledByUserId?: string | null; handledAt?: string | null;
    followupsCheckedByUserId?: string | null; followupsCheckedAt?: string | null }>;
}
const control: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: "6px 10px", color: "var(--foreground)", background: "var(--background)" };

export function RoutingSettingsPage(_props: PluginSettingsPageProps) {
  const host = useHostContext();
  const [mailbox, setMailbox] = useState("");
  const [offset, setOffset] = useState(0);
  const [mailboxOffset, setMailboxOffset] = useState(0);
  const scopes = usePluginData<{ scopes: Array<{ key: string; name: string }>; hasMoreMailboxes?: boolean }>("email.list-routing", { companyId: host.companyId, mailboxOffset });
  if (scopes.error != null) return <p role="alert">Mail routing could not load: {uiErrorText(scopes.error)}</p>;
  if (scopes.loading) return <p>Loading mail routing...</p>;
  const list = scopes.data?.scopes ?? [];
  const active = list.find(m => m.key === mailbox)?.key ?? list[0]?.key;
  return <section style={{ color: "var(--foreground)", padding: 16 }}>
    <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Mail routing</h2>
    <p style={{ color: "var(--muted-foreground)", fontSize: 13, margin: "4px 0 16px" }}>Part of email triage. Review suggestions here. Routing leaves the original email unchanged.</p>
    {(mailboxOffset > 0 || scopes.data?.hasMoreMailboxes) && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
        <button style={control} disabled={mailboxOffset === 0} onClick={() => { setMailboxOffset(Math.max(0, mailboxOffset - 100)); setMailbox(""); setOffset(0); }}>Previous recorded mailboxes</button>
        <button style={control} disabled={!scopes.data?.hasMoreMailboxes || mailboxOffset >= 10_000} onClick={() => { setMailboxOffset(mailboxOffset + 100); setMailbox(""); setOffset(0); }}>More recorded mailboxes</button>
    </div>}
    {!active ? <p>No accessible mailbox has this company set as its ingest company. Configure one in the Configuration tab.</p> : <>
      <label>Mailbox <select aria-label="Routing mailbox" style={control} value={active} onChange={e => { setMailbox(e.target.value); setOffset(0); }}>
        {list.map(m => <option key={m.key} value={m.key}>{m.name}</option>)}
      </select></label>
      <RoutingEntries key={active} mailbox={active} companyId={host.companyId} offset={offset} setOffset={setOffset} />
    </>}
  </section>;
}

function RoutingEntries({ mailbox, companyId, offset, setOffset }: { mailbox: string; companyId: string | null; offset: number; setOffset: (v: number) => void }) {
  const query = usePluginData<RoutingPanelData>("email.list-routing", { mailbox, companyId, offset });
  const resolve = usePluginAction("email.resolve-routing-entry");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, { note?: string; outcome?: string; followupError?: string }>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  async function decide(entryId: string, decision: "route" | "dismiss" | "close_manually" | "retry_followups" | "check_followups", destination?: string) {
    setBusy(true); setError("");
    try {
      const result = await resolve({ companyId, mailbox, entryId, decision, destination }) as { followupError?: string; note?: string; outcome?: string } | undefined;
      setFeedback(previous => ({ ...previous, [entryId]: {
        ...(result?.outcome === "waiting" || result?.outcome === "in_progress" ? { outcome: result.outcome, note: result.note } : {}),
        ...(result?.followupError ? { followupError: result.followupError } : {}),
      } }));
      setClosing(null); setChecking(null); await query.refresh();
    }
    catch (e) { setError(uiErrorText(e)); }
    finally { setBusy(false); }
  }
  if (query.error != null) return <p role="alert">Routing entries could not load: {uiErrorText(query.error)}</p>;
  if (!query.data) return <p>Loading routing entries...</p>;
  const data = query.data;
  return <>
    <p>Mode: {data.mode}. Waiting for the operator: {data.total}. Handoffs needing follow-ups: {data.followups ?? 0}.</p>
    {data.mode === "off" && <p>Routing is off. Complete the sending-approval prerequisites, configure the router and destinations, then enable review mode in Configuration.</p>}
    {data.mode === "unavailable" && <p role="alert">{data.configReason ?? "The recorded mailbox configuration is unavailable."} You can close its waiting entries as handled manually without connecting to mail. Recorded handoffs can have follow-ups marked checked here.</p>}
    {error && <p role="alert" style={{ color: "var(--destructive)" }}>{error}</p>}
    {data.rows.length === 0 ? <p>No routing entries yet. Sender-rule review remains in the existing triage review queue.</p> : <ul style={{ listStyle: "none", padding: 0 }}>
      {data.rows.map(row => {
        const choices = row.frozen ? data.destinations.filter(d => d.key === row.destination?.key) : data.destinations;
        const preferred = destinations[row.id] ?? row.destination?.key ?? row.candidates[0] ?? choices[0]?.key ?? "";
        const selected = choices.some(d => d.key === preferred) ? preferred : "";
        const pending = row.status === "waiting" || row.status === "claimed";
        const canRoute = row.canRoute !== false && data.mode !== "off" && data.mode !== "unavailable";
        const response = feedback[row.id];
        const followupError = row.followupsCheckedAt ? null : row.followupError || response?.followupError;
        return <li key={row.id} style={{ borderTop: "1px solid var(--border)", padding: "16px 0", overflowWrap: "anywhere" }}>
          <p style={{ margin: "0 0 6px" }}>{row.subject || "(no subject)"}</p>
          <p style={{ margin: "0 0 6px", color: "var(--muted-foreground)" }}>{row.sender || "(unknown sender)"} | {row.receivedAt} | {row.status}</p>
          {response?.outcome ? <p role="status">Routing response: {response.outcome}. {response.note}</p>
            : <p style={{ margin: "0 0 10px" }}>{!pending && "Earlier routing note: "}{row.note}</p>}
          {row.issueIdentifier && <p>Issue: {row.issueIdentifier}.</p>}
          {row.status === "routed" && <>
            <p>Wake: {row.wake}. Source audit: {row.audit}.</p>
            {row.wake === "pending" && <p>Wake has not been requested yet.</p>}
            {row.wake === "requested_unknown" && <p>{row.followupsCheckedAt ? "Wake outcome remains unknown." : "Wake outcome is unknown. Retry follow-ups uses the same wake key; it cannot create another issue."}</p>}
            {row.wake === "requested_or_duplicate_verify" && <p>Wake was requested or was a duplicate. Verify the destination issue's run history.</p>}
            {row.wake === "refused" && <p>Wake was not newly queued. It may have been combined with existing work or deferred. Verify the destination issue's run history.</p>}
            {row.audit === "unknown" && <p>Source audit outcome is unknown. Verify manually; retry never repeats an unknown audit.</p>}
            {followupError && <p role="alert" style={{ color: "var(--destructive)" }}>{followupError}</p>}
            {row.followupsCheckedAt ? <p>Follow-ups marked checked at {row.followupsCheckedAt} by {row.followupsCheckedByUserId}. This removes follow-up alerts, does not prove delivery or cancel work. Unknown facts above remain unknown. No new follow-ups will be requested; work already requested may still complete.</p> : <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {row.canRetryFollowups && <button style={control} disabled={busy || !canRoute} onClick={() => void decide(row.id, "retry_followups")}>Retry follow-ups</button>}
              <button style={control} disabled={busy} onClick={() => setChecking(row.id)}>Mark follow-ups checked</button>
            </div>}
            {!row.followupsCheckedAt && checking === row.id && <div role="alert">
              <p>This removes follow-up alerts, does not prove delivery or cancel work. It cannot undo a handoff or resolve an unknown wake or audit. No new follow-ups will be requested; work already requested may still complete.</p>
              <button style={{ ...control, background: "var(--primary)", color: "var(--primary-foreground)", fontWeight: 600 }} disabled={busy} onClick={() => void decide(row.id, "check_followups")}>Confirm follow-ups checked</button>{" "}
              <button style={control} disabled={busy} onClick={() => setChecking(null)}>Cancel</button>
            </div>}
          </>}
          {row.status === "handled" && <p>Closed as handled manually{row.handledAt ? ` at ${row.handledAt}` : ""}{row.handledByUserId ? ` by ${row.handledByUserId}` : ""}. Routing will never create work again for this recorded identity. An earlier handoff may still exist or complete. No follow-ups will be requested.</p>}
          {pending && !canRoute && row.routeUnavailableReason && row.routeUnavailableReason !== row.note && <p>{row.routeUnavailableReason}</p>}
          {row.frozen && pending && <p>Destination is fixed because an earlier request may have created work. Route retries only reconcile that handoff. Restore the original destination configuration if it is no longer listed.</p>}
          {pending && canRoute && !row.frozen && preferred && !selected && <p>The previous destination is no longer available. Choose a destination.</p>}
          {pending && <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <select aria-label={`Destination for ${row.subject || "message"}`} style={control} disabled={busy || !canRoute} value={selected}
              onChange={e => setDestinations(previous => ({ ...previous, [row.id]: e.target.value }))}>
              {!selected && <option value="">Choose a destination</option>}
              {choices.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
            </select>
            <button style={control} disabled={busy || !canRoute || !choices.some(d => d.key === selected)} onClick={() => void decide(row.id, "route", selected)}>{row.frozen ? "Reconcile handoff" : "Route to destination"}</button>
            <button style={control} disabled={busy || !canRoute || row.frozen || row.status !== "waiting"} onClick={() => void decide(row.id, "dismiss")}>Dismiss</button>
            <button style={control} disabled={busy} onClick={() => setClosing(row.id)}>Close as handled manually</button>
          </div>}
          {pending && closing === row.id && <div role="alert">
            <p>This closes review only and permanently prevents another route for this identity. It creates, cancels and deletes nothing. An unknown handoff may already exist or still complete. Check existing work before confirming.</p>
            <button style={{ ...control, background: "var(--primary)", color: "var(--primary-foreground)", fontWeight: 600 }} disabled={busy} onClick={() => void decide(row.id, "close_manually")}>Confirm manual close</button>{" "}
            <button style={control} disabled={busy} onClick={() => setClosing(null)}>Cancel</button>
          </div>}
        </li>;
      })}
    </ul>}
    <div style={{ display: "flex", gap: 8 }}>
      <button style={control} disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}>Previous</button>
      <button style={control} disabled={busy || !data.hasMore || offset >= 10_000} onClick={() => setOffset(offset + 25)}>Next</button>
      <button style={control} disabled={busy} onClick={() => void query.refresh()}>Refresh</button>
    </div>
  </>;
}
