import { useEffect, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { Config, TicketPolicy } from "../routing.js";
import { diagnosticChecks } from "../diagnostic-catalog.js";

async function configuration(init?: RequestInit) {
  const response = await fetch("/api/plugins/customer-support/config",{ credentials: "same-origin",...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body as { configJson?: Config } | null;
}
export function TicketSetup({ companyId }: { companyId: string }) {
  const agents = usePluginData<{ id: string; name: string; status: string }[]>("support.agents",{ companyId });
  const [policy,setPolicy] = useState<TicketPolicy>({ companyId,agentId: "",enabled: false,diagnostics: ["inventory","health","printers"],allowThreadUpdates: false });
  const [loading,setLoading] = useState(true); const [busy,setBusy] = useState(false);
  const [error,setError] = useState<string | null>(null); const [notice,setNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    configuration().then(saved => {
      const matches = (saved?.configJson?.ticketPolicies ?? []).filter(item => item.companyId === companyId);
      if (matches.length > 1) throw new Error("Multiple ticket policies exist for this company. Correct them in Support Desk settings.");
      if (!cancelled && matches[0]) setPolicy(matches[0]);
    }).catch(reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  },[companyId]);
  async function save() {
    setBusy(true); setError(null); setNotice(null);
    try {
      const saved = await configuration(); const cfg = saved?.configJson ?? {};
      const routes = (cfg.connections ?? []).filter(connection => connection.source === "slack" && connection.allowedCompanies.includes(companyId) && connection.routes.some(route => route.companyId === companyId));
      if (policy.enabled && !routes.length) throw new Error("Configure a Slack intake connection and exact company route in Support Desk settings first.");
      if (policy.enabled && !agents.data?.some(agent => agent.id === policy.agentId && !["paused","terminated","pending_approval"].includes(agent.status))) throw new Error("Choose an available support agent in this company.");
      if (policy.enabled && policy.allowThreadUpdates && routes.some(connection => !connection.botTokenRef)) throw new Error("Each company Slack intake connection needs its bot Secret for automatic thread updates. The bot needs chat:write.");
      await configuration({ method: "POST",headers: { "Content-Type": "application/json" },body: JSON.stringify({ configJson: { ...cfg,connections: cfg.connections ?? [],
        ticketPolicies: [...(cfg.ticketPolicies ?? []).filter(item => item.companyId !== companyId),policy] } }) });
      setNotice(policy.enabled ? "Investigation policy saved. New Slack requests will create assigned support work. Repairs still need operator approval." : "Automatic ticket investigation disabled. Existing actions and unknown receipts remain available for review.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save ticket policy"); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-md border border-border p-4 text-sm">
    <div><h2 className="font-semibold">Investigate incoming Slack requests</h2><p className="text-muted-foreground">Choose a company agent and the checks it may run with saved Windows access. It can ask questions and post findings in the original thread. Computer changes require an authorized operator's exact approval.</p></div>
    {loading ? <p>Loading ticket policy…</p> : <>
      <label className="flex items-center gap-2"><input type="checkbox" checked={policy.enabled} onChange={event => setPolicy({ ...policy,enabled: event.target.checked })} />Investigate new tickets automatically</label>
      <label className="block">Support agent<select value={policy.agentId} onChange={event => setPolicy({ ...policy,agentId: event.target.value })} className="mt-1 block w-full rounded-md border border-border bg-background p-2"><option value="">Choose a company agent</option>{(agents.data ?? []).map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({agent.status})</option>)}</select></label>
      {agents.error && <p role="alert" className="text-destructive">Could not load support agents: {String(agents.error)}</p>}
      <fieldset className="space-y-2"><legend className="font-medium">Allowed diagnostic checks</legend><div className="grid gap-2 sm:grid-cols-2">{diagnosticChecks.filter(check => check.script && check.id !== "repair_rehearsal").map(check => <label key={check.id} className="flex items-center gap-2"><input type="checkbox" checked={policy.diagnostics.includes(check.id)} onChange={event => setPolicy({ ...policy,diagnostics: event.target.checked ? [...policy.diagnostics,check.id] : policy.diagnostics.filter(id => id !== check.id) })} />{check.title}</label>)}</div></fieldset>
      <label className="flex items-center gap-2"><input type="checkbox" checked={policy.allowThreadUpdates} onChange={event => setPolicy({ ...policy,allowThreadUpdates: event.target.checked })} />Allow progress, answers and findings in the original Slack thread</label>
      <p className="text-muted-foreground">Thread updates use the intake connection's bot Secret and require chat:write. Incoming Slack replies cannot approve a repair. Changing the policy stops existing agent work until an operator reviews it.</p>
      <button type="button" disabled={busy || agents.loading} onClick={() => void save()} className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">{busy ? "Saving…" : "Save investigation policy"}</button>
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status" className="text-muted-foreground">{notice}</p>}
  </section>;
}
