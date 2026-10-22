/**
 * The Google connection screen.
 *
 * Three jobs, in the order somebody actually needs them:
 *
 *  1. Say whether the Google account connected to this plugin works right
 *     now, by asking Google rather than by reading the settings. A refresh
 *     token minted for a different product authenticates perfectly and can
 *     read nothing, and that is exactly how this plugin spent two weeks.
 *  2. Connect or reconnect an account, with the permissions this plugin
 *     needs, without a terminal. The three secrets it creates belong to this
 *     plugin alone, so reconnecting one plugin can never log the other out.
 *  3. Find the Google account id and location id by listing them, instead of
 *     copying numbers out of a browser address bar into two fields where the
 *     same wrong number looks perfectly plausible in both.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useHostContext, usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { defaultMintKey } from "./editorState.js";
import { describeReplyError } from "./replyErrors.js";
import {
  ErrorNote,
  Note,
  cardStyle,
  css,
  disabledStyle,
  linkButton,
  mutedText,
  primaryButton,
  secondaryButton,
} from "./shared.js";

const PLUGIN_KEY = "review-tools";
const BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage";

interface ConnectionAccount {
  key: string;
  displayName: string;
  userEmail: string | null;
  gmailPolling: boolean;
  ok: boolean;
  error: string | null;
  accounts: Array<{ accountId: string; accountName: string; type: string }>;
}

interface ConnectionLocation {
  key: string;
  displayName: string;
  accountKey: string;
  googleAccountId: string;
  locationId: string;
  targetCompanyId: string;
  looksMisconfigured: boolean;
}

interface ConnectionData {
  accounts: ConnectionAccount[];
  locations: ConnectionLocation[];
  allowReplies: boolean;
  gmailScope: string;
}

interface GoogleLocation {
  locationId: string;
  title: string;
  storeCode?: string;
}

interface StartedFlow {
  sessionId: string;
  authorizationUrl: string;
  expiresIn: number;
  scopes: string[];
}

interface PollResult {
  status: "pending" | "granted" | "denied" | "failed" | "expired";
  refreshToken?: string;
  grantedScopes?: string[];
  missingScopes?: string[];
  scopeSummary?: string;
  user?: { email: string | null; name: string | null };
  error?: string;
}

// ---------------------------------------------------------------------------
// Host API helpers. These are ordinary browser calls to Paperclip's own API,
// the same path the google-workspace setup page uses; the host checks the
// caller is allowed to write plugin config and company secrets.

async function hostJson<T>(url: string, init?: RequestInit): Promise<T> {
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
      throw new Error(`Paperclip returned something that was not JSON (${url}).`);
    }
  }
  if (!res.ok) {
    const message = (body as { error?: string } | null)?.error;
    throw new Error(
      message
        ? `Paperclip refused the request: ${message}`
        : `Paperclip refused the request (HTTP ${res.status}). You may not have permission to change plugin settings.`,
    );
  }
  return body as T;
}

async function readPluginConfig(): Promise<Record<string, unknown>> {
  const res = await fetch(`/api/plugins/${PLUGIN_KEY}/config`, { credentials: "include" });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Could not read the plugin settings (HTTP ${res.status}).`);
  const body = (await res.json()) as { configJson?: Record<string, unknown> };
  return body.configJson ?? {};
}

async function writePluginConfig(configJson: Record<string, unknown>): Promise<void> {
  await hostJson(`/api/plugins/${PLUGIN_KEY}/config`, {
    method: "POST",
    body: JSON.stringify({ configJson }),
  });
}

async function createSecret(companyId: string, name: string, value: string, description: string): Promise<{ id: string }> {
  return await hostJson(`/api/companies/${companyId}/secrets`, {
    method: "POST",
    body: JSON.stringify({ name, value, description }),
  });
}

/**
 * Secret names that cannot collide with another plugin's.
 *
 * The live instance had review-tools and google-workspace pointed at one set
 * of secrets called `gbp_client_id` and friends. Reconnecting either plugin
 * overwrote the other's credentials, which is how a Calendar token ended up
 * being used to read reviews. A per-plugin, per-account, non-reused name
 * makes that impossible rather than merely discouraged.
 */
