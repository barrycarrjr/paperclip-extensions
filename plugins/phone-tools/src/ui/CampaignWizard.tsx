import { useState, type CSSProperties } from "react";

/**
 * Inline single-page wizard for creating a campaign + importing its
 * initial lead list. The 4 conceptual steps from Plan 14 (Basics /
 * Lead list / Pacing / Compliance) are rendered as four expandable
 * sections — operator can fill them in any order, validation gates
 * Submit. After a successful create, optionally imports the supplied
 * CSV in a follow-up call before navigating to the new campaign's
 * detail view.
 */

export interface CampaignWizardProps {
  companyId: string;
  onCancel: () => void;
  onCreated: (campaignId: string) => void;
}

export function CampaignWizard({ companyId, onCancel, onCreated }: CampaignWizardProps) {
  // Basics
  const [assistantAgentId, setAssistantAgentId] = useState("");
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [accountKey, setAccountKey] = useState("");
  const [outcomeIssueProjectId, setOutcomeIssueProjectId] = useState("");

  // Pacing
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [secondsBetweenDials, setSecondsBetweenDials] = useState(90);
  const [maxPerHour, setMaxPerHour] = useState(30);
  const [maxPerDay, setMaxPerDay] = useState(200);

  // Compliance preflight
  const [audienceKind, setAudienceKind] = useState<"b2b-businesses" | "b2b-with-soleprop" | "consumer">(
    "b2b-businesses",
  );
  const [audienceJustification, setAudienceJustification] = useState("");
  const [listSource, setListSource] = useState<
    "first-party-customers" | "first-party-inquired" | "scraped-public-business" | "rented" | "purchased" | "other"
  >("scraped-public-business");
  const [listSourceNote, setListSourceNote] = useState("");
  const [geographicScope, setGeographicScope] = useState("US-PA, US-NJ");
  const [hoursStart, setHoursStart] = useState(9);
  const [hoursEnd, setHoursEnd] = useState(18);
  const [weekendsAllowed, setWeekendsAllowed] = useState(false);
  const [openingDisclosure, setOpeningDisclosure] = useState(
    "Hi, this is your assistant calling on behalf of <YOUR BUSINESS>. I'm calling about <PURPOSE>. Do you have 30 seconds?",
  );
  const [optOutLanguage, setOptOutLanguage] = useState(
    "And — if you'd prefer we don't call again, just let me know and I'll take you off the list.",
  );
  const [acknowledgedTcpa, setAckTcpa] = useState(false);
  const [acknowledgedDnc, setAckDnc] = useState(false);

  // Lead list (CSV)
  const [csvText, setCsvText] = useState("");
  const [csvPhoneCol, setCsvPhoneCol] = useState("phone");
  const [csvNameCol, setCsvNameCol] = useState("name");
  const [csvBusinessCol, setCsvBusinessCol] = useState("businessName");
  const [csvWebsiteCol, setCsvWebsiteCol] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvImportResult, setCsvImportResult] = useState<string | null>(null);

  function loadCsvFromFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setCsvText(reader.result);
    };
    reader.readAsText(file);
  }

  async function handleSubmit() {
    setError(null);
    setCsvImportResult(null);
    if (!assistantAgentId.trim()) return setError("Assistant agent ID is required.");
    if (!name.trim()) return setError("Campaign name is required.");
    if (!purpose.trim()) return setError("Purpose is required.");
    if (!acknowledgedTcpa) return setError("TCPA acknowledgement is required.");
    if (!acknowledgedDnc) return setError("DNC acknowledgement is required.");
    if (!geographicScope.trim()) return setError("Geographic scope is required.");

    setSubmitting(true);
    try {
      const createUrl = new URL("/api/plugins/phone-tools/api/campaigns", window.location.origin);
      createUrl.searchParams.set("companyId", companyId);
      const body = {
        assistantAgentId: assistantAgentId.trim(),
        name: name.trim(),
        purpose: purpose.trim(),
        account: accountKey.trim() || undefined,
        outcomeIssueProjectId: outcomeIssueProjectId.trim() || undefined,
        pacing: { maxConcurrent, secondsBetweenDials, maxPerHour, maxPerDay },
        preflight: {
          audienceKind,
          audienceJustification: audienceJustification.trim(),
          listSource,
          listSourceNote: listSourceNote.trim(),
          geographicScope: geographicScope.split(",").map((s) => s.trim()).filter(Boolean),
          callerLocalHours: { startHour: hoursStart, endHour: hoursEnd, weekendsAllowed },
          openingDisclosure: openingDisclosure.trim(),
          optOutLanguage: optOutLanguage.trim(),
          acknowledgedTcpa,
          acknowledgedDnc,
          acknowledgedAt: new Date().toISOString(),
          acknowledgedBy: "operator",
        },
      };
      const res = await fetch(createUrl.toString(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => null);
      if (!res.ok) throw new Error(extractError(respBody, res.status));
      const campaignId = (respBody as { campaign: { id: string } }).campaign.id;

      // If a CSV is provided, import it before navigating.
      if (csvText.trim().length > 0) {
        const csvUrl = new URL(
          `/api/plugins/phone-tools/api/campaigns/${campaignId}/leads/import-csv`,
          window.location.origin,
        );
        csvUrl.searchParams.set("companyId", companyId);
        const csvRes = await fetch(csvUrl.toString(), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            csvText,
            mapping: {
              phone: csvPhoneCol.trim() || "phone",
              name: csvNameCol.trim() || undefined,
              businessName: csvBusinessCol.trim() || undefined,
              website: csvWebsiteCol.trim() || undefined,
            },
          }),
        });
        const csvBody = await csvRes.json().catch(() => null);
        if (!csvRes.ok) {
          // Campaign was created but CSV import failed — surface a useful note
          // and still navigate to the campaign so the operator can retry the
          // import from the detail view.
          setCsvImportResult(`Campaign created but CSV import failed: ${extractError(csvBody, csvRes.status)}`);
          onCreated(campaignId);
          return;
        }
        const { added, skipped } = csvBody as { added: number; skipped: Array<unknown> };
        setCsvImportResult(
          `Imported ${added} lead(s); skipped ${skipped.length}.`,
        );
      }

      onCreated(campaignId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={stack}>
      <h2 style={{ margin: 0, fontSize: 18 }}>New campaign</h2>

      <Section title="1. Basics">
        <Field label="Driving assistant — Paperclip agent UUID">
          <input
            type="text"
            value={assistantAgentId}
            onChange={(e) => setAssistantAgentId(e.target.value)}
            placeholder="agent UUID"
            style={input}
          />
          <Hint>
            Must be an `assistant`-role agent with `transferTarget` set on its phone config.
          </Hint>
        </Field>
        <Field label="Campaign name">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sample Pack 2026Q2"
            style={input}
          />
        </Field>
        <Field label="Purpose (one sentence)">
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. introduce our quarterly print sample pack to local restaurant owners"
            style={input}
          />
          <Hint>Spliced into the assistant's opening line.</Hint>
        </Field>
        <Field label="Phone account (optional)">
          <input
            type="text"
            value={accountKey}
            onChange={(e) => setAccountKey(e.target.value)}
            placeholder="account key, e.g. 'main' (leave blank for default)"
            style={input}
          />
        </Field>
        <Field label="Outcome issue project (optional)">
          <input
            type="text"
            value={outcomeIssueProjectId}
            onChange={(e) => setOutcomeIssueProjectId(e.target.value)}
            placeholder="Paperclip project UUID for qualified-lead issues"
            style={input}
          />
          <Hint>Defaults to the assistant's transferIssueProjectId if blank.</Hint>
        </Field>
      </Section>

      <Section title="2. Lead list (CSV)">
        <Field label="CSV file (or paste below)">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) loadCsvFromFile(f);
            }}
            style={{ fontSize: 13 }}
          />
        </Field>
        <Field label="…or paste CSV text">
          <textarea
            value={csvText}
            onChange={(e) => setCsvText(e.target.value)}
            placeholder={`phone,name,businessName\n+12155551234,Marco,Marco's Pizza\n+12155555678,Anna,Anna Sushi`}
            rows={6}
            style={{ ...input, fontFamily: "monospace", fontSize: 12 }}
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Phone column">
            <input type="text" value={csvPhoneCol} onChange={(e) => setCsvPhoneCol(e.target.value)} style={input} />
          </Field>
          <Field label="Name column (optional)">
            <input type="text" value={csvNameCol} onChange={(e) => setCsvNameCol(e.target.value)} style={input} />
          </Field>
          <Field label="Business-name column (optional)">
            <input type="text" value={csvBusinessCol} onChange={(e) => setCsvBusinessCol(e.target.value)} style={input} />
          </Field>
          <Field label="Website column (optional)">
            <input type="text" value={csvWebsiteCol} onChange={(e) => setCsvWebsiteCol(e.target.value)} style={input} />
          </Field>
        </div>
        <Hint>Leave CSV blank to create the campaign empty — you can append leads later via the API.</Hint>
      </Section>

      <Section title="3. Pacing">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Max concurrent calls">
            <input
              type="number"
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(Number(e.target.value))}
              min={1}
              max={20}
              style={input}
            />
          </Field>
          <Field label="Seconds between dials">
            <input
              type="number"
              value={secondsBetweenDials}
              onChange={(e) => setSecondsBetweenDials(Number(e.target.value))}
              min={5}
              max={3600}
              style={input}
            />
          </Field>
          <Field label="Max calls per hour">
            <input
              type="number"
              value={maxPerHour}
              onChange={(e) => setMaxPerHour(Number(e.target.value))}
              min={1}
              max={500}
              style={input}
            />
          </Field>
          <Field label="Max calls per day">
            <input
              type="number"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(Number(e.target.value))}
              min={1}
              max={5000}
              style={input}
            />
          </Field>
        </div>
      </Section>

      <Section title="4. Compliance preflight">
        <Field label="Audience">
          <select value={audienceKind} onChange={(e) => setAudienceKind(e.target.value as typeof audienceKind)} style={input}>
            <option value="b2b-businesses">B2B businesses (safest)</option>
            <option value="b2b-with-soleprop">B2B incl. sole proprietors (mixed)</option>
            <option value="consumer">Consumer (requires first-party list)</option>
          </select>
        </Field>
        <Field label="Audience justification (free-form)">
          <input
            type="text"
            value={audienceJustification}
            onChange={(e) => setAudienceJustification(e.target.value)}
            placeholder="e.g. local restaurants — public business lines, B2B carve-out applies"
            style={input}
          />
        </Field>
        <Field label="List source">
          <select value={listSource} onChange={(e) => setListSource(e.target.value as typeof listSource)} style={input}>
            <option value="first-party-customers">First-party customers</option>
            <option value="first-party-inquired">First-party inquiries (web form, etc.)</option>
            <option value="scraped-public-business">Scraped public business directory</option>
            <option value="rented">Rented (B2B leadgen vendor)</option>
            <option value="purchased">Purchased (B2B leadgen vendor)</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="List source note (required for purchased/rented)">
          <input
            type="text"
            value={listSourceNote}
            onChange={(e) => setListSourceNote(e.target.value)}
            placeholder="e.g. google maps search 'pizza near me' filtered by has-public-phone"
            style={input}
          />
        </Field>
        <Field label="Geographic scope (ISO 3166-2, comma-separated)">
          <input
            type="text"
            value={geographicScope}
            onChange={(e) => setGeographicScope(e.target.value)}
            placeholder="US-PA, US-NJ"
            style={input}
          />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          <Field label="Caller-local start hour">
            <input
              type="number"
              value={hoursStart}
              onChange={(e) => setHoursStart(Number(e.target.value))}
              min={0}
              max={23}
              style={input}
            />
          </Field>
          <Field label="End hour">
            <input
              type="number"
              value={hoursEnd}
              onChange={(e) => setHoursEnd(Number(e.target.value))}
              min={1}
              max={23}
              style={input}
            />
          </Field>
          <Field label="Weekends">
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={weekendsAllowed}
                onChange={(e) => setWeekendsAllowed(e.target.checked)}
              />
              Allowed
            </label>
          </Field>
        </div>
        <Field label="Opening disclosure (≥20 chars)">
          <textarea
            value={openingDisclosure}
            onChange={(e) => setOpeningDisclosure(e.target.value)}
            rows={2}
            style={{ ...input, fontFamily: "inherit" }}
          />
        </Field>
        <Field label="Opt-out language">
          <textarea
            value={optOutLanguage}
            onChange={(e) => setOptOutLanguage(e.target.value)}
            rows={2}
            style={{ ...input, fontFamily: "inherit" }}
          />
        </Field>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
          <label style={ackLabel}>
            <input type="checkbox" checked={acknowledgedTcpa} onChange={(e) => setAckTcpa(e.target.checked)} />
            <span>
              I have reviewed TCPA + state-level rules for this audience (B2B / consumer / sole-prop) and confirm
              this campaign complies.
            </span>
          </label>
          <label style={ackLabel}>
            <input type="checkbox" checked={acknowledgedDnc} onChange={(e) => setAckDnc(e.target.checked)} />
            <span>The DNC list will be honored before every dial. Opt-outs from in-call AI are auto-added.</span>
          </label>
        </div>
      </Section>

      {csvImportResult && <div style={infoBox}>{csvImportResult}</div>}
      {error && <div style={errBox}>{error}</div>}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button type="button" onClick={onCancel} disabled={submitting} style={ghostButton}>
          Cancel
        </button>
        <button type="button" onClick={handleSubmit} disabled={submitting} style={primaryButton}>
          {submitting ? "Creating…" : "Create campaign (draft)"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={panel}>
      <h3 style={panelTitle}>{title}</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <span style={hint}>{children}</span>;
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string") {
    return (body as { error: string }).error;
  }
  return `Request failed (${status})`;
}

const stack: CSSProperties = { display: "flex", flexDirection: "column", gap: 16 };
const panel: CSSProperties = { padding: 16, border: "1px solid var(--border)" };
const panelTitle: CSSProperties = { margin: "0 0 12px", fontSize: 13, fontWeight: 600 };
const fieldLabel: CSSProperties = { fontSize: 12, color: "var(--muted-foreground)" };
const hint: CSSProperties = { fontSize: 11, color: "var(--muted-foreground)" };
const input: CSSProperties = {
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "8px 10px",
  fontSize: 13,
};
const ackLabel: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  fontSize: 13,
  lineHeight: 1.4,
};
const errBox: CSSProperties = {
  padding: 12,
  border: "1px solid var(--destructive, #f00)",
  color: "var(--destructive, #f00)",
  fontSize: 13,
};
const infoBox: CSSProperties = {
  padding: 12,
  border: "1px solid var(--border)",
  fontSize: 13,
};
const ghostButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--border)",
  background: "transparent",
  color: "inherit",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
const primaryButton: CSSProperties = {
  appearance: "none",
  border: "1px solid var(--foreground)",
  background: "var(--foreground)",
  color: "var(--background)",
  padding: "6px 14px",
  fontSize: 13,
  cursor: "pointer",
};
