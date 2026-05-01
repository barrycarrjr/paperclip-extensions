import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
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

interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
  scopes: string[];
}

interface PollResultPending {
  status: "pending";
  slowDown?: boolean;
}
interface PollResultGranted {
  status: "granted";
  refreshToken: string;
  accessToken?: string;
  expiresIn?: number;
  scope?: string;
}
interface PollResultDeniedOrExpired {
  status: "denied" | "expired";
}
type PollResult = PollResultPending | PollResultGranted | PollResultDeniedOrExpired;

interface UserInfo {
  email: string | null;
  name: string | null;
  verified: boolean | null;
}

interface PluginAccount {
  key?: string;
  displayName?: string;
  userEmail?: string;
  clientIdRef?: string;
  clientSecretRef?: string;
  refreshTokenRef?: string;
  scopes?: string[];
  allowedCompanies?: string[];
}

interface PluginConfig {
  allowMutations?: boolean;
  defaultAccount?: string;
  accounts?: PluginAccount[];
}

type WizardStep = "form" | "device" | "creating" | "done";

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
      throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const msg = (body && typeof body === "object" && "error" in body && typeof (body as Record<string, unknown>).error === "string")
      ? (body as { error: string }).error
      : `HTTP ${res.status}`;
    throw new Error(msg);
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

  const startDeviceFlow = usePluginAction("oauth_start_device_flow");
  const pollDeviceFlow = usePluginAction("oauth_poll_device_flow");
  const lookupUser = usePluginAction("oauth_lookup_user");

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

  // Device-flow state
  const [device, setDevice] = useState<DeviceFlowStart | null>(null);
  const [pollMessage, setPollMessage] = useState<string>("Waiting for you to grant access on Google…");
  const [resolvedRefreshToken, setResolvedRefreshToken] = useState<string | null>(null);
  const [resolvedUser, setResolvedUser] = useState<UserInfo | null>(null);

  // Done state
  const [createdSecretIds, setCreatedSecretIds] = useState<{
    clientIdRef: string;
    clientSecretRef: string;
    refreshTokenRef: string;
  } | null>(null);

  useEffect(() => {
    listCompanies().then(setCompanies).catch((err) => setError(getErrorMessage(err)));
  }, []);

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
  // Step 1: validate form, start device flow

  async function handleStart(): Promise<void> {
    setError(null);
    if (!accountKey.trim()) return setError("Account identifier is required.");
    if (!/^[a-z0-9-]+$/.test(accountKey.trim()))
      return setError("Account identifier must be lowercase letters, digits, and hyphens only.");
    if (!clientId.trim()) return setError("Client ID is required.");
    if (!clientSecret.trim()) return setError("Client Secret is required.");
    if (!ownerCompanyId) return setError("Pick a company to own the secrets.");
    if (allowedCompanyIds.size === 0)
      return setError("Pick at least one company to allow under Allowed Companies.");

    const scopes = scopesText
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    setStep("device");
    setPollMessage("Requesting device code from Google…");

    let started: DeviceFlowStart;
    try {
      started = (await startDeviceFlow({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        scopes: scopes.length > 0 ? scopes : undefined,
      })) as DeviceFlowStart;
    } catch (err) {
      setError(getErrorMessage(err));
      setStep("form");
      return;
    }
    setDevice(started);
    setPollMessage("Waiting for you to grant access on Google…");
  }

  // ---------------------------------------------------------------------------
  // Step 2: poll the device-flow until granted/denied/expired

  useEffect(() => {
    if (step !== "device" || !device) return;

    let cancelled = false;
    let intervalMs = device.interval * 1000;
    const startedAt = Date.now();
    const expiresAtMs = startedAt + device.expiresIn * 1000;

    async function tick(): Promise<void> {
      if (cancelled) return;
      if (Date.now() > expiresAtMs) {
        setError("Device code expired. Click 'Start over' to retry.");
        setStep("form");
        setDevice(null);
        return;
      }
      try {
        const r = (await pollDeviceFlow({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
          deviceCode: device!.deviceCode,
        })) as PollResult;
        if (cancelled) return;
        if (r.status === "pending") {
          if (r.slowDown) intervalMs = Math.min(intervalMs * 2, 30000);
          setPollMessage("Still waiting on Google…");
          setTimeout(tick, intervalMs);
          return;
        }
        if (r.status === "denied") {
          setError("You denied access on Google's consent screen. Click 'Start over' to retry.");
          setStep("form");
          setDevice(null);
          return;
        }
        if (r.status === "expired") {
          setError("Device code expired before you granted access. Click 'Start over' to retry.");
          setStep("form");
          setDevice(null);
          return;
        }
        if (r.status !== "granted") return;
        const refreshToken = r.refreshToken;
        setResolvedRefreshToken(refreshToken);
        setPollMessage("Got the refresh token — looking up account email…");
        try {
          const info = (await lookupUser({
            clientId: clientId.trim(),
            clientSecret: clientSecret.trim(),
            refreshToken,
          })) as UserInfo;
          setResolvedUser(info);
        } catch {
          setResolvedUser({ email: null, name: null, verified: null });
        }
        setStep("creating");
      } catch (err) {
        if (cancelled) return;
        setError(getErrorMessage(err));
        setStep("form");
        setDevice(null);
      }
    }

    void tick();
    return () => {
      cancelled = true;
    };
  }, [step, device, clientId, clientSecret, pollDeviceFlow, lookupUser]);

  // ---------------------------------------------------------------------------
  // Step 3: create the 3 secrets, update plugin config

  useEffect(() => {
    if (step !== "creating" || !resolvedRefreshToken) return;

    let cancelled = false;
    (async () => {
      try {
        const namePrefix = `google-${accountKey.trim()}`;
        const cidSecret = await createSecret(
          ownerCompanyId,
          `${namePrefix}-client-id`,
          clientId.trim(),
          `Google OAuth client ID for ${accountKey.trim()}`,
        );
        if (cancelled) return;
        const csSecret = await createSecret(
          ownerCompanyId,
          `${namePrefix}-client-secret`,
          clientSecret.trim(),
          `Google OAuth client secret for ${accountKey.trim()}`,
        );
        if (cancelled) return;
        const rtSecret = await createSecret(
          ownerCompanyId,
          `${namePrefix}-refresh-token`,
          resolvedRefreshToken,
          `Google OAuth refresh token for ${accountKey.trim()}`,
        );
        if (cancelled) return;

        const existing = await readPluginConfig("google-workspace");
        const existingAccounts = existing.accounts ?? [];
        const filtered = existingAccounts.filter(
          (a) => (a.key ?? "").toLowerCase() !== accountKey.trim().toLowerCase(),
        );
        const scopes = scopesText
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const newAccount: PluginAccount = {
          key: accountKey.trim(),
          displayName: displayName.trim() || undefined,
          userEmail: resolvedUser?.email ?? undefined,
          clientIdRef: cidSecret.id,
          clientSecretRef: csSecret.id,
          refreshTokenRef: rtSecret.id,
          scopes: scopes.length > 0 ? scopes : undefined,
          allowedCompanies: Array.from(allowedCompanyIds),
        };

        const nextConfig: PluginConfig = {
          allowMutations: existing.allowMutations ?? false,
          defaultAccount: setAsDefault ? accountKey.trim() : existing.defaultAccount,
          accounts: [...filtered, newAccount],
        };
        await writePluginConfig("google-workspace", nextConfig);

        if (cancelled) return;
        setCreatedSecretIds({
          clientIdRef: cidSecret.id,
          clientSecretRef: csSecret.id,
          refreshTokenRef: rtSecret.id,
        });
        setStep("done");
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
    accountKey,
    displayName,
    clientId,
    clientSecret,
    ownerCompanyId,
    allowedCompanyIds,
    scopesText,
    setAsDefault,
    resolvedUser,
  ]);

  // ---------------------------------------------------------------------------
  // Render helpers

  function startOver(): void {
    setStep("form");
    setError(null);
    setDevice(null);
    setResolvedRefreshToken(null);
    setResolvedUser(null);
    setCreatedSecretIds(null);
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
      />
    );
  } else if (step === "device" && device) {
    body = <DeviceStep device={device} pollMessage={pollMessage} onCancel={startOver} />;
  } else if (step === "creating") {
    body = (
      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>
          Creating secrets in {ownerNameFor(ownerCompanyId)} and registering the account…
        </div>
        <div style={subtle}>
          Authenticated as <code>{resolvedUser?.email ?? "(email unknown)"}</code>.
        </div>
      </div>
    );
  } else if (step === "done" && createdSecretIds) {
    body = (
      <DoneStep
        accountKey={accountKey.trim()}
        userEmail={resolvedUser?.email}
        ownerCompanyName={ownerNameFor(ownerCompanyId)}
        allowedNames={Array.from(allowedCompanyIds).map(ownerNameFor)}
        secretIds={createdSecretIds}
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
          OAuth secrets for you, runs the device-flow consent on Google's side, and updates the
          plugin config — no terminal required.
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
      <h2 style={{ margin: "0 0 4px 0", fontSize: 16 }}>Step 1 — Tell the plugin about the account</h2>
      <p style={subtle}>
        First, create an OAuth 2.0 Client of type <strong>"TVs and Limited Input devices"</strong> in
        Google Cloud Console (Credentials → Create credentials). Enable the Calendar / Tasks /
        Sheets / Drive APIs in that project. Paste the client ID/secret below.
      </p>

      <div style={{ ...stack, marginTop: 14 }}>
        <FormRow label="Account identifier (lowercase, hyphens — e.g. barry-personal)">
          <input
            style={input}
            value={p.accountKey}
            onChange={(e) => p.onAccountKey(e.target.value)}
            placeholder="barry-personal"
          />
        </FormRow>
        <FormRow label="Display name (optional, free-form)">
          <input
            style={input}
            value={p.displayName}
            onChange={(e) => p.onDisplayName(e.target.value)}
            placeholder="Barry — personal Google"
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
              Personal). A shared M3 Printing inbox should be restricted to M3 Media.
              {companiesById.size > 0 && p.allowedCompanyIds.size === 0 && " — pick at least one."}
            </div>
          </div>
        </FormRow>
        <FormRow label="OAuth scopes (optional override — leave blank for defaults)">
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
          <button style={primary} onClick={p.onSubmit} disabled={!p.companies}>
            Connect Google account
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
      <h2 style={{ margin: "0 0 4px 0", fontSize: 16 }}>Step 2 — Grant access on Google</h2>
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
// Done step

function DoneStep({
  accountKey,
  userEmail,
  ownerCompanyName,
  allowedNames,
  secretIds,
  onAddAnother,
}: {
  accountKey: string;
  userEmail: string | null | undefined;
  ownerCompanyName: string;
  allowedNames: string[];
  secretIds: { clientIdRef: string; clientSecretRef: string; refreshTokenRef: string };
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
              <code>google-{accountKey}-client-id</code> — {secretIds.clientIdRef}
            </li>
            <li>
              <code>google-{accountKey}-client-secret</code> — {secretIds.clientSecretRef}
            </li>
            <li>
              <code>google-{accountKey}-refresh-token</code> — {secretIds.refreshTokenRef}
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