export function reviewSecretNames(accountKey: string, taken: string[], suffix: string) {
  const base = `review_tools_${accountKey.replace(/[^a-zA-Z0-9]+/g, "_").toLowerCase()}`;
  const used = new Set(taken);
  const pick = (part: string) => {
    const plain = `${base}_${part}`;
    return used.has(plain) ? `${plain}_${suffix}` : plain;
  };
  return { clientId: pick("client_id"), clientSecret: pick("client_secret"), refreshToken: pick("refresh_token") };
}

// ---------------------------------------------------------------------------

export function GoogleSetupPage(_props: PluginPageProps) {
  const host = useHostContext();
  const connection = usePluginData<ConnectionData>("google-connection", { companyId: host.companyId });
  // The account whose Reconnect button was pressed, or null for a new one.
  const [reconnect, setReconnect] = useState<ReconnectTarget | null>(null);

  if (!host.companyId) {
    return (
      <div style={pageRoot}>
        <p style={mutedText}>Open this page inside a company to set up the Google connection.</p>
      </div>
    );
  }

  return (
    <div style={pageRoot}>
      <div>
        <h1 style={{ margin: "0 0 4px", fontSize: 22 }}>Google connection</h1>
        <p style={{ ...mutedText, margin: 0 }}>
          Connect the Google account that owns your business listings, then pick which locations to watch.
        </p>
      </div>

      <ConnectionStatus
        connection={connection}
        onReconnect={(target) => {
          setReconnect(target);
          document.getElementById("review-tools-connect")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }}
      />
      <ConnectAccount
        // Keyed so switching between "new account" and "reconnect X" starts
        // the form fresh rather than carrying half-typed state across.
        key={reconnect?.key ?? "new"}
        companyId={host.companyId}
        reconnect={reconnect}
        onCancelReconnect={() => setReconnect(null)}
        onDone={() => {
          setReconnect(null);
          connection.refresh();
        }}
      />
      <LocationPicker
        companyId={host.companyId}
        connection={connection.data ?? null}
        onDone={() => connection.refresh()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. What works right now

interface ReconnectTarget {
  key: string;
  displayName: string;
  gmailPolling: boolean;
}

function ConnectionStatus({
  connection,
  onReconnect,
}: {
  connection: ReturnType<typeof usePluginData<ConnectionData>>;
  onReconnect: (target: ReconnectTarget) => void;
}) {
  const { data, loading, error, refresh } = connection;

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <h2 style={sectionHeading}>Current connection</h2>
        <button type="button" onClick={() => refresh()} style={{ ...linkButton, marginLeft: "auto" }}>
          Check again
        </button>
      </div>

      {loading && !data && <p style={mutedText}>Asking Google what this account can see...</p>}
      {error && !data && <ErrorNote>{describeReplyError(error)}</ErrorNote>}

      {data && data.accounts.length === 0 && (
        <Note>No Google account is connected yet. Use the box below to connect one.</Note>
      )}

      {data?.accounts.map((account) => (
        <div key={account.key} style={{ ...innerCard, border: account.ok ? css.border : `1px solid ${WARN_BORDER}` }}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong>{account.displayName}</strong>
            <span style={mutedText}>{account.userEmail ?? "no email recorded"}</span>
            <span style={{ ...badge, ...(account.ok ? badgeOk : badgeBad), marginLeft: "auto" }}>
              {account.ok ? "Working" : "Not working"}
            </span>
            <button
              type="button"
              style={account.ok ? secondaryButton : primaryButton}
              onClick={() => onReconnect({ key: account.key, displayName: account.displayName, gmailPolling: account.gmailPolling })}
            >
              Reconnect
            </button>
          </div>

          {account.ok && (
            <p style={{ margin: "8px 0 0", fontSize: 14 }}>
              {account.accounts.length === 0
                ? "Google accepted the sign-in but this account manages no business listings. Connect the Google account that owns the listing."
                : `Google listings this account can manage: ${account.accounts
                    .map((a) => `${a.accountName} (${a.accountId})`)
                    .join(", ")}.`}
            </p>
          )}

          {!account.ok && account.error && (
            <div style={{ marginTop: 8 }}>
              <ErrorNote>{describeReplyError(account.error)}</ErrorNote>
            </div>
          )}

          <p style={{ ...mutedText, margin: "8px 0 0" }}>
            {account.gmailPolling
              ? "Review notification emails are polled with this account."
              : "Not used for review notification emails."}
          </p>
        </div>
      ))}

      {data && data.locations.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ ...sectionHeading, fontSize: 14 }}>Configured locations</h3>
          {data.locations.map((loc) => (
            <div key={loc.key} style={innerCard}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <strong>{loc.displayName}</strong>
                <span style={mutedText}>
                  account {loc.googleAccountId}, location {loc.locationId}
                </span>
              </div>
              {loc.looksMisconfigured && (
                <div style={{ marginTop: 8 }}>
                  <ErrorNote>
                    The Google account id and the location id are the same number, which cannot be right. Every call for
                    this location will fail. Pick the location again below to fix both fields.
                  </ErrorNote>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {data && !data.allowReplies && (
        <div style={{ marginTop: 12 }}>
          <Note>
            Posting replies is switched off, so the plugin will suggest replies but never publish one. Turn on &quot;Allow
            posting review replies&quot; in the plugin settings when you want to publish from here.
          </Note>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. Connect or reconnect

type ConnectStep = "form" | "authorizing" | "saving" | "done";

function ConnectAccount({
  companyId,
  reconnect,
  onCancelReconnect,
  onDone,
}: {
  companyId: string;
  reconnect: ReconnectTarget | null;
  onCancelReconnect: () => void;
  onDone: () => void;
}) {
  const start = usePluginAction("google_connect_start");
  const poll = usePluginAction("google_connect_poll");
  const submitCallback = usePluginAction("google_connect_submit_callback");
  const cancel = usePluginAction("google_connect_cancel");

  const [step, setStep] = useState<ConnectStep>("form");
  // A name is filled in from the start so the button works first time. The
  // first version left it blank behind a grey example, which read as filled
  // in, and the only visible result of pressing Connect was a complaint.
  const [accountKey, setAccountKey] = useState(reconnect?.key ?? "google-reviews");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [includeGmail, setIncludeGmail] = useState(reconnect ? reconnect.gmailPolling : true);
  const [flow, setFlow] = useState<StartedFlow | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept out of state so a re-render never puts the token in a React tree
  // that something else could read; cleared the moment it is stored.
  const grant = useRef<{ refreshToken: string; email: string | null } | null>(null);
  const live = useRef<string | null>(null);

  const keyLooksValid = /^[a-z0-9][a-z0-9-]{1,38}$/.test(accountKey);

  const reset = useCallback(() => {
    grant.current = null;
    live.current = null;
    setFlow(null);
    setCallbackUrl("");
    setClientSecret("");
    setBusy(false);
  }, []);

  async function beginConsent() {
    setError(null);
    setWarning(null);
    setSummary(null);
    if (!reconnect) {
      if (!keyLooksValid) {
        setError("Give the account a short name: lower-case letters, numbers and hyphens, at least two characters.");
        return;
      }
      if (!clientId.trim() || !clientSecret.trim()) {
        setError("Paste the OAuth client ID and client secret from the Google Cloud console.");
        return;
      }
    }
    setBusy(true);
    try {
      // Reconnecting names the account and lets the worker read its stored
      // client id and secret; a new account sends them from the form.
      const started = (await start(
        reconnect
          ? { companyId, accountKey: reconnect.key, includeGmail }
          : { clientId: clientId.trim(), clientSecret: clientSecret.trim(), includeGmail },
      )) as StartedFlow;
      live.current = started.sessionId;
      setFlow(started);
      setStep("authorizing");
      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(describeReplyError(err));
    } finally {
      setBusy(false);
    }
  }

  // Poll the worker until Google answers, or the attempt expires.
  useEffect(() => {
    if (step !== "authorizing" || !flow) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const expiresAtMs = Date.now() + flow.expiresIn * 1000;

    async function tick(): Promise<void> {
      if (cancelled) return;
      if (Date.now() > expiresAtMs) {
        void cancel({ sessionId: flow!.sessionId }).catch(() => {});
        reset();
        setError("The connection attempt timed out. Start again.");
        setStep("form");
        return;
      }
      try {
        const result = (await poll({ sessionId: flow!.sessionId })) as PollResult;
        if (cancelled) return;
        if (result.status === "pending") {
          timer = setTimeout(tick, 1500);
          return;
        }
        if (result.status === "granted" && result.refreshToken) {
          grant.current = { refreshToken: result.refreshToken, email: result.user?.email ?? null };
          setSummary(result.scopeSummary ?? null);
          if ((result.missingScopes ?? []).includes(BUSINESS_SCOPE)) {
            // Saving this would reproduce the original outage exactly.
            reset();
            setError(
              "Google did not grant permission to manage business listings, so this account cannot read or reply to reviews. Nothing was saved. Connect again and leave every permission ticked.",
            );
            setStep("form");
            return;
          }
          if (includeGmail && !(result.grantedScopes ?? []).some((s) => s.endsWith("gmail.readonly"))) {
            setWarning(
              "Gmail access was not granted, so review notification emails will not be polled. Reviews will still be pulled in by the daily sync.",
            );
          }
          setStep("saving");
          return;
        }
        reset();
        setError(
          result.status === "denied"
            ? "You declined the permissions on Google's screen. Nothing was changed."
            : describeReplyError(result.error ?? "The connection attempt did not finish."),
        );
        setStep("form");
      } catch (err) {
        if (cancelled) return;
        reset();
        setError(describeReplyError(err));
        setStep("form");
      }
    }

    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, flow, poll, cancel, reset, includeGmail]);

  // Store the credentials and register the account.
  useEffect(() => {
    if (step !== "saving" || !grant.current) return;
    let cancelled = false;
    const held = grant.current;
    const key = accountKey.trim();
    const id = clientId.trim();
    const secret = clientSecret.trim();

    (async () => {
      try {
        const existing = await hostJson<Array<{ name: string }>>(`/api/companies/${companyId}/secrets`);
        if (cancelled) return;
        // Derived from the same helper the reply editor uses, so this cannot
        // repeat the secure-context trap that stopped Post working over
        // plain http. The suffix only has to make a secret name unique.
        const suffix = defaultMintKey().replace(/-/g, "").slice(0, 8);
        const names = reviewSecretNames(key, existing.map((s) => s.name), suffix);

        const rt = await createSecret(companyId, names.refreshToken, held.refreshToken, `Review Tools refresh token for ${key}`);
        if (cancelled) return;

        const config = await readPluginConfig();
        const accounts = Array.isArray(config.accounts) ? [...(config.accounts as Array<Record<string, unknown>>)] : [];

        if (reconnect) {
          // Only the token changes. The client id and secret the account
          // already references stay, and so does everything else about it.
          const at = accounts.findIndex((a) => String(a.key).toLowerCase() === key.toLowerCase());
          if (at < 0) throw new Error(`The account "${key}" is no longer in the plugin settings. Connect it as a new account.`);
          accounts[at] = {
            ...accounts[at],
            refreshTokenRef: rt.id,
            ...(held.email ? { userEmail: held.email } : {}),
          };
          const updated: Record<string, unknown> = { ...config, accounts };
          if (includeGmail && !updated.gmailAccountKey) updated.gmailAccountKey = key;
          await writePluginConfig(updated);
          if (cancelled) return;
          reset();
          setStep("done");
          onDone();
          return;
        }

        const cid = await createSecret(companyId, names.clientId, id, `Review Tools OAuth client ID for ${key}`);
        if (cancelled) return;
        const cs = await createSecret(companyId, names.clientSecret, secret, `Review Tools OAuth client secret for ${key}`);
        if (cancelled) return;
        const next = {
          key,
          displayName: held.email ? `${held.email} (reviews)` : key,
          userEmail: held.email ?? undefined,
          clientIdRef: cid.id,
          clientSecretRef: cs.id,
          refreshTokenRef: rt.id,
          // The company doing the connecting is allowed by default. Anything
          // wider is a deliberate edit on the settings page: an empty list
          // denies, and that is the behaviour we want to keep.
          allowedCompanies: [companyId],
        };
        const at = accounts.findIndex((a) => String(a.key).toLowerCase() === key.toLowerCase());
        if (at >= 0) {
          next.allowedCompanies = Array.from(
            new Set([...(Array.isArray(accounts[at]!.allowedCompanies) ? (accounts[at]!.allowedCompanies as string[]) : []), companyId]),
          );
          accounts[at] = { ...accounts[at], ...next };
        } else {
          accounts.push(next);
        }
        const updated: Record<string, unknown> = { ...config, accounts };
        if (includeGmail && !updated.gmailAccountKey) updated.gmailAccountKey = key;
        await writePluginConfig(updated);
        if (cancelled) return;

        reset();
        setClientId("");
        setStep("done");
        onDone();
      } catch (err) {
        if (cancelled) return;
        reset();
        setError(describeReplyError(err));
        setStep("form");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [step, companyId, accountKey, clientId, clientSecret, includeGmail, onDone, reset, reconnect]);

  return (
    <section id="review-tools-connect" style={cardStyle}>
      <h2 style={sectionHeading}>{reconnect ? `Reconnect ${reconnect.displayName}` : "Connect a Google account"}</h2>

      {step === "done" && (
        <>
          <Note>
            Connected. {summary} The credentials were stored as this plugin&apos;s own secrets, so reconnecting another
            Google plugin will not disturb them.
          </Note>
          {warning && (
            <div style={{ marginTop: 8 }}>
              <Note>{warning}</Note>
            </div>
          )}
          <button type="button" style={{ ...secondaryButton, marginTop: 12 }} onClick={() => setStep("form")}>
            Connect another account
          </button>
        </>
      )}

      {step === "saving" && <p style={mutedText}>Storing the credentials and registering the account...</p>}

      {step === "authorizing" && flow && (
        <>
          <p style={{ fontSize: 14 }}>
            A Google tab should have opened. Grant every permission it asks for, then come back here. This page notices
            by itself.
          </p>
          <p style={mutedText}>
            If no tab opened,{" "}
            <a href={flow.authorizationUrl} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>
              open Google&apos;s consent screen
            </a>
            .
          </p>
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, color: css.muted }}>
              The Google tab could not reach this machine
            </summary>
            <p style={{ ...mutedText, marginTop: 8 }}>
              Copy the whole address Google ended up on, even if the page failed to load, and paste it here. Treat it as
              a password: it is one-use and expires in a few minutes.
            </p>
            <input
              value={callbackUrl}
              onChange={(e) => setCallbackUrl(e.target.value)}
              placeholder="http://127.0.0.1:.../oauth/callback?state=...&code=..."
              style={input}
            />
            <button
              type="button"
              style={disabledStyle(secondaryButton, busy || !callbackUrl.trim())}
              disabled={busy || !callbackUrl.trim()}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await submitCallback({ sessionId: flow.sessionId, callbackUrl: callbackUrl.trim() });
                  setCallbackUrl("");
                } catch (err) {
                  setError(describeReplyError(err));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Use this address
            </button>
          </details>
          <button
            type="button"
            style={{ ...linkButton, marginTop: 12 }}
            onClick={() => {
              void cancel({ sessionId: flow.sessionId }).catch(() => {});
              reset();
              setStep("form");
            }}
          >
            Cancel
          </button>
        </>
      )}

      {step === "form" && reconnect && (
        <>
          <p style={{ fontSize: 14, marginTop: 0 }}>
            Google will ask you to sign in and grant the permissions again. The OAuth client this account already uses
            is kept; only its token is replaced, as a new secret belonging to this plugin.
          </p>
          <label style={{ ...label, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={includeGmail} onChange={(e) => setIncludeGmail(e.target.checked)} />
            Also read review notification emails (Gmail, read-only)
          </label>
          {error && <ErrorNote>{error}</ErrorNote>}
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12 }}>
            <button type="button" style={disabledStyle(primaryButton, busy)} disabled={busy} onClick={beginConsent}>
              {busy ? "Opening Google..." : "Reconnect to Google"}
            </button>
            <button type="button" style={linkButton} onClick={onCancelReconnect}>
              Connect a different account instead
            </button>
          </div>
        </>
      )}

      {step === "form" && !reconnect && (
        <>
          <p style={{ fontSize: 14, marginTop: 0 }}>
            You need an OAuth client from the Google Cloud project that has Business Profile API access. A{" "}
            <strong>Desktop app</strong> client is simplest. A <strong>Web application</strong> client also works if{" "}
            <code>http://127.0.0.1:54321/oauth/callback</code> is on its list of authorised redirect addresses; this page
            checks with Google before opening anything and tells you if it is not. The plugin asks for permission to
            manage your business listings, and optionally to read review notification emails.
          </p>

          <label style={label}>
            Name for this account
            <input
              value={accountKey}
              onChange={(e) => setAccountKey(e.target.value.toLowerCase())}
              placeholder="google-reviews"
              style={input}
            />
          </label>
          <p style={mutedText}>
            Lower-case letters, numbers and hyphens. Reusing an existing name reconnects that account in place.
          </p>

          <label style={label}>
            OAuth client ID
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="....apps.googleusercontent.com" style={input} />
          </label>

          <label style={label}>
            OAuth client secret
            <input
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              type="password"
              autoComplete="off"
              style={input}
            />
          </label>

          <label style={{ ...label, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <input type="checkbox" checked={includeGmail} onChange={(e) => setIncludeGmail(e.target.checked)} />
            Also read review notification emails (Gmail, read-only)
          </label>

          {error && <ErrorNote>{error}</ErrorNote>}

          <button type="button" style={disabledStyle(primaryButton, busy)} disabled={busy} onClick={beginConsent}>
            {busy ? "Opening Google..." : "Connect to Google"}
          </button>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// 3. Pick a location

function LocationPicker({
  companyId,
  connection,
  onDone,
}: {
  companyId: string;
  connection: ConnectionData | null;
  onDone: () => void;
}) {
  const workingAccounts = useMemo(
    () => (connection?.accounts ?? []).filter((a) => a.ok && a.accounts.length > 0),
    [connection],
  );
  const [accountKey, setAccountKey] = useState("");
  const [googleAccountId, setGoogleAccountId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const chosenAccount = workingAccounts.find((a) => a.key === accountKey);

  async function addLocation(loc: GoogleLocation) {
    setError(null);
    setSaved(null);
    try {
      const config = await readPluginConfig();
      const existing = Array.isArray(config.locations) ? [...(config.locations as Array<Record<string, unknown>>)] : [];
      const key = (loc.storeCode || loc.title || loc.locationId)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || `location-${loc.locationId}`;

      const entry = {
        key,
        displayName: loc.title,
        googleAccountId,
        locationId: loc.locationId,
        accountKey,
        targetCompanyId: companyId,
      };
      // Matched on the Google location id, not on the generated key: the same
      // listing added twice must update one entry, not create a second that
      // opens duplicate issues for every review.
      const at = existing.findIndex((l) => String(l.locationId) === loc.locationId);
      if (at >= 0) existing[at] = { ...existing[at], ...entry };
      else existing.push(entry);

      await writePluginConfig({ ...config, locations: existing });
      setSaved(
        at >= 0
          ? `Updated ${loc.title}. Its reviews will be filed in this company.`
          : `Added ${loc.title}. Its reviews will be filed in this company.`,
      );
      onDone();
    } catch (err) {
      setError(describeReplyError(err));
    }
  }

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeading}>Choose which locations to watch</h2>

      {workingAccounts.length === 0 && (
        <Note>Connect a working Google account first. Locations are listed from Google, not typed in by hand.</Note>
      )}

      {workingAccounts.length > 0 && (
        <>
          <label style={label}>
            Google account
            <select
              value={accountKey}
              onChange={(e) => {
                setAccountKey(e.target.value);
                setGoogleAccountId("");
                setSaved(null);
              }}
              style={input}
            >
              <option value="">Pick an account...</option>
              {workingAccounts.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </label>

          {chosenAccount && (
            <label style={label}>
              Business listing group
              <select
                value={googleAccountId}
                onChange={(e) => {
                  setGoogleAccountId(e.target.value);
                  setSaved(null);
                }}
                style={input}
              >
                <option value="">Pick a listing group...</option>
                {chosenAccount.accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.accountName} ({a.accountId})
                  </option>
                ))}
              </select>
            </label>
          )}

          {error && <ErrorNote>{error}</ErrorNote>}
          {saved && <Note>{saved}</Note>}

          {accountKey && googleAccountId && (
            // Mounted only once both are chosen, and keyed on the pair:
            // usePluginData has no "do not run yet", so the way to not ask
            // is to not render the thing that asks.
            <LocationChoices
              key={`${accountKey}:${googleAccountId}`}
              companyId={companyId}
              accountKey={accountKey}
              googleAccountId={googleAccountId}
              configured={connection?.locations ?? []}
              onPick={addLocation}
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * One listing group's locations, read from Google.
 *
 * A separate component purely so the read happens only after an account and
 * a listing group have been chosen, and starts again from scratch when
 * either changes.
 */
function LocationChoices({
  companyId,
  accountKey,
  googleAccountId,
  configured,
  onPick,
}: {
  companyId: string;
  accountKey: string;
  googleAccountId: string;
  configured: ConnectionLocation[];
  onPick: (loc: GoogleLocation) => void;
}) {
  const { data, loading, error } = usePluginData<{ accountId: string; locations: GoogleLocation[] }>(
    "google-locations",
    { companyId, accountKey, accountId: googleAccountId },
  );

  if (loading && !data) return <p style={mutedText}>Loading locations from Google...</p>;
  if (error && !data) return <ErrorNote>{describeReplyError(error)}</ErrorNote>;
  if (!data) return null;
  if (data.locations.length === 0) {
    return <Note>This listing group holds no locations that the connected account can manage.</Note>;
  }

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {data.locations.map((loc) => {
        const already = configured.find((l) => l.locationId === loc.locationId);
        return (
          <div key={loc.locationId} style={{ ...innerCard, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div>
              <strong>{loc.title}</strong>
              <div style={mutedText}>
                location {loc.locationId}
                {loc.storeCode ? `, store code ${loc.storeCode}` : ""}
              </div>
            </div>
            <button type="button" style={{ ...secondaryButton, marginLeft: "auto" }} onClick={() => onPick(loc)}>
              {already ? "Update this location" : "Watch this location"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

const WARN_BORDER = "color-mix(in srgb, #dc2626 50%, var(--border))";

const pageRoot: CSSProperties = { display: "grid", gap: 16, padding: 16, maxWidth: 820 };

const sectionHeading: CSSProperties = { margin: "0 0 8px", fontSize: 16 };

const innerCard: CSSProperties = {
  border: css.border,
  borderRadius: 8,
  padding: 12,
  marginTop: 8,
  background: css.card,
};

const label: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 14, marginTop: 12 };

const input: CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: css.border,
  background: css.background,
  color: "inherit",
  fontSize: 14,
};

const badge: CSSProperties = { fontSize: 12, padding: "2px 8px", borderRadius: 999, fontWeight: 600 };
const badgeOk: CSSProperties = { background: "color-mix(in srgb, #16a34a 18%, transparent)", color: "#16a34a" };
const badgeBad: CSSProperties = { background: "color-mix(in srgb, #dc2626 18%, transparent)", color: "#dc2626" };
