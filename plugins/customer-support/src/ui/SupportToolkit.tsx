import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { supportErrorMessage } from "./error-message.js";

interface Toolkit {
  configured?: boolean;
  diagnostics: { id: string; title: string; description: string }[];
  repairRecipes: { id: string; title: string; disruption: string }[];
  references: { id: string; title: string; topic: string; url: string }[];
  devices: { target_address: string; last_seen_at: string; snapshot: { os?: string; model?: string; build?: string } }[];
  knowledge: { id: string; title: string; topic: string; kind: string; body: string; created_at: string }[];
  assets: { id: string; identity_strength: string; identity_conflict: boolean; last_seen_at: string; aliases: { address: string; source: string }[]; snapshot: { os?: string; model?: string } }[];
  fleet: { id: string; status: string; created_at: string; assessed: number; pending: number; unavailable: number; skipped: number; attention: number }[];
  printers: { networkId: string; address: string; path: string; port: number; tls: boolean; status: string; state: string; reasons: string[]; observedAt: string; acceptingJobs: boolean | null; queuedJobs: number | null }[];
}
export function SupportToolkit({ companyId }: { companyId: string }) {
  const toolkit = usePluginData<Toolkit>("support.toolkit", { companyId });
  return <details className="rounded-md border border-border bg-card p-4 text-card-foreground">
    <summary className="cursor-pointer font-semibold">IT tools, devices and reference library</summary>
    <p className="mt-3 text-sm text-muted-foreground">In Clippy, ask to investigate a computer, troubleshoot a printer, explain Group Policy, or look up an IT procedure. It uses the company's saved access and asks for repair confirmation in the conversation.</p>
    <button type="button" onClick={() => toolkit.refresh()} className="my-3 rounded-md border border-border px-3 py-1.5 text-sm">Refresh device and knowledge records</button>
    {toolkit.loading && <p className="text-sm text-muted-foreground">Loading support toolkit…</p>}
    {toolkit.error && <p role="alert" className="text-sm text-destructive">Could not load support toolkit: {supportErrorMessage(toolkit.error)}</p>}
    {!toolkit.loading && !toolkit.error && toolkit.data && <div className="space-y-4 text-sm">
      {toolkit.data.configured === false && <p role="status" className="rounded-md border border-border bg-muted p-3">Support is not set up for this company yet. Choose a company with saved support settings, or configure this company's Windows access or communication route. The tools and references below are available to browse; no company device records have been loaded.</p>}
      <section><h3 className="font-semibold">Office health checks</h3><p className="text-muted-foreground">Ask Clippy to check the office for issues. It investigates permitted Windows devices in steps, preserving progress. Skipped devices and missing checks have not been assessed.</p>
        {!toolkit.data.fleet?.length && <p className="mt-2">No fleet checks yet.</p>}
        {toolkit.data.fleet?.map(item => <p key={item.id} className="mt-2"><strong>{item.status}</strong> · {item.assessed} snapshots · {item.attention} need investigation · {item.pending} pending · {item.unavailable} failed/interrupted · {item.skipped} skipped · {new Date(item.created_at).toLocaleString()}</p>)}
      </section>
      <section><h3 className="font-semibold">Authenticated device inventory</h3><p className="text-muted-foreground">Stable IDs come from authenticated Windows inventory. Reported aliases are historical observations, not access grants or proof of current ownership. Duplicate hardware identities or renamed computers require review.</p>
        {!toolkit.data.assets?.length && <p className="mt-2">Refresh inventory to establish device identities.</p>}
        {toolkit.data.assets?.map(item => <details key={item.id} className="mt-2 rounded-md border border-border p-2"><summary className="cursor-pointer">{item.aliases.find(alias => alias.source === "authenticated_target")?.address ?? item.id} · {item.snapshot.os ?? "OS unknown"} · {item.identity_conflict ? "Identity needs review" : item.identity_strength === "windows_hardware" ? "Windows and hardware identity" : "Target only"}</summary>
          <p className="mt-2">Asset ID: {item.id} · observed {new Date(item.last_seen_at).toLocaleString()}</p>
          <ul className="mt-2">{item.aliases.map(alias => <li key={alias.address}>{alias.address} · {alias.source.replaceAll("_", " ")}</li>)}</ul>
        </details>)}
      </section>
      <section><h3 className="font-semibold">Diagnostics</h3><p className="text-muted-foreground">Available checks depend on the Windows version and installed modules. Inventory identifies them.</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">{toolkit.data.diagnostics.map(item => <div key={item.id} className="rounded-md border border-border p-2"><strong>{item.title}</strong><p className="text-muted-foreground">{item.description}</p></div>)}</div>
      </section>
      <section><h3 className="font-semibold">Network printer observations</h3><p className="text-muted-foreground">Ask Clippy to check a printer's IP address. Direct IPP status is distinct from Windows queue status. Unavailable or missing data does not establish a healthy device; confirm physical output with a person.</p>
        {!toolkit.data.printers?.length && <p className="mt-2">No direct printer checks yet.</p>}
        {toolkit.data.printers?.map(item => <div key={`${item.networkId}:${item.address}:${item.path}:${item.port}:${item.tls}`} className="mt-2 rounded-md border border-border p-2"><strong>{item.address}</strong> · {item.status} · {item.state}<p>Reasons: {item.reasons.join(", ") || "Not reported"} · accepting jobs: {item.acceptingJobs === null ? "Unknown" : item.acceptingJobs ? "Yes" : "No"} · queued jobs: {item.queuedJobs ?? "Unknown"}</p><p className="text-muted-foreground">Observed {new Date(item.observedAt).toLocaleString()}</p></div>)}
      </section>
      <section><h3 className="font-semibold">Repair procedures</h3><p className="text-muted-foreground">Clippy prepares a procedure for review, then runs and verifies it after authorization. Custom PowerShell repairs use the same workflow.</p>
        <ul className="mt-2 space-y-1">{toolkit.data.repairRecipes.map(item => <li key={item.id}><strong>{item.title}</strong> — {item.disruption}</li>)}</ul>
      </section>
      <section><h3 className="font-semibold">Previously investigated computers</h3><p className="text-muted-foreground">Saved observations, not a live scan. Only devices in current company access groups are shown.</p>
        {!toolkit.data.devices.length && <p className="mt-2">No inventory snapshots yet. Ask Clippy to inspect a computer's inventory.</p>}
        {toolkit.data.devices.map(item => <p key={item.target_address} className="mt-2"><strong>{item.target_address}</strong> · {item.snapshot.os ?? "OS unknown"} · {item.snapshot.model ?? "Model unknown"} · observed {new Date(item.last_seen_at).toLocaleString()}</p>)}
      </section>
      <section><h3 className="font-semibold">Company support knowledge</h3><p className="text-muted-foreground">Ask Clippy to save an environment note or procedure. Publishing requires confirmation. Verified fixes link to a repair that passed its recorded verification.</p>
        {!toolkit.data.knowledge.length && <p className="mt-2">No knowledge entries yet.</p>}
        {toolkit.data.knowledge.map(item => <details key={item.id} className="mt-2 rounded-md border border-border p-2"><summary className="cursor-pointer">{item.title} · {item.kind} · {item.topic}</summary><p className="mt-2 whitespace-pre-wrap break-words">{item.body}</p></details>)}
      </section>
      <section><h3 className="font-semibold">Official reference directory</h3><p className="text-muted-foreground">Clippy can retrieve current articles and cite them. Check the product/version before applying a procedure.</p>
        <ul className="mt-2 grid gap-1 md:grid-cols-2">{toolkit.data.references.map(item => <li key={item.id}><a href={item.url} target="_blank" rel="noreferrer" className="text-primary underline">{item.title}</a></li>)}</ul>
      </section>
    </div>}
  </details>;
}
