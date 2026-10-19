import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { allocateGoogleSecretNames, googleSecretNames } from "../setupNames.js";
import { accountFromGoogleSetup, mergeGoogleAccount, snapshotGoogleSetupInput, type GoogleSetupInput, type PluginConfig } from "../setupConfig.js";
import {
  useHostContext,
  usePluginAction,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

// ---------------------------------------------------------------------------
// Types

interface CompanyRecord {
  id: string;
  name: string;
}

interface LoopbackFlowStart {
  sessionId: string;
  authorizationUrl: string;
  expiresIn: number;
  scopes: string[];
}

interface PollResultPending {
  status: "pending";
}
interface PollResultGranted {
  status: "granted";
  refreshToken: string;
  user: UserInfo;
}
interface PollResultDeniedOrExpired {
  status: "denied" | "expired" | "failed";
  error?: string;
}
type PollResult = PollResultPending | PollResultGranted | PollResultDeniedOrExpired;

interface UserInfo {
  email: string | null;
  name: string | null;
  verified: boolean | null;
}

type WizardStep = "form" | "authorizing" | "creating" | "done";

// ---------------------------------------------------------------------------
// Styles (mirroring kitchen-sink CSS-variable convention)

const stack: CSSProperties = { display: "grid", gap: "12px" };
const card: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: "12px",
  padding: "18px",
  background: "var(--card, transparent)",
};
const subtle: CSSProperties = { fontSize: "13px", opacity: 0.72, lineHeight: 1.45 };
const label: CSSProperties = { fontSize: "12px", fontWeight: 600, opacity: 0.85, marginBottom: 4 };
const input: CSSProperties = {
  width: "100%",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
  fontSize: "13px",
  fontFamily: "inherit",
};
const button: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  background: "transparent",
  color: "inherit",
  padding: "8px 16px",
  fontSize: "13px",
  cursor: "pointer",
};
const primary: CSSProperties = {
  ...button,
  background: "var(--foreground)",
  color: "var(--background)",
  borderColor: "var(--foreground)",
  fontWeight: 600,
};
const codeBlock: CSSProperties = {
  fontFamily: "ui-monospace, SFMono-Regular, monospace",
  fontSize: "20px",
  letterSpacing: "0.06em",
  padding: "10px 14px",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  background: "color-mix(in srgb, var(--muted, #888) 16%, transparent)",
  display: "inline-block",
};
const errorBox: CSSProperties = {
  ...card,
  borderColor: "color-mix(in srgb, #dc2626 60%, var(--border))",
  background: "color-mix(in srgb, #dc2626 12%, transparent)",
};
const successBox: CSSProperties = {
  ...card,
  borderColor: "color-mix(in srgb, #16a34a 60%, var(--border))",
  background: "color-mix(in srgb, #16a34a 12%, transparent)",
};

