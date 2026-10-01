import { supportErrorMessage } from "./error-message.js";
import { useEffect, useState } from "react";
import type { SupportSetup } from "../support-setup.js";
import { checkSetupPermission, type PermissionState } from "./setup-client.js";

type Plugin = { id: string; pluginKey: string; status: string };
type Secret = { id: string };
const permissionNames = { diagnose: "Investigate computers", repair: "Approve and run repairs", respond: "Approve support messages" };
async function metadata<T>(url: string): Promise<T[]> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Metadata is unavailable");
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error("Unexpected metadata response");
  return body as T[];
}
export function SupportReadiness({ companyId, companyPrefix, setup, loading, error, refreshToken, onRefresh, onDiagnosticPermission }: {
  companyId: string; companyPrefix: string | null; setup: SupportSetup | null | undefined; loading: boolean; error: unknown;
  refreshToken: number; onRefresh: () => void; onDiagnosticPermission: (allowed: boolean | null) => void;
}) {
  const [permissions, setPermissions] = useState<Record<string, PermissionState>>({});
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [secretIds, setSecretIds] = useState<string[] | null>(null);
  const [lookupErrors, setLookupErrors] = useState<string[]>([]);
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setChecking(true); setPermissions({}); setSecretIds(null); setPlugins([]); setLookupErrors([]);
    onDiagnosticPermission(null);
    const actions = ["diagnose", "repair", "respond"] as const;
    Promise.all([
      Promise.all(actions.map(action => checkSetupPermission(fetch, companyId, action))),
      Promise.allSettled([
        metadata<Plugin>("/api/plugins"),
        metadata<Secret>(`/api/companies/${encodeURIComponent(companyId)}/secrets`),
      ]),
    ]).then(([grants, lookups]) => {
      if (cancelled) return;
      setPermissions(Object.fromEntries(actions.map((action, index) => [action, grants[index]!])));
      onDiagnosticPermission(grants[0]!.allowed);
      const failures: string[] = [];
      if (lookups[0]!.status === "fulfilled") setPlugins(lookups[0]!.value as Plugin[]);
      else failures.push("Could not check installed communication plugins. Refresh or ask an administrator to check Plugin settings.");
      if (lookups[1]!.status === "fulfilled") setSecretIds((lookups[1]!.value as Secret[]).map(secret => secret.id));
      else failures.push("Could not check company secret references. This does not mean the saved password is wrong.");
      setLookupErrors(failures);
    }).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [companyId, refreshToken, onDiagnosticPermission]);

  const settingsLink = (key: string) => {
    const plugin = plugins.find(item => item.pluginKey === key);
    return plugin ? `/instance/settings/plugins/${plugin.id}` : "/instance/settings/plugins";
  };
  const pluginStatus = (key: string) => checking || lookupErrors.some(message => message.includes("installed communication")) ? "not checked"
    : plugins.find(item => item.pluginKey === key)?.status === "ready" ? "running" : "missing or inactive";
  const windows = setup?.windows ?? [];
  const tested = windows.find(group => group.identityTest?.status === "succeeded" && group.identityTest.settingsMatch);
  const prompt = `Investigate ${tested?.identityTest?.target ?? "COMPUTER-NAME"}. Show me your findings before making changes.`;
  return <section className="space-y-3 rounded-md border border-border bg-card p-4 text-sm text-card-foreground" aria-label="Support setup checklist">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Support setup checklist</h2><button type="button" onClick={onRefresh} className="rounded-md border border-border px-3 py-1.5">Refresh setup checks</button></div>
    <p className="text-muted-foreground">For direct Clippy support, start with Windows access and your permissions. Communication is needed when receiving requests or sending replies.</p>
    {(loading || checking) && <p role="status">Checking saved setup and your permissions…</p>}
    {Boolean(error) && <p role="alert" className="text-destructive">Could not load saved support setup: {supportErrorMessage(error)}</p>}
    {lookupErrors.map(message => <p key={message} role="alert" className="text-destructive">{message}</p>)}
    <div className="grid gap-3 lg:grid-cols-3">
      <section className="space-y-2 rounded-md border border-border p-3"><h3 className="font-medium">1. Windows access</h3>
        {!loading && !error && setup && !Array.isArray(setup.windows) && <p role="alert" className="text-destructive">Restart Support Desk and refresh this page to load the new setup checks.</p>}
        {!loading && !error && setup && Array.isArray(setup.windows) && !windows.length && <p>Not configured. Save an access group below with the Windows account, domain/range and company password secret.</p>}
        {windows.map(group => <div key={group.id} className="space-y-1">
          <p>{group.id}: {group.configured ? "settings saved" : "needs correction"}.</p>
          {group.issue && <p className="text-destructive">{group.issue}</p>}
          {secretIds !== null && <p>{secretIds.includes(group.passwordRef) ? "Password reference belongs to this company." : "Password secret is missing from this company. Choose a company secret below."}</p>}
          {!group.identityTest && <p>Connection not tested here yet. Enter a computer below and select Test identity.</p>}
          {group.identityTest && <p>Last identity check on {group.identityTest.target}: {group.identityTest.status === "succeeded" ? "connected" : "failed"}, {new Date(group.identityTest.checkedAt).toLocaleString()}. {group.identityTest.settingsMatch ? "" : "Access settings changed; test again."}</p>}
        </div>)}
        <p className="text-xs text-muted-foreground">A saved secret reference does not verify its password. A past connection test applies to that computer at that time; changed passwords or network conditions need a new test.</p>
      </section>
      <section className="space-y-2 rounded-md border border-border p-3"><h3 className="font-medium">2. Your permissions</h3>
        {Object.entries(permissionNames).map(([action, label]) => <div key={action}><p>{label}: {permissions[action]?.allowed === true ? "allowed" : permissions[action]?.allowed === false ? "not allowed" : "not checked"}.</p>{permissions[action]?.error && <p role="alert" className="text-destructive">{permissions[action]!.error}</p>}</div>)}
        <p className="text-muted-foreground">An administrator grants these separately in Company access. Repair permission does not grant message approval.</p>
        {companyPrefix && <a href={`/${companyPrefix.replace(/^\/+|\/+$/g, "")}/company/settings/access`} className="text-primary underline">Open Company access</a>}
      </section>
      <section className="space-y-2 rounded-md border border-border p-3"><h3 className="font-medium">3. Communication (optional for direct Clippy)</h3>
        {setup && !setup.connections.length && <p>No incoming message routes. Direct computer support can still work.</p>}
        {setup?.connections.map(connection => <p key={connection.id}>{connection.source}: {connection.routeCount} company route(s), via {connection.delivery}.{connection.deliveryPluginId ? ` Plugin ${pluginStatus(connection.deliveryPluginId)}.` : ""}{connection.source === "slack" ? connection.outboundAccount && connection.deliveryPluginId === "slack-tools" ? " Reply workspace linked; verify channel opt-in in Slack Tools." : " Replies need Slack Tools and a Reply workspace key." : " Automated replies for this source are not available yet."}</p>)}
        {setup?.vendorRoutes?.map(route => <p key={route.id}>{route.productName}: {route.destinationKind === "built_in" ? "manual built-in product reporting; retain the actual report reference" : route.destinationKind === "jira_form" ? "manual Jira form intake" : route.outboundAccount ? `email mailbox linked; Email Tools ${pluginStatus("email-tools")}. Verify recipient opt-in in Email Tools.` : "vendor email delivery needs a Vendor email mailbox key"}.</p>)}
        <div className="flex flex-wrap gap-3"><a href={settingsLink("customer-support")} className="text-primary underline">Support Desk settings</a><a href={settingsLink("slack-tools")} className="text-primary underline">Slack Tools settings</a><a href={settingsLink("email-tools")} className="text-primary underline">Email Tools settings</a></div>
        <p className="text-xs text-muted-foreground">Routes and running plugins do not prove intake or delivery. Test a workflow; messages still need review and confirmation before sending.</p>
      </section>
    </div>
    <div className="space-y-1"><h3 className="font-medium">Try Clippy after the identity test</h3><p>Open Clippy in this company and type:</p><p className="select-all rounded-md bg-background p-2">{prompt}</p><p className="text-muted-foreground">Clippy investigates through the saved access, explains findings, and asks you to confirm any repair in the conversation.</p></div>
  </section>;
}
