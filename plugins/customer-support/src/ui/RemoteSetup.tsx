import { useEffect, useState } from "react";

type Secret = { id: string; name: string };
type Method = "Auto" | "WinRMHttps" | "WinRMHttp" | "Wmi";
type Kind = "dns_suffix" | "ipv4_cidr" | "exact";
type Rule = { kind: Kind; value: string; transport: Method; allowProcessExecutionPolicyBypass?: boolean };
type Profile = { id: string; companyId: string; credentialUser: string; passwordRef: string;
  targets?: { address: string; transport: Method; allowProcessExecutionPolicyBypass?: boolean }[];
  scopes?: { kind: "dns_suffix" | "ipv4_cidr"; value: string; transport: Method; allowProcessExecutionPolicyBypass?: boolean }[] };
type Config = { connections?: unknown[]; remoteAccessProfiles?: Profile[]; [key: string]: unknown };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body && typeof body === "object" ? body.error ?? `HTTP ${response.status}` : `HTTP ${response.status}`);
  return body;
}

function rules(profile: Profile): Rule[] {
  return [...(profile.scopes ?? []), ...(profile.targets ?? []).map((target) => ({
    kind: "exact" as const, value: target.address, transport: target.transport,
    allowProcessExecutionPolicyBypass: target.allowProcessExecutionPolicyBypass,
  }))];
}

