import { useEffect, useMemo, useState } from "react";
import { useHostContext, usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { RemoteSetup } from "./RemoteSetup.js";
import { RestrictedSource } from "./RestrictedSource.js";
import { TicketSetup } from "./TicketSetup.js";
import { TicketProgress } from "./TicketProgress.js";
import { TicketOutcome } from "./TicketOutcome.js";
import { DiscoverySetup } from "./DiscoverySetup.js";
import { SupportToolkit } from "./SupportToolkit.js";
import { SupportMessages } from "./SupportMessages.js";
import type { OutboundRow } from "../support-outbound.js";
import type { SupportSetup } from "../support-setup.js";
import { SupportReadiness } from "./SupportReadiness.js";
import { SupportDirectory } from "./SupportDirectory.js";

interface CaseRow {
  id: string;
  company_id: string;
  source: string;
  title: string;
  status: string;
  last_message_at: string;
  external_url: string | null;
  service_domain: string;
  work_kind: string;
  review_version?: number;
  asset_ref?: string | null;
  target_address?: string | null;
  access_method?: string;
  order_ref?: string | null;
  vendor_ref?: string | null;
  resolution_summary?: string | null;
  symptom_outcome?: string | null;
  symptom_evidence?: string | null;
  symptom_basis?: string | null;
  symptom_recorded_at?: string | null;
}
interface Detail {
  ticketJob?: { latest_message_id: string; agent_id: string; issue_id: string | null; status: string; failure_code: string | null; target_address: string | null } | null;
  outbound: OutboundRow[];
  diagnostics: { check_kind: string; result: unknown; created_at: string }[];
  supportCase: CaseRow;
  messages: { id: string; author_kind: string; author_external_id: string | null; body: string; occurred_at: string; attachments: { id: string; name: string; mimeType?: string; permalink?: string }[] }[];
  linkedIssue: { id: string; identifier: string | null; title: string; status: string; kind: string;
    assigneeAgentId: string | null } | null;
  escalation: { id: string; route_id: string; product_name: string; destination_kind: "email" | "jira_form";
    destination: string; title: string; evidence: string; status: "draft" | "submitted"; external_ticket_ref: string | null } | null;
  actions: { id: string; target_address: string; script_text: string; script_sha256: string;
    ticket_proof?: { disruption: string } | null;
    verification_text: string; verification_sha256: string; expected_effect: string; recovery_notes: string;
    status: string; proposed_by_user_id: string; approved_by_user_id: string | null;
    repair_run_id: string | null; verification_run_id: string | null;
    repair_exit_code: number | null; verification_exit_code: number | null; started_at: string | null }[];
}

function SupportActions({ companyId, detail, onChanged }: { companyId: string; detail: Detail; onChanged: () => void }) {
  const [script, setScript] = useState("");
  const [verificationScript, setVerificationScript] = useState("");
  const [expectedEffect, setExpectedEffect] = useState("");
  const [recoveryNotes, setRecoveryNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const supportCase = detail.supportCase;

  async function send(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(supportCase.id)}${path}`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, ...body }),
      });
      const result = await response.json() as { error?: string; status?: string; delivery?: { status: string } };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setNotice((result.status === "verified" ? "Repair and verification completed. Confirm the reported symptom before resolving the case."
        : result.status === "unknown" ? "Outcome is unknown. Inspect the device before considering another action."
          : `Action ${result.status ?? "saved"}.`) + (result.delivery ? ` Original thread update: ${result.delivery.status}.` : ""));
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function checkIdentity() {
    setBusy(true);
    setError(null);
    setIdentity(null);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(supportCase.id)}/remote/identity`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, expectedReviewVersion: supportCase.review_version }),
      });
      const result = await response.json() as { error?: string; output?: string; remoteIdentity?: string; status?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setIdentity(result.remoteIdentity ?? result.output ?? result.status ?? "Connected");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="space-y-3 rounded-md border border-border p-3 text-sm">
    <h3 className="font-semibold">Remote repair actions</h3>
    {detail.supportCase.symptom_outcome && <div className="space-y-1 rounded-md border border-border p-3" role="status">
      <p><strong>Reported problem: {detail.supportCase.symptom_outcome.replaceAll("_", " ")}</strong></p>
      <p>{detail.supportCase.resolution_summary}</p>
      <p className="text-muted-foreground">Evidence ({detail.supportCase.symptom_basis?.replaceAll("_", " ")}): {detail.supportCase.symptom_evidence}</p>
      {detail.supportCase.symptom_recorded_at && <p className="text-xs text-muted-foreground">Recorded {new Date(detail.supportCase.symptom_recorded_at).toLocaleString()}</p>}
    </div>}
    <p className="text-muted-foreground">Review the exact PowerShell script, its verification, and the target before approving. The script runs on the selected device with its configured support account. Keep passwords out of the script.</p>
    <div><button type="button" disabled={busy} onClick={checkIdentity} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">Test remote identity (read only)</button>
      {identity && <p role="status" className="mt-1 text-muted-foreground">{identity}</p>}
    </div>
    {detail.actions.map((action) => <div key={action.id} className="space-y-2 rounded-md border border-border p-3">
      <p><strong>{action.status}</strong> · {action.target_address} · SHA-256 {action.script_sha256}</p>
      <p>Expected effect: {action.expected_effect}</p>
      {action.ticket_proof && <p>Disruption: {action.ticket_proof.disruption}</p>}
      <p>Recovery: {action.recovery_notes}</p>
      <details><summary className="cursor-pointer">Review exact repair and verification scripts</summary>
        <p className="mt-2 font-medium">Repair</p><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2">{action.script_text}</pre>
        <p className="mt-2 font-medium">Verification</p><pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2">{action.verification_text}</pre>
      </details>
      {action.status === "proposed" && <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={() => send(`/actions/${encodeURIComponent(action.id)}/decision`, { decision: "approved" })} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">Approve exact action</button>
        <button type="button" disabled={busy} onClick={() => send(`/actions/${encodeURIComponent(action.id)}/decision`, { decision: "rejected" })} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">Reject</button>
      </div>}
      {action.status === "approved" && <button type="button" disabled={busy} onClick={() => send(`/actions/${encodeURIComponent(action.id)}/execute`, {})} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground disabled:opacity-50">Run approved repair and verification</button>}
      {action.repair_run_id && <p>Repair run: {action.repair_run_id} · exit {action.repair_exit_code ?? "unknown"}</p>}
      {action.verification_run_id && <p>Verification run: {action.verification_run_id} · exit {action.verification_exit_code ?? "unknown"}</p>}
      {action.status === "running" && <div className="space-y-2"><p className="text-muted-foreground">Execution was started. Refresh for its result; do not submit another action until the outcome is known.</p>
        {action.started_at && Date.now() - new Date(action.started_at).getTime() > 5 * 60 * 1000 &&
          <button type="button" disabled={busy} onClick={() => send(`/actions/${encodeURIComponent(action.id)}/reconcile`, {})} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">Mark interrupted attempt as unknown</button>}
      </div>}
    </div>)}
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send("/actions", {
      expectedReviewVersion: supportCase.review_version, script, verificationScript, expectedEffect, recoveryNotes,
    }); }}>
      <h4 className="font-medium">Propose a repair for {supportCase.target_address}</h4>
      <label className="block">Expected effect<input required maxLength={1000} value={expectedEffect} onChange={(event) => setExpectedEffect(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
      <label className="block">Reviewed PowerShell repair script<textarea required maxLength={16384} rows={5} value={script} onChange={(event) => setScript(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 font-mono" /></label>
      <label className="block">PowerShell verification script (throw an error when the symptom remains)<textarea required maxLength={16384} rows={4} value={verificationScript} onChange={(event) => setVerificationScript(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 font-mono" /></label>
      <label className="block">Recovery plan if the change fails<textarea required maxLength={2000} rows={2} value={recoveryNotes} onChange={(event) => setRecoveryNotes(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
      <button type="submit" disabled={busy} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">Propose repair</button>
    </form>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status" className="text-muted-foreground">{notice}</p>}
  </section>;
}

function CaseReviewForm({ companyId, supportCase, onSaved,automated = false }: { companyId: string; supportCase: CaseRow; onSaved: () => void; automated?: boolean }) {
  const [serviceDomain, setServiceDomain] = useState(supportCase.service_domain);
  const [workKind, setWorkKind] = useState(supportCase.work_kind);
  const [status, setStatus] = useState(supportCase.status);
  const [assetRef, setAssetRef] = useState(supportCase.asset_ref ?? "");
  const [targetAddress, setTargetAddress] = useState(supportCase.target_address ?? "");
  const [accessMethod, setAccessMethod] = useState(supportCase.access_method ?? "unknown");
  const [orderRef, setOrderRef] = useState(supportCase.order_ref ?? "");
  const [vendorRef, setVendorRef] = useState(supportCase.vendor_ref ?? "");
  const [resolutionSummary, setResolutionSummary] = useState(supportCase.resolution_summary ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(supportCase.id)}/review`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, expectedVersion: supportCase.review_version, serviceDomain, workKind, status,
          assetRef, targetAddress, accessMethod, orderRef, vendorRef, resolutionSummary }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return <form onSubmit={save} className="space-y-3 rounded-md border border-border p-3">
    <h3 className="font-semibold">Review and route case</h3>
    {automated && <p className="text-sm text-muted-foreground">Close or reopen this ticket using “Confirm the reported problem.” A review changes the target/classification and invalidates earlier repair approvals.</p>}
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Service domain
        <select value={serviceDomain} onChange={(event) => {
          const next = event.target.value;
          setServiceDomain(next);
          if (next !== "software" && (workKind === "bug" || workKind === "feature")) setWorkKind("incident");
        }} className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground">
          <option value="unclassified">Unclassified</option><option value="software">Software</option>
          <option value="it">Computers and IT</option><option value="equipment">Equipment</option>
          <option value="shipping">Shipping</option><option value="production">Production</option>
          <option value="facilities">Facilities</option><option value="general">General help</option>
        </select>
      </label>
      <label className="text-sm">Work kind
        <select value={workKind} onChange={(event) => setWorkKind(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground">
          <option value="unclassified">Unclassified</option><option value="question">Question</option>
          <option value="incident">Incident</option><option value="task">Task</option>
          {serviceDomain === "software" && <option value="bug">Bug</option>}
          {serviceDomain === "software" && <option value="feature">Feature</option>}
        </select>
      </label>
      <label className="text-sm">Status
        <select value={status} onChange={(event) => setStatus(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground">
          <option value="new">New</option><option value="triage">Triage</option>
          <option value="waiting">Waiting</option><option value="resolved" disabled={automated}>Resolved</option>
        </select>
      </label>
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-sm">Device or asset<input maxLength={200} value={assetRef} onChange={(event) => setAssetRef(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" /></label>
      <label className="text-sm">Order or shipment<input maxLength={200} value={orderRef} onChange={(event) => setOrderRef(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" /></label>
      <label className="text-sm">Vendor reference<input maxLength={200} value={vendorRef} onChange={(event) => setVendorRef(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" /></label>
    </div>
    {(serviceDomain === "it" || serviceDomain === "equipment") && <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm">Target hostname or IP (when known)
        <input maxLength={255} value={targetAddress} onChange={(event) => setTargetAddress(event.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" />
      </label>
      <label className="text-sm">Access method
        <select value={accessMethod} onChange={(event) => setAccessMethod(event.target.value)}
          className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground">
          <option value="unknown">Not confirmed</option><option value="winrm">WinRM (HTTP)</option>
          <option value="winrm_https">WinRM (HTTPS)</option><option value="wmi_dcom_smb">WMI / DCOM + SMB</option>
          <option value="ssh">SSH</option><option value="smb">SMB file access</option><option value="rdp">RDP (interactive)</option><option value="rmm">RMM</option>
          <option value="local">Local to host</option><option value="other">Other</option>
        </select>
      </label>
    </div>}
    <label className="block text-sm">Resolution summary
      <textarea maxLength={2000} required={status === "resolved"} rows={2} value={resolutionSummary} onChange={(event) => setResolutionSummary(event.target.value)}
        className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" />
    </label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <button type="submit" disabled={saving} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/30 disabled:opacity-50">{saving ? "Saving…" : "Save review"}</button>
  </form>;
}

export function SupportSidebar(_props: PluginSidebarProps) {
  const host = useHostContext();
  const { data, loading, error } = usePluginData<{ visible: boolean }>("support.sidebar", { companyId: host.companyId });
  if (loading || error || !data?.visible) return null;
  const href = host.companyPrefix ? `/${host.companyPrefix}/support` : "/support";
  return <a href={href} className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] font-medium text-foreground hover:bg-accent/30">Support</a>;
}

export function SupportPage(_props: PluginPageProps) {
  const host = useHostContext();
  const companyId = host.companyId;
  const [caseId, setCaseId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [softwareRouteId, setSoftwareRouteId] = useState("");
  const [assigneeAgentId, setAssigneeAgentId] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [evidence, setEvidence] = useState("");
  const [issueError, setIssueError] = useState<string | null>(null);
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [syncingThread, setSyncingThread] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [startingWork, setStartingWork] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [startResult, setStartResult] = useState<string | null>(null);
  const [externalTicketRef, setExternalTicketRef] = useState("");
  const [markingSubmitted, setMarkingSubmitted] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const { data: cases, loading, error, refresh } = usePluginData<CaseRow[]>("support.cases", { companyId, status: statusFilter });
  const overview = usePluginData<{ status: string; count: string }[]>("support.overview", { companyId });
  const softwareRoutes = usePluginData<{ id: string; productName: string; destinationKind: string; destination: string }[]>("support.softwareRoutes", { companyId });
  const agents = usePluginData<{ id: string; name: string; status: string }[]>("support.agents", { companyId });
  const setup = usePluginData<SupportSetup>("support.setup", { companyId });
  const [setupVersion, setSetupVersion] = useState(0);
  const [canDiagnose, setCanDiagnose] = useState<boolean | null>(null);
  const refreshSetup = () => { setup.refresh(); setSetupVersion(value => value + 1); };
  const detail = usePluginData<Detail | null>("support.case", { companyId, caseId });
  const selectedDetail = detail.data?.supportCase.id === caseId && detail.data.supportCase.company_id === companyId
    ? detail.data : null;
  const counts = useMemo(() => {
    const byStatus = Object.fromEntries((overview.data ?? []).map((row) => [row.status, Number(row.count)]));
    return {
      all: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      new: byStatus.new ?? 0,
      triage: byStatus.triage ?? 0,
      waiting: byStatus.waiting ?? 0,
      resolved: byStatus.resolved ?? 0,
    };
  }, [overview.data]);

  async function createIssue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!companyId || !caseId || !selectedDetail ||
        (selectedDetail.supportCase.service_domain === "software" && !softwareRouteId)) return;
    setIssueError(null);
    setCreatingIssue(true);
    try {
      const software = selectedDetail.supportCase.service_domain === "software";
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/${software ? "escalation" : "issues"}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(software ? { companyId, routeId: softwareRouteId, title: issueTitle, evidence }
          : { companyId, projectId: null, assigneeAgentId: assigneeAgentId || null,
            kind: "followup", title: issueTitle, evidence }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      detail.refresh();
    } catch (reason) {
      setIssueError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCreatingIssue(false);
    }
  }

  async function syncThread() {
    if (!companyId || !caseId) return;
    setSyncError(null);
    setSyncingThread(true);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/sync`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      detail.refresh();
      refresh();
    } catch (reason) {
      setSyncError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSyncingThread(false);
    }
  }

  async function startWork() {
    if (!companyId || !caseId) return;
    setStartError(null);
    setStartResult(null);
    setStartingWork(true);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/start-work`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId }),
      });
      const result = await response.json() as { error?: string; queued?: boolean; runId?: string | null };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      setStartResult(result.queued ? "Agent work queued. Open the issue to follow progress." : "No new run was queued. Check the issue for an existing run or blocker.");
      detail.refresh();
    } catch (reason) {
      setStartError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStartingWork(false);
    }
  }

  async function markSubmitted(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!companyId || !caseId) return;
    setSubmissionError(null);
    setMarkingSubmitted(true);
    try {
      const response = await fetch(`/api/plugins/customer-support/api/cases/${encodeURIComponent(caseId)}/escalation/submitted`, {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ companyId, externalTicketRef }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
      detail.refresh();
    } catch (reason) {
      setSubmissionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMarkingSubmitted(false);
    }
  }

  return <div className="space-y-4 text-foreground">
    <div className="flex items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">Support</h1><p className="text-sm text-muted-foreground">Incoming cases for this company</p></div>
      <button type="button" onClick={() => { refresh(); overview.refresh(); if (caseId) detail.refresh(); }} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/30">Refresh</button>
    </div>
    {companyId && <SupportReadiness key={companyId} companyId={companyId} companyPrefix={host.companyPrefix} setup={setup.data} loading={setup.loading} error={setup.error} refreshToken={setupVersion} onRefresh={refreshSetup} onDiagnosticPermission={setCanDiagnose} />}
    {companyId && <RemoteSetup companyId={companyId} onChanged={refreshSetup} canDiagnose={canDiagnose} />}
    {companyId && <DiscoverySetup key={companyId} companyId={companyId} />}
    {companyId && <TicketSetup key={`tickets:${companyId}`} companyId={companyId} />}
    {companyId && <SupportToolkit key={companyId} companyId={companyId} />}
    {companyId && <SupportDirectory key={`directory:${companyId}`} companyId={companyId} />}
    {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">Could not load cases: {String(error)}</p>}
    {overview.error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">Could not load overview: {String(overview.error)}</p>}
    {loading && <p className="text-sm text-muted-foreground">Loading cases…</p>}
    {!overview.loading && !overview.error && <div className="grid grid-cols-2 gap-2 md:grid-cols-5" aria-label="Case overview">
      {(["all", "new", "triage", "waiting", "resolved"] as const).map((status) => <button
        key={status} type="button" onClick={() => setStatusFilter(status)} aria-pressed={statusFilter === status}
        className="rounded-md border border-border bg-card p-3 text-left text-card-foreground hover:bg-accent/30"
      ><span className="block text-xs capitalize text-muted-foreground">{status}</span><span className="text-xl font-semibold">{counts[status]}</span></button>)}
    </div>}
    {!loading && !error && !overview.loading && !overview.error && cases?.length === 0 && counts.all === 0 && <p className="rounded-md border border-border p-4 text-sm text-muted-foreground">No support cases yet.</p>}
    {!loading && !error && !overview.loading && !overview.error && cases?.length === 0 && counts.all > 0 && <p className="text-sm text-muted-foreground">No cases in this status.</p>}
    {!loading && !error && cases?.length !== 0 && <p className="text-xs text-muted-foreground">Showing up to 100 recent cases for this filter. Overview counts include all cases.</p>}
    <div className="grid gap-4 lg:grid-cols-[minmax(240px,1fr)_minmax(0,2fr)]">
      <div className="space-y-2">
        {cases?.map((item) => <button key={item.id} type="button" onClick={() => { setCaseId(item.id); setSoftwareRouteId(""); setAssigneeAgentId(""); setIssueTitle(""); setEvidence(""); setIssueError(null); setSyncError(null); setStartError(null); setStartResult(null); setExternalTicketRef(""); setSubmissionError(null); }}
          className="block w-full rounded-md border border-border bg-card p-3 text-left text-card-foreground hover:bg-accent/30"
          aria-pressed={caseId === item.id}>
          <span className="block font-medium">{item.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{item.source} · {item.service_domain} / {item.work_kind} · {item.status} · {new Date(item.last_message_at).toLocaleString()}</span>
        </button>)}
      </div>
      <div className="rounded-md border border-border bg-card p-4 text-card-foreground">
        {!caseId && <p className="text-sm text-muted-foreground">Select a case to read its messages.</p>}
        {caseId && detail.loading && <p className="text-sm text-muted-foreground">Loading conversation…</p>}
        {caseId && detail.error && <p role="alert" className="text-sm text-destructive">Could not load conversation: {String(detail.error)}</p>}
        {caseId && !detail.loading && !detail.error && !selectedDetail && <p className="text-sm text-muted-foreground">Case not found.</p>}
        {selectedDetail && <div className="space-y-4">
          {companyId && selectedDetail.ticketJob && <TicketProgress key={`${companyId}:${selectedDetail.supportCase.id}`} companyId={companyId} caseId={selectedDetail.supportCase.id} companyPrefix={host.companyPrefix} job={selectedDetail.ticketJob} onChanged={() => detail.refresh()} />}
          {companyId && selectedDetail.ticketJob && <TicketOutcome key={`${companyId}:${selectedDetail.supportCase.id}`} companyId={companyId} caseId={selectedDetail.supportCase.id} reviewVersion={selectedDetail.supportCase.review_version ?? 0} messageId={selectedDetail.ticketJob.latest_message_id} onChanged={() => detail.refresh()} />}
          {companyId && <SupportMessages key={`${companyId}:${selectedDetail.supportCase.id}`} companyId={companyId} caseId={selectedDetail.supportCase.id} reviewVersion={selectedDetail.supportCase.review_version ?? 0} source={selectedDetail.supportCase.source} software={selectedDetail.supportCase.service_domain === "software"} routes={softwareRoutes.data ?? []} rows={selectedDetail.outbound ?? []} onChanged={() => detail.refresh()} />}
          <div><h2 className="text-lg font-semibold">{selectedDetail.supportCase.title}</h2>
            {selectedDetail.supportCase.external_url && <a href={selectedDetail.supportCase.external_url} target="_blank" rel="noreferrer" className="text-sm text-primary underline">Open in source</a>}
          </div>
          {selectedDetail.supportCase.source === "slack" && <div>
            <button type="button" disabled={syncingThread} onClick={syncThread}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent/30 disabled:opacity-50">
              {syncingThread ? "Syncing…" : "Sync Slack replies now"}
            </button>
            {syncError && <p role="alert" className="mt-2 text-sm text-destructive">{syncError}</p>}
          </div>}
          {companyId && <CaseReviewForm automated={!!selectedDetail.ticketJob} key={`${companyId}:${selectedDetail.supportCase.id}:${selectedDetail.supportCase.review_version}`} companyId={companyId}
            supportCase={selectedDetail.supportCase} onSaved={() => { detail.refresh(); refresh(); overview.refresh(); }} />}
          {companyId && selectedDetail.supportCase.target_address && ["it", "equipment"].includes(selectedDetail.supportCase.service_domain) &&
            <SupportActions key={`${companyId}:${selectedDetail.supportCase.id}`} companyId={companyId} detail={detail.data!} onChanged={() => detail.refresh()} />}
          {selectedDetail.diagnostics?.length > 0 && <section className="space-y-2"><h3 className="font-semibold">Recorded diagnostic findings</h3>
            {selectedDetail.diagnostics.map((item, index) => <details key={`${item.created_at}:${index}`} className="rounded-md border border-border p-3 text-sm">
              <summary className="cursor-pointer">{item.check_kind} · {new Date(item.created_at).toLocaleString()}</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(item.result, null, 2)}</pre>
            </details>)}
          </section>}
          {selectedDetail.messages.map((message) => <article key={message.id} className="rounded-md border border-border p-3">
            <div className="text-xs text-muted-foreground">{message.author_kind}{message.author_external_id ? ` (${message.author_external_id})` : ""} · {new Date(message.occurred_at).toLocaleString()}</div>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{message.body}</p>
            {companyId && <RestrictedSource key={`${companyId}:${message.id}`} companyId={companyId} caseId={selectedDetail.supportCase.id} messageId={message.id} />}
            {message.attachments?.length > 0 && <ul className="mt-2 space-y-1 text-xs">
              {message.attachments.map((file) => <li key={file.id}>
                {file.permalink ? <a href={file.permalink} target="_blank" rel="noreferrer" className="text-primary underline">{file.name}</a> : <span>{file.name}</span>}
                {file.mimeType && <span className="ml-2 text-muted-foreground">{file.mimeType}</span>}
              </li>)}
            </ul>}
          </article>)}
          {selectedDetail.linkedIssue ? <div className="rounded-md border border-border p-3 text-sm">
            <span className="font-medium">Reviewed {selectedDetail.linkedIssue.kind} issue:</span>{" "}
            <a className="text-primary underline" href={host.companyPrefix
              ? `/${host.companyPrefix}/issues/${selectedDetail.linkedIssue.id}` : `/issues/${selectedDetail.linkedIssue.id}`}>
              {selectedDetail.linkedIssue.identifier ?? selectedDetail.linkedIssue.title}
            </a>
            <span className="ml-2 text-muted-foreground">{selectedDetail.linkedIssue.status}</span>
            {selectedDetail.linkedIssue.assigneeAgentId &&
              !["backlog", "done", "cancelled"].includes(selectedDetail.linkedIssue.status) &&
              <div className="mt-3">
                <button type="button" disabled={startingWork} onClick={startWork}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
                  {startingWork ? "Starting…" : "Start agent work"}
                </button>
              </div>}
            {startError && <p role="alert" className="mt-2 text-destructive">{startError}</p>}
            {startResult && <p role="status" className="mt-2 text-muted-foreground">{startResult}</p>}
          </div> : null}
          {selectedDetail.escalation && <div className="space-y-2 rounded-md border border-border p-3 text-sm">
            <h3 className="font-semibold">{selectedDetail.escalation.product_name} vendor escalation · {selectedDetail.escalation.status}</h3>
            <p>{selectedDetail.escalation.title}</p>
            <p className="whitespace-pre-wrap break-words">{selectedDetail.escalation.evidence}</p>
            {selectedDetail.escalation.destination_kind === "email"
              ? <a className="text-primary underline" href={`mailto:${selectedDetail.escalation.destination}?subject=${encodeURIComponent(selectedDetail.escalation.title)}&body=${encodeURIComponent(selectedDetail.escalation.evidence)}`}>Open email draft to {selectedDetail.escalation.destination}</a>
              : <a className="text-primary underline" href={selectedDetail.escalation.destination} target="_blank" rel="noreferrer">Open Jira intake form</a>}
            {selectedDetail.escalation.status === "draft" && <form onSubmit={markSubmitted} className="space-y-2">
              <label className="block">Sent email or Jira ticket reference
                <input required maxLength={500} value={externalTicketRef} onChange={(event) => setExternalTicketRef(event.target.value)}
                  className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" />
              </label>
              {submissionError && <p role="alert" className="text-destructive">{submissionError}</p>}
              <button type="submit" disabled={markingSubmitted} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50">{markingSubmitted ? "Saving…" : "Mark submitted"}</button>
            </form>}
            {selectedDetail.escalation.external_ticket_ref && <p>Reference: {selectedDetail.escalation.external_ticket_ref}</p>}
          </div>}
          {!selectedDetail.linkedIssue && !selectedDetail.escalation && selectedDetail.supportCase.service_domain !== "unclassified" && ["bug", "feature", "task", "incident"].includes(selectedDetail.supportCase.work_kind) ? <form onSubmit={createIssue} className="space-y-3 rounded-md border border-border p-3">
            <h3 className="font-semibold">{selectedDetail.supportCase.service_domain === "software" ? "Draft vendor escalation" : "Create reviewed work item"}</h3>
            <p className="text-xs text-muted-foreground">Write a reviewed title and evidence. Software reports go through the vendor's support email or Jira intake form.</p>
            {selectedDetail.supportCase.service_domain === "software" && softwareRoutes.error && <p role="alert" className="text-sm text-destructive">Could not load software routes: {String(softwareRoutes.error)}</p>}
            {selectedDetail.supportCase.service_domain === "software" && <label className="block text-sm">Product and intake channel
              <select required value={softwareRouteId} onChange={(event) => setSoftwareRouteId(event.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground">
                <option value="">Select product and intake channel</option>
                {softwareRoutes.data?.map((route) => <option key={route.id} value={route.id}>{route.productName} → {route.destinationKind === "email" ? route.destination : "Jira form"}</option>)}
              </select>
            </label>}
            {selectedDetail.supportCase.service_domain === "software" && !softwareRoutes.loading && !softwareRoutes.error && softwareRoutes.data?.length === 0 &&
              <p className="text-sm text-muted-foreground">Configure the vendor's email or Jira intake route before drafting an escalation.</p>}
            {agents.error && <p role="alert" className="text-sm text-destructive">Could not load agents: {String(agents.error)}</p>}
            {selectedDetail.supportCase.service_domain !== "software" && <label className="block text-sm">Assign agent (optional)
              <select value={assigneeAgentId} onChange={(event) => setAssigneeAgentId(event.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground">
                <option value="">Leave unassigned</option>
                {agents.data?.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} ({agent.status})</option>)}
              </select>
            </label>}
            {selectedDetail.supportCase.service_domain !== "software" && <p className="text-xs text-muted-foreground">Assigning an agent creates the issue with that assignee; it does not start a run from this form.</p>}
            <label className="block text-sm">Reviewed title
              <input required maxLength={300} value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" />
            </label>
            <label className="block text-sm">Reviewed evidence
              <textarea required maxLength={10000} rows={4} value={evidence} onChange={(event) => setEvidence(event.target.value)}
                className="mt-1 block w-full rounded-md border border-border bg-background p-2 text-foreground" />
            </label>
            {selectedDetail.supportCase.service_domain === "software" && <p className="text-xs text-muted-foreground">This text is intended for the vendor. Keep access credentials in the source conversation.</p>}
            {issueError && <p role="alert" className="text-sm text-destructive">{issueError}</p>}
            <button type="submit" disabled={creatingIssue ||
              (selectedDetail.supportCase.service_domain === "software"
                ? softwareRoutes.loading || Boolean(softwareRoutes.error) || !softwareRouteId
                : agents.loading || Boolean(agents.error))}
              className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
              {creatingIssue ? "Saving…" : selectedDetail.supportCase.service_domain === "software" ? "Save vendor escalation draft" : "Create Paperclip issue"}
            </button>
          </form> : !selectedDetail.linkedIssue && !selectedDetail.escalation
            ? <p className="rounded-md border border-border p-3 text-sm text-muted-foreground">Review the service domain and mark actionable work as an incident, task, software bug, or feature before creating a work item. Questions can be resolved on the case alone.</p>
            : null}
        </div>}
      </div>
    </div>
  </div>;
}
