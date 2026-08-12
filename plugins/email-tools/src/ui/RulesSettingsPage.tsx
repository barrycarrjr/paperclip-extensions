/**
 * Sender rules manager.
 *
 * Rules have lived in the plugin database since v0.8.0, but the only way to
 * create one was the Auto-triage / Keep / Mute buttons on a message, which can
 * only ever write that one sender's exact address, and there was no delete
 * path in the product at all. This is the full list per mailbox, the three
 * pattern forms, and a delete button.
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
import {
  isValidRulePattern,
  describeInvalidPattern,
  normalizeRulePattern,
  type RuleType,
} from "../rule-patterns.js";

interface Rule {
  senderPattern: string;
  ruleType: RuleType;
  createdAt: string;
  updatedAt: string;
}

interface Mailbox {
  key: string;
  name: string;
  pollFolder: string;
}

type PatternKind = "address" | "domain" | "subject";

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
    hint: "Matches any address at that domain.",
  },
  {
    kind: "subject",
    label: "Subject contains",
    placeholder: "Daily Summary",
    hint: "Matches anywhere in the subject, ignoring case.",
  },
];

const RULE_TYPE_META: Array<{ type: RuleType; label: string; blurb: string }> = [
  {
    type: "keep-always",
    label: "Keep",
    blurb: "Always left in INBOX and never auto-triaged. Checked before auto-triage.",
  },
  {
    type: "mute",
    label: "Mute",
    blurb: "Stays in INBOX, but new arrivals are marked read automatically.",
  },
  {
    type: "auto-triage",
    label: "Auto-triage",
    blurb: "Moved out of INBOX to _paperclip/triage as it arrives.",
  },
];

function composePattern(kind: PatternKind, raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (kind === "address") return value.toLowerCase();
  if (kind === "domain") return "@" + value.replace(/^@+/, "").toLowerCase();
  return "subject: " + value;
}

function describePattern(pattern: string): { kind: string; value: string } {
  if (/^subject:/i.test(pattern)) {
    return { kind: "Subject contains", value: pattern.replace(/^subject:\s*/i, "") };
  }
  if (pattern.startsWith("@")) return { kind: "Domain", value: pattern };
  return { kind: "Email address", value: pattern };
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

  const mailboxes = usePluginData<{ mailboxes: Mailbox[] }>("email.list-mailboxes", { companyId });
  const mailboxList = useMemo(() => mailboxes.data?.mailboxes ?? [], [mailboxes.data]);

  const [mailbox, setMailbox] = useState<string | null>(null);
  const activeMailbox = mailbox ?? mailboxList[0]?.key ?? null;

  const rules = usePluginData<{ rules: Rule[] }>(
    "email.list-rules",
    activeMailbox ? { companyId, mailbox: activeMailbox } : {},
  );

  const setRule = usePluginAction("email.set-rule");
  const deleteRule = usePluginAction("email.delete-rule");

  const [kind, setKind] = useState<PatternKind>("domain");
  const [value, setValue] = useState("");
  const [ruleType, setRuleType] = useState<RuleType>("auto-triage");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const kindMeta = PATTERN_KINDS.find((k) => k.kind === kind)!;
  const existing = rules.data?.rules ?? [];
  const composed = composePattern(kind, value);
  const validationError =
    value.trim() && !isValidRulePattern(composed) ? describeInvalidPattern(composed) : null;

  async function add() {
    if (!isValidRulePattern(composed)) {
      setMessage({ tone: "bad", text: describeInvalidPattern(composed) });
      return;
    }
    const pattern = normalizeRulePattern(composed);
    const clash = existing.find((r) => r.senderPattern.toLowerCase() === pattern.toLowerCase());
    if (clash && clash.ruleType === ruleType) {
      setMessage({ tone: "bad", text: `There is already a ${ruleType} rule for ${pattern}.` });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = (await setRule({
        companyId,
        mailbox: activeMailbox,
        senderPattern: pattern,
        ruleType,
      })) as { sweptCount?: number } | undefined;
      setValue("");
      // set-rule also sweeps matching mail already sitting unread in INBOX, so
      // say what it touched rather than leaving the operator to notice later.
      const swept = result?.sweptCount ?? 0;
      const changed = clash ? `Changed ${pattern} to ${ruleType}` : `Added ${pattern}`;
      setMessage({
        tone: "ok",
        text: swept > 0 ? `${changed}, and cleaned up ${swept} existing message(s).` : `${changed}.`,
      });
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
      await deleteRule({ companyId, mailbox: activeMailbox, senderPattern: rule.senderPattern });
      setMessage({ tone: "ok", text: `Removed ${rule.senderPattern}.` });
      rules.refresh();
    } catch (err) {
      setMessage({ tone: "bad", text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  if (mailboxes.loading) return <div style={{ padding: 16, color: css.muted }}>Loading…</div>;
  if (!activeMailbox) {
    return (
      <div style={{ padding: 16, color: css.muted }}>
        No mailbox is configured for this company yet. Add one on the Configuration tab first.
      </div>
    );
  }

  return (
    <div style={{ padding: 16, color: css.fg }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>Sender rules</h2>
      <p style={{ color: css.muted, fontSize: 13, margin: "4px 0 16px" }}>
        What happens to mail before you see it. Keep is checked first and always wins. Rules are
        per mailbox.
      </p>

      {mailboxList.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <label style={{ fontSize: 12, color: css.muted, marginRight: 8 }}>Mailbox</label>
          <select value={activeMailbox} onChange={(e) => setMailbox(e.target.value)} style={inputStyle}>
            {mailboxList.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name || m.key}
              </option>
            ))}
          </select>
        </div>
      )}

      <div style={{ border: css.border, borderRadius: 6, padding: 12, marginBottom: 16, background: css.card }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "flex-start" }}>
          <select value={ruleType} onChange={(e) => setRuleType(e.target.value as RuleType)} style={inputStyle}>
            {RULE_TYPE_META.map((r) => (
              <option key={r.type} value={r.type}>
                {r.label}
              </option>
            ))}
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
            Will be stored as <code>{normalizeRulePattern(composed)}</code>
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
        RULE_TYPE_META.map((meta) => {
          const items = existing.filter((r) => r.ruleType === meta.type);
          return (
            <div key={meta.type} style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>{meta.label}</h3>
                <span style={{ fontSize: 12, color: css.muted }}>
                  {items.length} rule{items.length === 1 ? "" : "s"}
                </span>
              </div>
              <p style={{ fontSize: 12, color: css.muted, margin: "2px 0 8px" }}>{meta.blurb}</p>
              {items.length === 0 ? (
                <p style={{ fontSize: 13, color: css.muted, margin: 0 }}>None yet.</p>
              ) : (
                <div style={{ border: css.border, borderRadius: 6, overflow: "hidden" }}>
                  {items.map((rule, i) => {
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
          );
        })}
    </div>
  );
}