function newProfileId(existing: Profile[]): string {
  // This is a settings row identifier, not a credential or authorization token.
  // crypto.randomUUID is unavailable on some HTTP-hosted Paperclip installations.
  let id: string;
  do {
    id = `windows-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  } while (existing.some((profile) => profile.id === id));
  return id;
}

export function RemoteSetup({ companyId }: { companyId: string }) {
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [userName, setUserName] = useState("");
  const [kind, setKind] = useState<Kind>("dns_suffix");
  const [scope, setScope] = useState("");
  const [testTarget, setTestTarget] = useState("");
  const [method, setMethod] = useState<Method>("Auto");
  const [bypass, setBypass] = useState(false);
  const [secretRef, setSecretRef] = useState("");
  const [secretName, setSecretName] = useState("WINDOWS_SUPPORT_PASSWORD");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUserName(""); setKind("dns_suffix"); setScope(""); setTestTarget("");
    setMethod("Auto"); setBypass(false); setSecretRef(""); setPassword("");
    setLoading(true); setError(null); setNotice(null); setResult(null);
    Promise.all([
      request<Secret[]>(`/api/companies/${companyId}/secrets`),
      request<{ configJson?: Config } | null>("/api/plugins/customer-support/config"),
    ]).then(([available, saved]) => {
      if (cancelled) return;
      setSecrets(available);
      const companyProfiles = (saved?.configJson?.remoteAccessProfiles ?? []).filter((profile) => profile.companyId === companyId);
      setProfiles(companyProfiles);
      if (companyProfiles.length === 1 && rules(companyProfiles[0]!).length === 1) {
        const profile = companyProfiles[0]!;
        const rule = rules(profile)[0]!;
        setUserName(profile.credentialUser); setKind(rule.kind); setScope(rule.value);
        setMethod(rule.transport); setBypass(Boolean(rule.allowProcessExecutionPolicyBypass));
        if (available.some((secret) => secret.id === profile.passwordRef)) setSecretRef(profile.passwordRef);
        if (rule.kind === "exact") setTestTarget(rule.value);
      }
    }).catch((reason) => { if (!cancelled) setError(String(reason)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [companyId]);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null); setNotice(null); setResult(null);
    try {
      const value = scope.trim().toLowerCase();
      const account = userName.trim();
      if (!/^[^\\\s]+\\[^\\\s]+$/.test(account)) throw new Error("Enter the Windows account as DOMAIN\\username.");
      if (kind === "dns_suffix" && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(value)) throw new Error("Enter a DNS domain such as office.example.local.");
      if (kind === "ipv4_cidr" && !/^\d{1,3}(?:\.\d{1,3}){3}\/(?:[89]|[12]\d|3[0-2])$/.test(value)) throw new Error("Enter an IPv4 range such as 192.168.25.0/24.");
      if (kind === "exact" && !/^[a-z0-9._-]+$/.test(value)) throw new Error("Enter one computer hostname or IP address.");
      const saved = await request<{ configJson?: Config } | null>("/api/plugins/customer-support/config");
      const config = saved?.configJson ?? {};
      const all = config.remoteAccessProfiles ?? [];
      const matching = all.filter((profile) => profile.companyId === companyId &&
        rules(profile).some((rule) => rule.kind === kind && rule.value.toLowerCase() === value));
      if (matching.length > 1 || (matching[0] && rules(matching[0]).length !== 1)) throw new Error("This group has an advanced profile. Edit it in Support Desk Configuration.");
      let selected = secretRef;
      if (selected && !secrets.some((secret) => secret.id === selected)) throw new Error("Select a secret belonging to this company.");
      if (!selected) {
        if (!password) throw new Error("Enter a password or choose an existing company secret.");
        const created = await request<Secret>(`/api/companies/${companyId}/secrets`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: secretName.trim(), value: password, description: "Windows support account for Support Desk" }),
        });
        selected = created.id; setSecretRef(created.id);
        setSecrets((current) => [...current, created]); setPassword("");
      }
      const connection = { transport: method, allowProcessExecutionPolicyBypass: bypass };
      const profile: Profile = { id: matching[0]?.id ?? newProfileId(all),
        companyId, credentialUser: account, passwordRef: selected,
        ...(kind === "exact" ? { targets: [{ address: value, ...connection }] }
          : { scopes: [{ kind, value, ...connection }] }) };
      const next = matching[0] ? all.map((item) => item.id === matching[0]!.id ? profile : item) : [...all, profile];
      await request("/api/plugins/customer-support/config", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configJson: { ...config, connections: config.connections ?? [], remoteAccessProfiles: next } }) });
      setProfiles(next.filter((item) => item.companyId === companyId));
      if (kind === "exact") setTestTarget(value);
      setNotice("Access saved. Enter any computer in this group below to test it.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function test() {
    const target = testTarget.trim();
    if (!target) { setError("Enter a computer hostname or IP address to test."); return; }
    setBusy(true); setError(null); setResult(null);
    try {
      setResult(await request<Record<string, unknown>>("/api/plugins/customer-support/api/remote/identity", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId, target }),
      }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-md border border-border p-4 text-sm">
    <div><h2 className="font-semibold">Connect Windows support</h2>
      <p className="text-muted-foreground">Set up one account for a company DNS domain or office IP range. Each case names its affected computer. The password is stored in Paperclip Secrets.</p></div>
    {loading ? <p>Loading remote access settings…</p> : <>
      <form onSubmit={(event) => { void save(event); }} className="grid gap-3 sm:grid-cols-2">
        <label>Windows account<input required placeholder="DOMAIN\\username" value={userName} onChange={(event) => setUserName(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
        <label>Allow computers in<select value={kind} onChange={(event) => setKind(event.target.value as Kind)} className="mt-1 block w-full rounded-md border border-border bg-background p-2">
          <option value="dns_suffix">DNS domain (all computers beneath it)</option><option value="ipv4_cidr">Office IPv4 range</option><option value="exact">One computer only</option>
        </select></label>
        <label>{kind === "dns_suffix" ? "DNS domain" : kind === "ipv4_cidr" ? "IPv4 range (CIDR)" : "Computer hostname or IP"}
          <input required placeholder={kind === "dns_suffix" ? "office.example.local" : kind === "ipv4_cidr" ? "192.168.25.0/24" : "workstation.example.local"}
            value={scope} onChange={(event) => setScope(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
        <label>Connection method<select value={method} onChange={(event) => setMethod(event.target.value as Method)} className="mt-1 block w-full rounded-md border border-border bg-background p-2">
          <option value="Auto">Auto</option><option value="Wmi">WMI / DCOM + SMB</option><option value="WinRMHttps">WinRM HTTPS</option><option value="WinRMHttp">WinRM HTTP</option>
        </select></label>
        <label>Company password secret<select value={secretRef} onChange={(event) => setSecretRef(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2">
          <option value="">Create a new secret below</option>{secrets.map((secret) => <option key={secret.id} value={secret.id}>{secret.name}</option>)}
        </select></label>
        {!secretRef && <><label>Secret name<input required value={secretName} onChange={(event) => setSecretName(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
          <label>Password<input required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label></>}
        <div className="sm:col-span-2 space-y-1">
          <label className="flex items-center gap-2"><input type="checkbox" checked={bypass} onChange={(event) => setBypass(event.target.checked)} />Allow PowerShell scripts for this WMI task only</label>
          <p className="text-xs text-muted-foreground">Select this if a test says scripts are disabled. It starts the remote PowerShell process with ExecutionPolicy Bypass; it does not change the computer's saved policy.</p>
        </div>
        <button type="submit" disabled={busy} className="rounded-md bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50">Save access group</button>
      </form>
      {profiles.length > 0 && <div className="space-y-2"><h3 className="font-medium">Saved access groups</h3>
        {profiles.flatMap((profile) => rules(profile).map((rule) => <div key={`${profile.id}-${rule.kind}-${rule.value}`} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
          <span>{rule.value} · {profile.credentialUser} · {rule.transport}</span>
          <button type="button" disabled={busy} onClick={() => {
            setUserName(profile.credentialUser); setKind(rule.kind); setScope(rule.value); setMethod(rule.transport);
            setBypass(Boolean(rule.allowProcessExecutionPolicyBypass)); setSecretRef(profile.passwordRef); setPassword("");
            if (rule.kind === "exact") setTestTarget(rule.value);
          }} className="rounded-md border border-border px-2 py-1 disabled:opacity-50">Edit</button>
        </div>))}</div>}
      <div className="flex flex-wrap items-end gap-2 rounded-md border border-border p-3">
        <label className="min-w-64 flex-1">Computer to test (no need to save each computer)
          <input placeholder="workstation.office.example.local" value={testTarget} onChange={(event) => setTestTarget(event.target.value)} className="mt-1 block w-full rounded-md border border-border bg-background p-2" /></label>
        <button type="button" disabled={busy || !profiles.length} onClick={() => { void test(); }} className="rounded-md border border-border px-3 py-2 disabled:opacity-50">Test identity (read only)</button>
      </div>
    </>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {result && <pre role="status" className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background p-2">{JSON.stringify(result, null, 2)}</pre>}
  </section>;
}
