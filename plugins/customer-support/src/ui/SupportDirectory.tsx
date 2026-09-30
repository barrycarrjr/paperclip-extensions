import { useEffect, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { directoryFields, directoryKinds, specialistStatus, supportAreas, type DirectoryKind, type DirectoryRecord } from "../directory-schema.js";
import { checkSetupPermission } from "./setup-client.js";

const labels: Record<DirectoryKind,string> = { vendor: "Vendors",owner: "Responsible people and teams",equipment: "Equipment and warranties",route: "Owner routing",brand: "Brands and signatures",connection: "Specialist connections" };
const inputClass = "mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground";
const button = "rounded-md border border-border px-3 py-1.5 disabled:opacity-50";
type Directory = { records: DirectoryRecord[]; truncated: boolean };
type Plugin = { id: string; pluginKey: string; status: string };
function History({ companyId,recordId }: { companyId: string;recordId: string }) {
  const history = usePluginData<{ revisions: { version: number;name: string;details: Record<string,string>;actorUserId: string;recordedAt: string }[] }>("support.directoryHistory",{ companyId,recordId });
  return <div className="mt-2 space-y-2">
    {history.loading && <p role="status">Loading revisions…</p>}
    {history.error && <p role="alert" className="text-destructive">Could not load revisions: {String(history.error)}</p>}
    {history.data?.revisions.map(revision => <details key={revision.version}><summary>Version {revision.version} · {new Date(revision.recordedAt).toLocaleString()}</summary><p>Reviewed by {revision.actorUserId}</p><p>{revision.name}</p>{Object.entries(revision.details).map(([key,value]) => <p key={key} className="whitespace-pre-wrap break-words">{Object.values(directoryFields).flat().find(field => field.key === key)?.label ?? key}: {value}</p>)}</details>)}
  </div>;
}
function OwnerLookup({ companyId,records }: { companyId: string;records: DirectoryRecord[] }) {
  const [area,setArea] = useState("general"); const [equipmentId,setEquipmentId] = useState(""); const [brandId,setBrandId] = useState("");
  const result = usePluginData<{ status: string;routes: DirectoryRecord[];related: DirectoryRecord[] }>("support.ownerRoute",{ companyId,area,...(equipmentId ? { equipmentId } : {}),...(brandId ? { brandId } : {}) });
  return <section className="space-y-2 rounded-md border border-border p-3">
    <h3 className="font-semibold">Who should handle this?</h3>
    <div className="grid gap-2 md:grid-cols-3"><label>Support area<select className={inputClass} value={area} onChange={event => setArea(event.target.value)}>{supportAreas.map(item => <option key={item} value={item}>{item.replaceAll("_"," ")}</option>)}</select></label>
      {(["equipment","brand"] as const).map(kind => <label key={kind}>{kind === "equipment" ? "Equipment (optional)" : "Brand (optional)"}<select className={inputClass} value={kind === "equipment" ? equipmentId : brandId} onChange={event => kind === "equipment" ? setEquipmentId(event.target.value) : setBrandId(event.target.value)}><option value="">Unspecified — general routes only</option>{records.filter(record => record.kind === kind).map(record => <option key={record.id} value={record.id}>{record.name}</option>)}</select></label>)}
    </div>
    {result.loading && <p role="status">Looking up saved routes…</p>}
    {result.error && <p role="alert" className="text-destructive">Could not look up the owner: {String(result.error)}</p>}
    {!result.loading && !result.error && result.data && <>
      <p>{result.data.status === "matched" ? "One matching route. Review the owner and handoff instructions below." : result.data.status === "needs_clarification" ? "Several routes may apply. Clarify the equipment, brand or owner before handing off." : "No matching route saved. Ask who owns this support area."}</p>
      {result.data.routes.map(route => <div key={route.id}><strong>{route.name}</strong><p className="whitespace-pre-wrap">{route.details.notes}</p></div>)}
      {result.data.related.map(record => <div key={record.id}><strong>{record.name}</strong>{directoryFields[record.kind].filter(field => record.details[field.key]).map(field => <p key={field.key} className="break-words whitespace-pre-wrap">{field.label}: {field.link ? records.find(item => item.id === record.details[field.key])?.name ?? record.details[field.key] : record.details[field.key]}</p>)}</div>)}
    </>}
    <p className="text-xs text-muted-foreground">This lookup does not assign work or send a message. Software bugs still use the vendor reporting route. Equipment and facilities go to the responsible owner.</p>
  </section>;
}
export function SupportDirectory({ companyId }: { companyId: string }) {
  const directory = usePluginData<Directory>("support.directory",{ companyId });
  const agents = usePluginData<{ id: string;name: string }[]>("support.agents",{ companyId });
  const [kind,setKind] = useState<DirectoryKind>("vendor"); const [selected,setSelected] = useState<DirectoryRecord | null>(null);
  const [name,setName] = useState(""); const [details,setDetails] = useState<Record<string,string>>({});
  const [preview,setPreview] = useState<Record<string,unknown> | null>(null); const [error,setError] = useState<string | null>(null);
  const [busy,setBusy] = useState(false); const [saved,setSaved] = useState(false); const [historyId,setHistoryId] = useState<string | null>(null);
  const [plugins,setPlugins] = useState<Plugin[] | null>(null); const [pluginError,setPluginError] = useState<string | null>(null);
  const [allowed,setAllowed] = useState<boolean | null>(null); const [permissionError,setPermissionError] = useState<string | null>(null);
  const [refreshVersion,setRefreshVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setPlugins(null); setAllowed(null); setPermissionError(null); setPluginError(null);
    checkSetupPermission(fetch,companyId,"repair").then(result => { if (!cancelled) { setAllowed(result.allowed);setPermissionError(result.error ?? null); } });
    fetch("/api/plugins",{ credentials: "same-origin" }).then(async response => { if (!response.ok) throw new Error(); const body = await response.json(); if (!Array.isArray(body) || body.some(item => !item || typeof item.id !== "string" || typeof item.pluginKey !== "string" || typeof item.status !== "string")) throw new Error(); if (!cancelled) setPlugins(body); }).catch(() => { if (!cancelled) setPluginError("Could not check installed plugins. Open Plugin settings or refresh."); });
    return () => { cancelled = true; };
  },[companyId,refreshVersion]);
  const records = directory.data?.records ?? [];
  function edit(record: DirectoryRecord | null,nextKind = kind) { setSelected(record);setKind(record?.kind ?? nextKind);setName(record?.name ?? "");setDetails(record?.details ?? {});setPreview(null);setError(null);setSaved(false); }
  function change(key: string,value: string) { setDetails(old => ({ ...old,[key]: value }));setPreview(null);setSaved(false); }
  async function save() {
    if (!preview || busy) return; setBusy(true);setError(null);setSaved(false);
    try {
      const response = await fetch("/api/plugins/customer-support/api/directory",{ method: "POST",credentials: "same-origin",headers: { "Content-Type": "application/json" },body: JSON.stringify({ ...preview,companyId,confirmed: true }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      edit(null);setSaved(true);directory.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason));directory.refresh(); }
    finally { setBusy(false); }
  }
  return <details className="rounded-md border border-border bg-card p-4 text-sm text-card-foreground">
    <summary className="cursor-pointer font-semibold">Company support directory: vendors, equipment and owners</summary>
    <p className="mt-3 text-muted-foreground">Save company contacts, equipment warranties, routing rules and brand details here. Clippy can look them up. Keep passwords in Secrets. Publish staff how-tos using Clippy’s company knowledge tools.</p>
    <button type="button" className={`${button} my-3`} onClick={() => { directory.refresh();agents.refresh();setRefreshVersion(value => value+1); }}>Refresh records and connection checks</button>
    {directory.loading && <p role="status">Loading company records…</p>}
    {directory.error && <p role="alert" className="text-destructive">Could not load company records: {String(directory.error)}</p>}
    {permissionError && <p role="alert" className="text-destructive">{permissionError}</p>}
    {pluginError && <p role="alert" className="text-destructive">{pluginError}</p>}
    {saved && <p role="status">Company record saved. Clippy can now find it.</p>}
    {!directory.loading && !directory.error && directory.data && <div className="space-y-4">
      {directory.data.truncated && <p role="alert">Showing the first 200 records. Ask Clippy to search by name or type to find other records.</p>}
      <div className="flex flex-wrap gap-2">{directoryKinds.map(item => <button disabled={busy} type="button" className={button} key={item} aria-pressed={kind === item} onClick={() => edit(null,item)}>{labels[item]}</button>)}</div>
      {!records.some(record => record.kind === kind) && <p>No {labels[kind].toLowerCase()} saved yet.</p>}
      {records.filter(record => record.kind === kind).map(record => <section key={record.id} className="space-y-2 rounded-md border border-border p-3">
        <h3 className="font-semibold">{record.name}</h3><p className="text-xs text-muted-foreground">Version {record.version} · updated {new Date(record.updated_at).toLocaleString()}</p>
        {directoryFields[kind].filter(field => record.details[field.key]).map(field => <p key={field.key} className="whitespace-pre-wrap break-words"><strong>{field.label}:</strong> {field.link ? records.find(item => item.id === record.details[field.key])?.name ?? record.details[field.key] : record.details[field.key]}</p>)}
        {record.kind === "connection" && <div><p>{({ not_checked: "Installation not checked.",not_installed: "Plugin not installed.",inactive: "Plugin installed but inactive.",running_untested: "Plugin running; saved account access and connectivity still need testing." })[specialistStatus(record.details.pluginKey!,plugins)]}</p><a className="text-primary underline" href={plugins?.find(item => item.pluginKey === record.details.pluginKey) ? `/instance/settings/plugins/${plugins.find(item => item.pluginKey === record.details.pluginKey)!.id}` : "/instance/settings/plugins"}>Open plugin settings</a><p className="text-xs text-muted-foreground">This entry does not configure the other plugin or implement a new Support Desk adapter.</p></div>}
        {allowed && <button type="button" disabled={busy} className={button} onClick={() => edit(record)}>Edit record</button>}
        <button type="button" className={button} onClick={() => setHistoryId(historyId === record.id ? null : record.id)}>Review saved revisions</button>
        {historyId === record.id && <History companyId={companyId} recordId={record.id} />}
      </section>)}
      {allowed === true ? <form className="space-y-3 rounded-md border border-border p-3" onSubmit={event => { event.preventDefault();setError(null);setPreview({ ...(selected ? { id: selected.id,expectedVersion: selected.version } : {}),kind,name,details }); }}>
        <h3 className="font-semibold">{selected ? "Edit" : "Add"} {kind} record</h3>
        <fieldset disabled={busy} className="grid gap-3 md:grid-cols-2">
          <label>Name<input required maxLength={150} className={inputClass} value={name} onChange={event => { setName(event.target.value);setPreview(null);setSaved(false); }} /></label>
          {directoryFields[kind].map(field => <label key={field.key}>{field.label}
            {field.link || field.options || field.key === "agentId" ? <select required={field.required} className={inputClass} value={details[field.key] ?? ""} onChange={event => change(field.key,event.target.value)}>
              <option value="">{field.required ? "Choose one" : "None"}</option>
              {field.options?.map(option => <option key={option} value={option}>{option.replaceAll("_"," ")}</option>)}
              {field.link && records.filter(record => record.kind === field.link).map(record => <option key={record.id} value={record.id}>{record.name}</option>)}
              {field.key === "agentId" && agents.data?.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              {details[field.key] && !field.options && !(field.link ? records : agents.data ?? []).some(record => record.id === details[field.key]) && <option value={details[field.key]}>Saved reference — refresh or choose another</option>}
            </select> : field.multiline ? <textarea required={field.required} maxLength={4000} className={inputClass} value={details[field.key] ?? ""} onChange={event => change(field.key,event.target.value)} /> : <input required={field.required} maxLength={255} className={inputClass} value={details[field.key] ?? ""} onChange={event => change(field.key,event.target.value)} />}
          </label>)}
        </fieldset>
        {agents.error && kind === "owner" && <p role="alert" className="text-destructive">Could not load this company’s agent choices: {String(agents.error)}</p>}
        <div className="flex gap-2"><button type="submit" disabled={busy} className={button}>Review record</button><button type="button" disabled={busy} className={button} onClick={() => edit(null)}>Clear form</button></div>
        {preview && <div className="space-y-2 rounded-md border border-border p-3"><h4 className="font-semibold">Confirm this company record</h4><p>{name}</p>{directoryFields[kind].filter(field => details[field.key]).map(field => <p key={field.key} className="whitespace-pre-wrap break-words">{field.label}: {field.link ? records.find(record => record.id === details[field.key])?.name ?? details[field.key] : details[field.key]}</p>)}<p className="text-muted-foreground">This saves reference information and revision history. It does not send a message or change equipment.</p><button type="button" disabled={busy} className={button} onClick={save}>{busy ? "Saving…" : "Confirm and save record"}</button></div>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
      </form> : <p className="text-muted-foreground">{allowed === null ? "Checking your permission to manage records…" : "An operator with Approve and run repairs permission can add or edit support records."}</p>}
      <OwnerLookup companyId={companyId} records={records} />
    </div>}
  </details>;
}
