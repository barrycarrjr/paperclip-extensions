import { useEffect, useState } from "react";
import { discoveryRange } from "../discovery-scope.js";

type Network = { id: string; companyId: string; cidr: string };
type Config = { discoveryNetworks?: Network[]; [key: string]: unknown };
async function request<T>(init?: RequestInit): Promise<T> {
  const response = await fetch("/api/plugins/customer-support/config", { credentials: "same-origin", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body as T;
}
export function DiscoverySetup({ companyId }: { companyId: string }) {
  const [networks, setNetworks] = useState<Network[]>([]);
  const [cidr, setCidr] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null); const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    request<{ configJson?: Config } | null>().then(saved => {
      if (!cancelled) setNetworks((saved?.configJson?.discoveryNetworks ?? []).filter(network => network.companyId === companyId));
    }).catch(reason => { if (!cancelled) setError(String(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId]);
  async function save(remove?: string) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const range = remove ? null : discoveryRange(cidr.trim());
      const saved = await request<{ configJson?: Config } | null>();
      const config = saved?.configJson ?? {}; const all = config.discoveryNetworks ?? [];
      const next = remove ? all.filter(network => !(network.companyId === companyId && network.id === remove))
        : all.some(network => network.companyId === companyId && network.cidr === range!.cidr) ? all
        : [...all, { id: `network-${range!.cidr.replace(/[^0-9]/g, "-")}`, companyId, cidr: range!.cidr }];
      await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ configJson: { ...config, connections: config.connections ?? [], discoveryNetworks: next } }) });
      setNetworks(next.filter(network => network.companyId === companyId)); setCidr("");
      setNotice(remove ? "Discovery network removed." : "Network saved. Ask Clippy: Scan the office network and list the devices you find.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-md border border-border p-4 text-sm">
    <div><h2 className="font-semibold">Discover office devices</h2>
      <p className="text-muted-foreground">Save an office IPv4 network once, then ask Clippy to scan it. Discovery checks ping and common service ports from the Paperclip host. It uses no password and grants no remote administration access. Each scan covers up to 254 addresses (/24) in 30 seconds.</p></div>
    {loading ? <p>Loading discovery networks…</p> : <>
      <form onSubmit={event => { event.preventDefault(); void save(); }} className="flex flex-wrap items-end gap-2">
        <label className="min-w-64 flex-1">Office IPv4 network<input required placeholder="192.0.2.0/24" value={cidr} onChange={event => setCidr(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">Save discovery network</button>
      </form>
      {networks.map(network => <div key={network.id} className="flex items-center justify-between gap-2 rounded-md border border-border p-2">
        <span>{network.cidr}</span><button type="button" disabled={busy} onClick={() => { void save(network.id); }} className="rounded-md border border-border px-2 py-1 disabled:opacity-50">Remove</button>
      </div>)}
      {!networks.length && <p className="text-muted-foreground">No discovery network saved for this company.</p>}
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