// ---------------------------------------------------------------------------
// Helpers

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response from ${url}.`);
    }
  }
  if (!res.ok) {
    throw new Error(`Paperclip request failed (HTTP ${res.status}) for ${url}. Check the settings and retry.`);
  }
  return body as T;
}

async function listCompanies(): Promise<CompanyRecord[]> {
  const data = await fetchJson<CompanyRecord[]>("/api/companies");
  return data.sort((a, b) => a.name.localeCompare(b.name));
}

async function readPluginConfig(pluginKey: string): Promise<PluginConfig> {
  const res = await fetch(`/api/plugins/${pluginKey}/config`, { credentials: "include" });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`HTTP ${res.status} reading plugin config`);
  const body = (await res.json()) as { configJson?: PluginConfig };
  return body.configJson ?? {};
}

async function writePluginConfig(pluginKey: string, configJson: PluginConfig): Promise<void> {
  await fetchJson(`/api/plugins/${pluginKey}/config`, {
    method: "POST",
    body: JSON.stringify({ configJson }),
  });
}

async function createSecret(
  companyId: string,
  name: string,
  value: string,
  description?: string,
): Promise<{ id: string }> {
  return await fetchJson(`/api/companies/${companyId}/secrets`, {
    method: "POST",
    body: JSON.stringify({ name, value, description }),
  });
}

// ---------------------------------------------------------------------------
// Page component

export function SetupAccountPage(_props: PluginPageProps) {
  const ctx = useHostContext();

  const startLoopbackFlow = usePluginAction("oauth_start_loopback_flow");
  const pollLoopbackFlow = usePluginAction("oauth_poll_loopback_flow");
  const cancelLoopbackFlow = usePluginAction("oauth_cancel_loopback_flow");
  const submitCallback = usePluginAction("oauth_submit_callback");
  const activeSession = useRef<string | null>(null);
  const startAttempt = useRef(0);

  const [step, setStep] = useState<WizardStep>("form");
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [companies, setCompanies] = useState<CompanyRecord[] | null>(null);
  const [accountKey, setAccountKey] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [ownerCompanyId, setOwnerCompanyId] = useState<string>(ctx.companyId ?? "");
  const [allowedCompanyIds, setAllowedCompanyIds] = useState<Set<string>>(new Set());
  const [scopesText, setScopesText] = useState("");
  const [setAsDefault, setSetAsDefault] = useState(false);

  // Consent-session state
  const [flow, setFlow] = useState<LoopbackFlowStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [consentInput, setConsentInput] = useState<Readonly<GoogleSetupInput> | null>(null);
  const [pollMessage, setPollMessage] = useState<string>("Waiting for you to grant access on Google…");
  const [resolvedRefreshToken, setResolvedRefreshToken] = useState<string | null>(null);
  const [resolvedUser, setResolvedUser] = useState<UserInfo | null>(null);

  // Done state
  const [createdSecretIds, setCreatedSecretIds] = useState<{
    clientIdRef: string;
    clientSecretRef: string;
    refreshTokenRef: string;
  } | null>(null);
  const [createdSecretNames, setCreatedSecretNames] = useState<ReturnType<typeof googleSecretNames> | null>(null);

  useEffect(() => {
    listCompanies().then(setCompanies).catch((err) => setError(getErrorMessage(err)));
  }, []);

  useEffect(() => () => {
    startAttempt.current++;
    if (activeSession.current) void cancelLoopbackFlow({ sessionId: activeSession.current }).catch(() => {});
    activeSession.current = null;
  }, [cancelLoopbackFlow]);

  // Toggle a company in the allowed-companies set.
  function toggleAllowed(id: string): void {
    setAllowedCompanyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // ---------------------------------------------------------------------------
  // Step 1: validate form, start Desktop app consent

  async function handleStart(): Promise<void> {
    if (starting) return;
    setError(null);
    if (!accountKey.trim()) return setError("Account identifier is required.");
    if (!/^[a-z0-9-]+$/.test(accountKey.trim()))
      return setError("Account identifier must be lowercase letters, digits, and hyphens only.");
    try { googleSecretNames(accountKey, "0".repeat(16)); }
    catch (err) { return setError(getErrorMessage(err)); }
    if (!clientId.trim()) return setError("Client ID is required.");
    if (!clientSecret.trim()) return setError("Client Secret is required.");
    if (!ownerCompanyId) return setError("Pick a company to own the secrets.");
    if (allowedCompanyIds.size === 0)
      return setError("Pick at least one company to allow under Allowed Companies.");

    const scopes = scopesText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const input = snapshotGoogleSetupInput({
      accountKey: accountKey.trim(), displayName: displayName.trim(),
      clientId: clientId.trim(), clientSecret: clientSecret.trim(), ownerCompanyId,
      allowedCompanies: Array.from(allowedCompanyIds), scopes, setAsDefault,
    });
    setConsentInput(input);

    setStarting(true);
    const attempt = ++startAttempt.current;

    let started: LoopbackFlowStart;
    try {
      started = (await startLoopbackFlow({
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scopes: input.scopes.length > 0 ? input.scopes : undefined,
      })) as LoopbackFlowStart;
      if (attempt !== startAttempt.current) {
        void cancelLoopbackFlow({ sessionId: started.sessionId }).catch(() => {});
        return;
      }
    } catch (err) {
      if (attempt !== startAttempt.current) return;
      setError(getErrorMessage(err));
      return;
    } finally {
      setStarting(false);
    }
    activeSession.current = started.sessionId;
    setFlow(started);
    setStep("authorizing");
    setPollMessage("Waiting for you to grant access on Google…");
  }

  // ---------------------------------------------------------------------------
  // Step 2: poll the worker session. Google calls the listener or the operator pastes its URL.

  useEffect(() => {
    if (step !== "authorizing" || !flow) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const startedAt = Date.now();
    const expiresAtMs = startedAt + flow.expiresIn * 1000;

    async function tick(): Promise<void> {
      if (cancelled) return;
      if (Date.now() > expiresAtMs) {
        void cancelLoopbackFlow({ sessionId: flow!.sessionId }).catch(() => {});
        activeSession.current = null;
        setError("Consent session expired. Start again to retry.");
        setStep("form");
        setFlow(null);
        return;
      }
      try {
        const r = (await pollLoopbackFlow({
          sessionId: flow!.sessionId,
        })) as PollResult;
        if (cancelled) return;
        if (r.status === "pending") {
          timer = setTimeout(tick, 1500);
          return;
        }
        if (r.status === "denied") {
          activeSession.current = null;
          setError("You denied access on Google's consent screen. Start again to retry.");
          setStep("form");
          setFlow(null);
          return;
        }
        if (r.status === "expired" || r.status === "failed") {
          activeSession.current = null;
          setError(r.error ?? "Consent session expired. Start again to retry.");
          setStep("form");
          setFlow(null);
          return;
        }
        if (r.status !== "granted") return;
        activeSession.current = null;
        setCallbackUrl("");
        setResolvedRefreshToken(r.refreshToken);
        setResolvedUser(r.user);
        setStep("creating");
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setStep("form");
        void cancelLoopbackFlow({ sessionId: flow!.sessionId }).catch(() => {});
        activeSession.current = null;
        setFlow(null);
      }
    }

    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, flow, pollLoopbackFlow, cancelLoopbackFlow]);

  async function handleCallback(): Promise<void> {
    if (!flow || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await submitCallback({ sessionId: flow.sessionId, callbackUrl });
      setCallbackUrl("");
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setSubmitting(false); }
  }

  // ---------------------------------------------------------------------------
  // Step 3: create the 3 secrets, update plugin config

  useEffect(() => {
    if (step !== "creating" || !resolvedRefreshToken || !consentInput) return;
    const input = consentInput;

    let cancelled = false;
    (async () => {
      try {
        const existingSecrets = await fetchJson<{ name: string }[]>(`/api/companies/${input.ownerCompanyId}/secrets`);
        if (cancelled) return;
        const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, "0")).join("");
        const names = allocateGoogleSecretNames(input.accountKey, existingSecrets.map(s => s.name), suffix);
        const cidSecret = await createSecret(
          input.ownerCompanyId,
          names.clientId,
          input.clientId,
          `Google OAuth client ID for ${input.accountKey}`,
        );
        if (cancelled) return;
        const csSecret = await createSecret(
          input.ownerCompanyId,
          names.clientSecret,
          input.clientSecret,
          `Google OAuth client secret for ${input.accountKey}`,
        );
        if (cancelled) return;
        const rtSecret = await createSecret(
          input.ownerCompanyId,
          names.refreshToken,
          resolvedRefreshToken,
          `Google OAuth refresh token for ${input.accountKey}`,
        );
        if (cancelled) return;

        const existing = await readPluginConfig("google-workspace");
        const newAccount = accountFromGoogleSetup(input, {
          clientIdRef: cidSecret.id,
          clientSecretRef: csSecret.id,
          refreshTokenRef: rtSecret.id,
        }, resolvedUser?.email);

        const nextConfig = mergeGoogleAccount(existing, newAccount, input.setAsDefault);
        await writePluginConfig("google-workspace", nextConfig);

        if (cancelled) return;
        setCreatedSecretIds({
          clientIdRef: cidSecret.id,
          clientSecretRef: csSecret.id,
          refreshTokenRef: rtSecret.id,
        });
        setCreatedSecretNames(names);
        setStep("done");
        setResolvedRefreshToken(null);
        setClientSecret("");
        setConsentInput(snapshotGoogleSetupInput({ ...input, clientSecret: "" }));
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setStep("form");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    step,
    resolvedRefreshToken,
    consentInput,
    resolvedUser,
  ]);

  // ---------------------------------------------------------------------------
  // Render helpers

  function startOver(): void {
    startAttempt.current++;
    if (activeSession.current) void cancelLoopbackFlow({ sessionId: activeSession.current }).catch(() => {});
    activeSession.current = null;
    setStep("form");
    setError(null);
    setFlow(null);
    setConsentInput(null);
    setCallbackUrl("");
    setResolvedRefreshToken(null);
    setResolvedUser(null);
    setCreatedSecretIds(null);
    setCreatedSecretNames(null);
  }

  function ownerNameFor(id: string): string {
    return companies?.find((c) => c.id === id)?.name ?? id;
  }

  // ---------------------------------------------------------------------------
  // Render

  let body: ReactNode;
  if (step === "form") {
    body = (
      <FormStep
        companies={companies}
        accountKey={accountKey}
        onAccountKey={setAccountKey}
        displayName={displayName}
        onDisplayName={setDisplayName}
        clientId={clientId}
        onClientId={setClientId}
        clientSecret={clientSecret}
        onClientSecret={setClientSecret}
        ownerCompanyId={ownerCompanyId}
        onOwnerCompany={setOwnerCompanyId}
        allowedCompanyIds={allowedCompanyIds}
        onToggleAllowed={toggleAllowed}
        scopesText={scopesText}
        onScopesText={setScopesText}
        setAsDefault={setAsDefault}
        onSetAsDefault={setSetAsDefault}
        onSubmit={handleStart}
        starting={starting}
      />
    );
  } else if (step === "authorizing" && flow) {
    body = <ConsentStep flow={flow} pollMessage={pollMessage} onCancel={startOver}
      callbackUrl={callbackUrl} onCallbackUrl={setCallbackUrl} onSubmitCallback={handleCallback} submitting={submitting} />;
  } else if (step === "creating") {
    body = (
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Creating secrets in {ownerNameFor(consentInput!.ownerCompanyId)} and registering the account…
        </div>
        <div style={subtle}>
          Authenticated as <code>{resolvedUser?.email ?? "(email unknown)"}</code>.
        </div>
      </div>
    );
  } else if (step === "done" && createdSecretIds && createdSecretNames) {
    body = (
      <DoneStep
        accountKey={consentInput!.accountKey}
        userEmail={resolvedUser?.email}
        ownerCompanyName={ownerNameFor(consentInput!.ownerCompanyId)}
        allowedNames={consentInput!.allowedCompanies.map(ownerNameFor)}
        secretIds={createdSecretIds}
        names={createdSecretNames}
        onAddAnother={startOver}
      />
    );
  }

  return (
    <div style={{ ...stack, padding: "24px", maxWidth: 720 }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 22 }}>Connect a Google account</h1>
        <p style={{ ...subtle, marginTop: 6 }}>
          Adds an account to the <code>google-workspace</code> plugin. The wizard creates the
          OAuth secrets for you, opens Google's Desktop app consent, and updates the
          plugin config - no terminal required.
        </p>
      </header>

      {error && (
        <div style={errorBox}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form step

interface FormStepProps {
  starting: boolean;
  companies: CompanyRecord[] | null;
  accountKey: string;
  onAccountKey: (s: string) => void;
  displayName: string;
  onDisplayName: (s: string) => void;
  clientId: string;
  onClientId: (s: string) => void;
  clientSecret: string;
  onClientSecret: (s: string) => void;
  ownerCompanyId: string;
  onOwnerCompany: (s: string) => void;
  allowedCompanyIds: Set<string>;
  onToggleAllowed: (id: string) => void;
  scopesText: string;
  onScopesText: (s: string) => void;
  setAsDefault: boolean;
  onSetAsDefault: (b: boolean) => void;
  onSubmit: () => void;
}

function FormStep(p: FormStepProps) {
  const companiesById = useMemo(() => {
    const m = new Map<string, CompanyRecord>();
    for (const c of p.companies ?? []) m.set(c.id, c);
    return m;
  }, [p.companies]);

  return (
    <div style={card}>
      <h2 style={{ margin: "0 0 4px 0", fontSize: 16 }}>Step 1 - Tell the plugin about the account</h2>
      <p style={subtle}>
        First, create an OAuth 2.0 Client of type <strong>"Desktop app"</strong> in
        Google Cloud Console (Credentials → Create credentials). Enable the Calendar / Tasks /
        Docs / Sheets / Drive APIs in that project. Paste the client ID/secret below.
      </p>

      <div style={{ ...stack, marginTop: 14 }}>
        <FormRow label="Account identifier (lowercase, hyphens - e.g. personal, acme-print)">
          <input
            style={input}
            value={p.accountKey}
            onChange={(e) => p.onAccountKey(e.target.value)}
            placeholder="personal"
          />
        </FormRow>
        <FormRow label="Display name (optional, free-form)">
          <input
            style={input}
            value={p.displayName}
            onChange={(e) => p.onDisplayName(e.target.value)}
            placeholder="Personal Google"
          />
        </FormRow>
        <FormRow label="Client ID (from Google Cloud Console)">
          <input
            style={input}
            value={p.clientId}
            onChange={(e) => p.onClientId(e.target.value)}
            placeholder="123456789-abc...apps.googleusercontent.com"
          />
        </FormRow>
        <FormRow label="Client secret">
          <input
            style={input}
            type="password"
            value={p.clientSecret}
            onChange={(e) => p.onClientSecret(e.target.value)}
            placeholder="GOCSPX-..."
          />
        </FormRow>
        <FormRow label="Company that owns the secrets (where the 3 secrets get stored)">
          <select
            style={input}
            value={p.ownerCompanyId}
            onChange={(e) => p.onOwnerCompany(e.target.value)}
            disabled={!p.companies}
          >
            <option value="" disabled>
              {p.companies ? "Pick a company…" : "Loading companies…"}
            </option>
            {(p.companies ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </FormRow>
        <FormRow label="Allowed companies (which companies can use this account)">
          <div style={{ ...stack, gap: 6 }}>
            {!p.companies && <div style={subtle}>Loading…</div>}
            {p.companies?.map((c) => (
              <label key={c.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={p.allowedCompanyIds.has(c.id)}
                  onChange={() => p.onToggleAllowed(c.id)}
                />
                <span>{c.name}</span>
              </label>
            ))}
            <div style={{ ...subtle, marginTop: 4 }}>
              Tip: a personal Google account is usually allowed for one company only (e.g. just
              Personal). A shared business inbox should be restricted to that LLC's company.
              {companiesById.size > 0 && p.allowedCompanyIds.size === 0 && " - pick at least one."}
            </div>
          </div>
        </FormRow>
        <FormRow label="OAuth scopes (optional override - leave blank for defaults)">
          <input
            style={input}
            value={p.scopesText}
            onChange={(e) => p.onScopesText(e.target.value)}
            placeholder="https://www.googleapis.com/auth/calendar https://..."
          />
          <div style={{ ...subtle, marginTop: 4 }}>
            Defaults: calendar, tasks, spreadsheets, drive (full), userinfo.email,
            userinfo.profile. The granted scopes are baked into the refresh token, so changing
            them later means re-running this wizard.
          </div>
        </FormRow>
        <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
          <input
            type="checkbox"
            checked={p.setAsDefault}
            onChange={(e) => p.onSetAsDefault(e.target.checked)}
          />
          <span>Set as the plugin's default account (agents can omit the <code>account</code> param)</span>
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button style={primary} onClick={p.onSubmit} disabled={!p.companies || p.starting}>
            {p.starting ? "Starting consent…" : "Connect Google account"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FormRow({ label: text, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={label}>{text}</div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Desktop app consent step

function ConsentStep({ flow, pollMessage, onCancel, callbackUrl, onCallbackUrl, onSubmitCallback, submitting }: {
  flow: LoopbackFlowStart;
  pollMessage: string;
  onCancel: () => void;
  callbackUrl: string;
  onCallbackUrl: (value: string) => void;
  onSubmitCallback: () => void;
  submitting: boolean;
}) {
  return (
    <div style={card}>
      <h2 style={{ margin: "0 0 4px 0", fontSize: 16 }}>Step 2 - Grant access on Google</h2>
      <p style={subtle}>
        Open Google consent and sign in as the account you want to connect. Keep this page open.
        This session expires after ten minutes.
      </p>
      <div style={{ ...stack, marginTop: 14 }}>
        <a href={flow.authorizationUrl} target="_blank" rel="noreferrer" style={{ ...primary, textDecoration: "none", width: "fit-content" }}>
          Open Google consent
        </a>
        <p style={subtle}>
          If your browser runs on a different computer from the Paperclip worker, or the worker
          runs in Docker, Google's final page may say the local address cannot be reached.
          Copy that page's complete URL from the address bar and paste it below. It starts with
          <code> http://127.0.0.1:</code> and contains a temporary code. Keep it private.
        </p>
        <FormRow label="Callback URL (only if the final Google redirect cannot be reached)">
          <input style={input} type="password" autoComplete="off" spellCheck={false} value={callbackUrl}
            onChange={e => onCallbackUrl(e.target.value)} placeholder="http://127.0.0.1:.../oauth/callback?code=...&state=..." />
        </FormRow>
        <button style={button} disabled={!callbackUrl.trim() || submitting} onClick={onSubmitCallback}>
          {submitting ? "Checking callback..." : "Complete with pasted callback URL"}
        </button>
        <div style={subtle}>{pollMessage}</div>
        <button style={button} onClick={onCancel}>Cancel and start over</button>
      </div>
    </div>
  );
}

// Disabled device consent UI preserved as an undo path with the worker implementation.
/*
// Device-flow step

function DeviceStep({
  device,
  pollMessage,
  onCancel,
}: {
  device: DeviceFlowStart;
  pollMessage: string;
  onCancel: () => void;
}) {
  const [copied, setCopied] = useState<"code" | "url" | null>(null);
  function copy(text: string, which: "code" | "url"): void {
    void navigator.clipboard.writeText(text).then(() => setCopied(which));
    setTimeout(() => setCopied(null), 1500);
  }
  return (
    <div style={card}>
      <h2 style={{ margin: "0 0 4px 0", fontSize: 16 }}>Step 2 - Grant access on Google</h2>
      <p style={subtle}>
        Open the verification URL on any device (this browser, your phone, doesn't matter) and
        enter the code below. Sign in as the Google account you want this Paperclip account to
        act as.
      </p>

      <div style={{ ...stack, marginTop: 14 }}>
        <div>
          <div style={label}>Verification URL</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <a
              href={device.verificationUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit", textDecoration: "underline" }}
            >
              {device.verificationUrl}
            </a>
            <button style={button} onClick={() => copy(device.verificationUrl, "url")}>
              {copied === "url" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div>
          <div style={label}>Enter this code</div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span style={codeBlock}>{device.userCode}</span>
            <button style={button} onClick={() => copy(device.userCode, "code")}>
              {copied === "code" ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div style={{ ...subtle, paddingTop: 8 }}>{pollMessage}</div>

        <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
          <button style={button} onClick={onCancel}>
            Cancel and start over
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
*/

// ---------------------------------------------------------------------------
// Done step

function DoneStep({
  accountKey,
  userEmail,
  ownerCompanyName,
  allowedNames,
  secretIds,
  names,
  onAddAnother,
}: {
  accountKey: string;
  userEmail: string | null | undefined;
  ownerCompanyName: string;
  allowedNames: string[];
  secretIds: { clientIdRef: string; clientSecretRef: string; refreshTokenRef: string };
  names: ReturnType<typeof googleSecretNames>;
  onAddAnother: () => void;
}) {
  return (
    <div style={successBox}>
      <h2 style={{ margin: "0 0 4px 0", fontSize: 16 }}>Done</h2>
      <p style={subtle}>
        Account <code>{accountKey}</code> is wired up
        {userEmail ? (
          <>
            {" "}as <code>{userEmail}</code>
          </>
        ) : null}
        . Three secrets were created in <strong>{ownerCompanyName}</strong>; the account is allowed
        for: {allowedNames.join(", ") || "(none)"}.
      </p>

      <div style={{ ...stack, marginTop: 12 }}>
        <div>
          <div style={label}>Created secrets</div>
          <ul style={{ ...subtle, margin: 0, paddingLeft: 18 }}>
            <li>
              <code>{names.clientId}</code> - {secretIds.clientIdRef}
            </li>
            <li>
              <code>{names.clientSecret}</code> - {secretIds.clientSecretRef}
            </li>
            <li>
              <code>{names.refreshToken}</code> - {secretIds.refreshTokenRef}
            </li>
          </ul>
        </div>

        <div style={subtle}>
          Next: open <code>/instance/settings/plugins/google-workspace</code> to verify the account
          appears, and flip the <strong>"Allow create/update/delete tools"</strong> master switch
          on if you want mutation tools active. The read-only tools (list events, list tasks, etc.)
          work immediately.
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button style={primary} onClick={onAddAnother}>
            Add another account
          </button>
          <a
            href="/instance/settings/plugins/google-workspace"
            style={{ ...button, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
          >
            Open plugin settings
          </a>
        </div>
      </div>
    </div>
  );
}

export default SetupAccountPage;
