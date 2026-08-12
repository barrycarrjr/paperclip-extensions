/**
 * Triage rules manager.
 *
 * Rules moved into the plugin database in v0.6.0, which fixed them drifting in
 * a hand-edited document but left no way to see or change them: the only
 * controls were the Keep active / Auto-noise buttons on an open conversation,
 * and those can only ever write a rule for that one sender's exact address.
 * Most real rules are domains, subject fragments, and sender names, so the
 * useful ones were unreachable. This is the full list plus the four forms.
 *
 * Colours come from the host's CSS variables so the panel follows light and
 * dark mode, with fallbacks in case a host ever renders it without them.
 */
import { useMemo, useState } from "react";
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

type RuleType = "auto-noise" | "keep-active";

interface Rule {
  senderPattern: string;
  ruleType: RuleType;
  mailboxId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MailboxRow {
  accountKey: string;
  mailboxId: string;
  name: string;
}

/** The four shapes a pattern can take, as a person would describe them. */
type PatternKind = "address" | "domain" | "subject" | "sender";

const PATTERN_KINDS: Array<{ kind: PatternKind; label: string; placeholder: string; hint: string }> = [
  {
    kind: "address",
    label: "Email address",
    placeholder: "noreply@example.com",
    hint: "Matches that exact address.",
  },
  {
    kind: "domain",
    label: "Domain",
    placeholder: "example.com",
    hint: "Matches the whole domain, including subdomains like mail.example.com.",
  },
  {
    kind: "subject",
    label: "Subject contains",
    placeholder: "Daily Summary",
    hint: "Matches anywhere in the subject, ignoring case.",
  },
  {
    kind: "sender",
    label: "Sender name",
    placeholder: "Rollbar Notification",
    hint: "Matches the sender's display name, not their address.",
  },
];

/** Build the stored pattern from what the operator typed. */
function composePattern(kind: PatternKind, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  switch (kind) {
    case "address":
      return value.toLowerCase();
    case "domain":
      return "@" + value.replace(/^@+/, "").toLowerCase();
    case "subject":
      return "subject: " + value;
    case "sender":
      return "sender: " + value;
  }
}

/** Describe a stored pattern back to a person. */
function describePattern(pattern: string): { kind: string; value: string } {
  if (/^subject:/i.test(pattern)) {
    return { kind: "Subject contains", value: pattern.replace(/^subject:\s*/i, "") };
  }
  if (/^sender:/i.test(pattern)) {
    return { kind: "Sender name", value: pattern.replace(/^sender:\s*/i, "") };
  }
  if (pattern.startsWith("@")) return { kind: "Domain", value: pattern };
  return { kind: "Email address", value: pattern };
}

const ADDRESS_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const DOMAIN_RE = /^@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Reject a malformed pattern here rather than storing it. A rule that cannot
 * match anything is worse than no rule: it looks like the noise is handled.
 */
function validate(kind: PatternKind, raw: string): string | null {
  const value = raw.trim();
  if (!value) return "Enter something to match on.";
  const pattern = composePattern(kind, raw);
  if (kind === "address") {
    if (!ADDRESS_RE.test(pattern)) return "That does not look like an email address.";
    return null;
  }
  if (kind === "domain") {
    if (!DOMAIN_RE.test(pattern)) return "That does not look like a domain, for example example.com.";
    return null;
  }
  return null;
}

const css = {
  border: "1px solid var(--border, #e5e7eb)",
  muted: "var(--muted-foreground, #6b7280)",
  fg: "var(--foreground, #111827)",
  card: "var(--card, #ffffff)",
  danger: "var(--destructive, #dc2626)",
};

const inputStyle: React.CSSProperties = {
  padding: "6px 8px",
  border: css.border,
  borderRadius: 4,
  background: "var(--background, #fff)",
  color: css.fg,
  fontSize: 13,
};

export function RulesSettingsPage(_props: PluginSettingsPageProps) {
  const host = useHostContext();
  const companyId = host.companyId ?? undefined;

  const mailboxes = usePluginData<{ mailboxes: MailboxRow[] }>("helpscout.list-mailboxes", {
    companyId,
  });

  const accountKeys = useMemo(() => {
    const seen = new Set<string>();
    for (const m of mailboxes.data?.mailboxes ?? []) seen.add(m.accountKey);
    return [...seen];
  }, [mailboxes.data]);

  const [account, setAccount] = useState<string | null>(null);
  const activeAccount = account ?? accountKeys[0] ?? null;

  const rules = usePluginData<{ rules: Rule[] }>(
    "helpscout.list-rules",
    activeAccount ? { companyId, accountKey: activeAccount } : {},
  );

  const setRule = usePluginAction("helpscout.set-rule");
  const deleteRule = usePluginAction("helpscout.delete-rule");

  const [kind, setKind] = useState<PatternKind>("domain");
  const [value, setValue] = useState("");
  const [ruleType, setRuleType] = useState<RuleType>("auto-noise");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const kindMeta = PATTERN_KINDS.find((k) => k.kind === kind)!;
  const existing = rules.data?.rules ?? [];
  const validationError = value.trim() ? validate(kind, value) : null;

  async function add() {
    const problem = validate(kind, value);
    if (problem) {
      setMessage({ tone: "bad", text: problem });
      return;
    }
    const pattern = composePattern(kind, value);
    if (existing.some((r) => r.senderPattern.toLowerCase() === pattern.toLowerCase())) {
      setMessage({ tone: "bad", text: `There is already a rule for ${pattern}.` });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await setRule({ companyId, accountKey: activeAccount, senderPattern: pattern, ruleType });
      setValue("");
      setMessage({ tone: "ok", text: `Added ${pattern}.` });
      rules.refresh();
    } catch (err) {
      setMessage({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: Rule) {
    setBusy(true);
    setMessage(null);
    try {
      await deleteRule({
        companyId,
        accountKey: activeAccount,
        senderPattern: rule.senderPattern,
        ...(rule.mailboxId ? { mailboxId: rule.mailboxId } : {}),
      });
      setMessage({ tone: "ok", text: `Removed ${rule.senderPattern}.` });
      rules.refresh();
    } catch (err) {
      setMessage({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const grouped: Array<{ type: RuleType; title: string; blurb: string; items: Rule[] }> = [
    {
      type: "keep-active",
      title: "Keep active",
      blurb: "Never auto-closed, even if an auto-noise rule also matches.",
      items: existing.filter((r) => r.ruleType === "keep-active"),
    },
    {
      type: "auto-noise",
      title: "Auto-noise",
      blurb: "Tagged and closed automatically on the next triage run.",
      items: existing.filter((r) => r.ruleType === "auto-noise"),
    },
  ];

  if (mailboxes.loading) return <div style={{ padding: 16, color: css.muted }}>Loading…</div>;
  if (!activeAccount) {
    return (
      <div style={{ padding: 16, color: css.muted }}>
        No Help Scout account is configured for this company yet. Add one on the Configuration tab
        first.
      </div>
    );
  }

  return (
    <div style={{ padding: 16, color: css.fg }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Triage rules</h2>
      <p style={{ color: css.muted, fontSize: 13, margin: "4px 0 16px" }}>
        What the triage routine does with a conversation before you ever see it. Keep active is
        checked first and always wins.
      </p>

      {accountKeys.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: css.muted, marginRight: 8 }}>Account</label>
          <select
            value={activeAccount}
            onChange={(e) => setAccount(e.target.value)}
            style={inputStyle}
          >
            {accountKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ border: css.border, borderRadius: 6, padding: 12, marginBottom: 16, background: css.card }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
          <select value={ruleType} onChange={(e) => setRuleType(e.target.value as RuleType)} style={inputStyle}>
            <option value="auto-noise">Auto-noise</option>
            <option value="keep-active">Keep active</option>
          </select>
          <select value={kind} onChange={(e) => setKind(e.target.value as PatternKind)} style={inputStyle}>
            {PATTERN_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !busy) void add();
            }}
            placeholder={kindMeta.placeholder}
            style={{ ...inputStyle, flex: 1, minWidth: 220 }}
          />
          <button
            type="button"
            onClick={() => void add()}
            disabled={busy || !value.trim() || !!validationError}
            style={{
              ...inputStyle,
              cursor: busy || !value.trim() || !!validationError ? "not-allowed" : "pointer",
              opacity: busy || !value.trim() || !!validationError ? 0.5 : 1,
              fontWeight: 600,
            }}
          >
            {busy ? "Working…" : "Add rule"}
          </button>
        </div>
        <p style={{ fontSize: 12, color: validationError ? css.danger : css.muted, margin: "8px 0 0" }}>
          {validationError ?? kindMeta.hint}
        </p>
        {value.trim() && !validationError && (
          <p style={{ fontSize: 12, color: css.muted, margin: "4px 0 0" }}>
            Will be stored as <code>{composePattern(kind, value)}</code>
          </p>
        )}
      </div>

      {message && (
        <p style={{ fontSize: 13, color: message.tone === "bad" ? css.danger : css.muted, marginBottom: 12 }}>
          {message.text}
        </p>
      )}

      {rules.loading && <div style={{ color: css.muted, fontSize: 13 }}>Loading rules…</div>}
      {rules.error && (
        <div style={{ color: css.danger, fontSize: 13 }}>Could not load rules: {rules.error.message}</div>
      )}

      {!rules.loading &&
        grouped.map((group) => (
          <div key={group.type} style={{ marginBottom: 20 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{group.title}</h3>
              <span style={{ fontSize: 12, color: css.muted }}>
                {group.items.length} rule{group.items.length === 1 ? "" : "s"}
              </span>
            </div>
            <p style={{ fontSize: 12, color: css.muted, margin: "2px 0 8px" }}>{group.blurb}</p>
            {group.items.length === 0 ? (
              <p style={{ fontSize: 13, color: css.muted, margin: 0 }}>None yet.</p>
            ) : (
              <div style={{ border: css.border, borderRadius: 6, overflow: "hidden" }}>
                {group.items.map((rule, i) => {
                  const described = describePattern(rule.senderPattern);
                  return (
                    <div
                      key={rule.senderPattern}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 12,
                        padding: "8px 12px",
                        borderTop: i === 0 ? "none" : css.border,
                        background: css.card,
                      }}
                    >
                      <span style={{ fontSize: 11, color: css.muted, width: 108, flexShrink: 0 }}>
                        {described.kind}
                      </span>
                      <code style={{ flex: 1, fontSize: 13, wordBreak: "break-all" }}>
                        {described.value}
                      </code>
                      {rule.mailboxId && (
                        <span style={{ fontSize: 11, color: css.muted }}>mailbox {rule.mailboxId}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => void remove(rule)}
                        disabled={busy}
                        style={{
                          background: "none",
                          border: "none",
                          color: css.danger,
                          cursor: busy ? "not-allowed" : "pointer",
                          fontSize: 12,
                          padding: 0,
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
