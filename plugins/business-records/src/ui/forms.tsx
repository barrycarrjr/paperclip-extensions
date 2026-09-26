/**
 * The editing forms on the Corporate Operations page. Every save goes through
 * the plugin's own routes, which run the same checks as the agent's tools, so
 * a person cannot mark a business formed or a filing done without proof on
 * file any more than the agent can. A refusal is shown in the form as the
 * server wrote it.
 */
import { useEffect, useMemo, useState } from "react";
import {
  DOC_TYPES,
  FILING_STATUSES,
  PREPARERS,
  PROOF_REQUIRED_FILING_STATUSES,
  PROOF_REQUIRED_STATUS,
  RELATIONSHIPS,
  STATUS_FIELDS,
  STATUS_VALUES,
  type BusinessApi,
  type DocumentApi,
  type FilingApi,
  type LinkApi,
  type StatusField,
} from "../domain.js";
import { Button, Field, FormPanel, Input, Select, Textarea } from "./_primitives.js";
import { hostApi, recordsApi, type HostAttachment } from "./api.js";
import { STATUS_LABELS, humanize, preparerLabel } from "./format.js";

const options = (values: readonly string[], label: (v: string) => string = humanize) =>
  values.map((value) => ({ value, label: label(value) }));

/** Empty text means "clear it" to the server. */
const orNull = (value: string): string | null => (value.trim() === "" ? null : value.trim());

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** "2025 P - L.pdf" becomes "2025 P - L", the starting title for a new document. */
export function titleFromFilename(filename: string | null | undefined): string {
  return (filename ?? "").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim();
}

const documentOptions = (documents: DocumentApi[]) =>
  documents.map((d) => ({ value: d.id, label: `${d.title} (${humanize(d.docType).toLowerCase()})` }));

// ---- Business ----

export function BusinessForm({
  companyId,
  business,
  onSaved,
  onCancel,
}: {
  companyId: string;
  business?: BusinessApi;
  onSaved: (businessId: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(business?.name ?? "");
  const [relationship, setRelationship] = useState<string>(business?.relationship ?? "owned");
  const [legalForm, setLegalForm] = useState(business?.legalForm ?? "");
  const [formationState, setFormationState] = useState(business?.formationState ?? "");
  const [taxClassification, setTaxClassification] = useState(business?.taxClassification ?? "");
  const [taxIdLast4, setTaxIdLast4] = useState(business?.taxIdLast4 ?? "");
  const [otherNames, setOtherNames] = useState((business?.otherNames ?? []).join(", "));
  const [notes, setNotes] = useState(business?.notes ?? "");

  return (
    <FormPanel
      title={business ? `Edit ${business.name}` : "Add a business"}
      saveLabel={business ? "Save changes" : "Add business"}
      onCancel={onCancel}
      onSave={async () => {
        const body = {
          name: name.trim(),
          relationship,
          legalForm: orNull(legalForm),
          formationState: orNull(formationState),
          taxClassification: orNull(taxClassification),
          taxIdLast4: orNull(taxIdLast4),
          otherNames: otherNames
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          notes: orNull(notes),
        };
        const result = business
          ? await recordsApi.updateBusiness(companyId, business.id, body)
          : await recordsApi.createBusiness(companyId, body);
        const saved = (result.business as BusinessApi | undefined)?.id ?? business?.id;
        if (saved) onSaved(saved);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Relationship">
          <Select value={relationship} onChange={(e) => setRelationship(e.target.value)} options={options(RELATIONSHIPS)} />
        </Field>
        <Field label="Legal form" hint="For example LLC, S corporation, sole proprietorship.">
          <Input value={legalForm} onChange={(e) => setLegalForm(e.target.value)} />
        </Field>
        <Field label="State formed in">
          <Input value={formationState} onChange={(e) => setFormationState(e.target.value)} />
        </Field>
        <Field label="Taxed as" hint="For example S corporation, partnership.">
          <Input value={taxClassification} onChange={(e) => setTaxClassification(e.target.value)} />
        </Field>
        <Field label="Tax id, last 4 digits only" hint="Never the full number.">
          <Input value={taxIdLast4} onChange={(e) => setTaxIdLast4(e.target.value)} inputMode="numeric" maxLength={4} />
        </Field>
      </div>
      <Field label="Other names" hint="Trade names or former names, separated by commas.">
        <Input value={otherNames} onChange={(e) => setOtherNames(e.target.value)} />
      </Field>
      <Field label="Notes">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </Field>
    </FormPanel>
  );
}

// ---- Status ----

const PERSON_SOURCE_KINDS = [
  { value: "document", label: "A document on file" },
  { value: "external_confirmation", label: "Confirmed with the agency (document on file)" },
  { value: "user_reported", label: "I am reporting it" },
];

export function StatusForm({
  companyId,
  business,
  documents,
  initialField,
  onSaved,
  onCancel,
}: {
  companyId: string;
  business: BusinessApi;
  documents: DocumentApi[];
  initialField?: StatusField;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [field, setField] = useState<StatusField>(initialField ?? "legal");
  const [value, setValue] = useState(business.statuses[initialField ?? "legal"].value);
  const [asOf, setAsOf] = useState(todayIso());
  const [sourceKind, setSourceKind] = useState("document");
  const [documentId, setDocumentId] = useState("");
  const [note, setNote] = useState("");

  const needsProof = PROOF_REQUIRED_STATUS[field].includes(value);
  const usesDocument = sourceKind === "document" || sourceKind === "external_confirmation";

  return (
    <FormPanel
      title="Change a status"
      onCancel={onCancel}
      onSave={async () => {
        await recordsApi.setStatus(companyId, business.id, {
          field,
          value,
          asOf,
          source: {
            kind: sourceKind,
            ...(usesDocument && documentId ? { documentId } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        });
        onSaved();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Which status">
          <Select
            value={field}
            onChange={(e) => {
              const next = e.target.value as StatusField;
              setField(next);
              setValue(business.statuses[next].value);
            }}
            options={STATUS_FIELDS.map((f) => ({ value: f, label: STATUS_LABELS[f] }))}
          />
        </Field>
        <Field label="New value">
          <Select value={value} onChange={(e) => setValue(e.target.value)} options={options(STATUS_VALUES[field])} />
        </Field>
        <Field label="As of">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="How do you know"
          hint={needsProof ? `${humanize(value)} needs a document on file as proof.` : undefined}
        >
          <Select value={sourceKind} onChange={(e) => setSourceKind(e.target.value)} options={PERSON_SOURCE_KINDS} />
        </Field>
        {usesDocument && (
          <Field label="Document">
            <Select
              value={documentId}
              onChange={(e) => setDocumentId(e.target.value)}
              options={documentOptions(documents)}
              placeholder={documents.length === 0 ? "No documents on file yet" : "Choose a document"}
            />
          </Field>
        )}
      </div>
      <Field label="Note">
        <Input value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormPanel>
  );
}

// ---- Documents ----

type FileChoice = "upload" | "existing";

/**
 * Add a document: pick the issue the file lives on (one linked to this
 * business), then either upload a new file there or choose a file already
 * attached to it. With no linked issue, offers to create a records issue.
 */
export function DocumentAddForm({
  companyId,
  business,
  links,
  documents,
  onSaved,
  onCancel,
}: {
  companyId: string;
  business: BusinessApi;
  links: LinkApi[];
  documents: DocumentApi[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const defaultIssue = links.find((l) => l.role === "records")?.issueId ?? links[0]?.issueId ?? "";
  const [issueId, setIssueId] = useState(defaultIssue);
  const [choice, setChoice] = useState<FileChoice>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [attachments, setAttachments] = useState<HostAttachment[] | null>(null);
  const [attachmentId, setAttachmentId] = useState("");
  const [docType, setDocType] = useState("other");
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [issuingBody, setIssuingBody] = useState("");
  const [documentDate, setDocumentDate] = useState("");
  const [renewalDate, setRenewalDate] = useState("");
  const [notes, setNotes] = useState("");
  const [creatingIssue, setCreatingIssue] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  useEffect(() => {
    if (!issueId) return;
    let cancelled = false;
    setAttachments(null);
    hostApi
      .listAttachments(issueId)
      .then((list) => {
        if (!cancelled) setAttachments(list);
      })
      .catch(() => {
        if (!cancelled) setAttachments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  // Files on the issue that are not on the record yet.
  const recorded = useMemo(() => new Set(documents.map((d) => d.attachmentRef).filter(Boolean)), [documents]);
  const unrecorded = (attachments ?? []).filter((a) => !recorded.has(a.id));

  const suggestTitle = (filename: string | null | undefined) => {
    if (!titleTouched) setTitle(titleFromFilename(filename));
  };

  if (links.length === 0) {
    return (
      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <p>
          Documents live as files on an issue. {business.name} has no linked issue yet, so there is nowhere to keep the
          file.
        </p>
        {issueError && <p className="text-xs text-red-700 dark:text-red-300">{issueError}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={creatingIssue}
            onClick={async () => {
              setCreatingIssue(true);
              setIssueError(null);
              try {
                const issue = await hostApi.createIssue(
                  companyId,
                  `${business.name}: records`,
                  `Files for ${business.name}, kept on the Corporate Operations page.`,
                );
                await recordsApi.linkIssue(companyId, business.id, { issueId: issue.id, role: "records" });
                onSaved();
              } catch (err) {
                setIssueError(err instanceof Error ? err.message : String(err));
              } finally {
                setCreatingIssue(false);
              }
            }}
          >
            {creatingIssue ? "Creating..." : "Create a records issue"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <FormPanel
      title="Add a document"
      saveLabel={choice === "upload" ? "Upload and add" : "Add document"}
      onCancel={onCancel}
      onSave={async () => {
        let attachmentRef = attachmentId;
        if (choice === "upload") {
          if (!file) throw new Error("Choose a file to upload.");
          attachmentRef = (await hostApi.uploadAttachment(companyId, issueId, file)).id;
        } else if (!attachmentRef) {
          throw new Error("Choose a file from the issue.");
        }
        await recordsApi.addDocument(companyId, {
          businessId: business.id,
          issueId,
          attachmentRef,
          docType,
          title: title.trim(),
          issuingBody: orNull(issuingBody),
          documentDate: orNull(documentDate),
          renewalDate: orNull(renewalDate),
          notes: orNull(notes),
        });
        onSaved();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Keep the file on">
          <Select
            value={issueId}
            onChange={(e) => setIssueId(e.target.value)}
            options={links.map((l) => ({
              value: l.issueId,
              label: l.issue ? `${l.issue.identifier ? `${l.issue.identifier} ` : ""}${l.issue.title}` : l.issueId,
            }))}
          />
        </Field>
        <Field label="File">
          <Select
            value={choice}
            onChange={(e) => setChoice(e.target.value as FileChoice)}
            options={[
              { value: "upload", label: "Upload a new file" },
              { value: "existing", label: "A file already on that issue" },
            ]}
          />
        </Field>
      </div>
      {choice === "upload" ? (
        <Field label="Choose file">
          <Input
            type="file"
            onChange={(e) => {
              const next = e.target.files?.[0] ?? null;
              setFile(next);
              suggestTitle(next?.name);
            }}
          />
        </Field>
      ) : (
        <Field
          label="File on the issue"
          hint={attachments !== null && unrecorded.length === 0 ? "Every file on that issue is already on the record." : undefined}
        >
          <Select
            value={attachmentId}
            onChange={(e) => {
              setAttachmentId(e.target.value);
              suggestTitle(unrecorded.find((a) => a.id === e.target.value)?.originalFilename);
            }}
            options={unrecorded.map((a) => ({ value: a.id, label: a.originalFilename ?? a.id }))}
            placeholder={attachments === null ? "Loading files..." : "Choose a file"}
          />
        </Field>
      )}
      <DocumentFields
        docType={docType}
        setDocType={setDocType}
        title={title}
        setTitle={(v) => {
          setTitle(v);
          setTitleTouched(true);
        }}
        issuingBody={issuingBody}
        setIssuingBody={setIssuingBody}
        documentDate={documentDate}
        setDocumentDate={setDocumentDate}
        renewalDate={renewalDate}
        setRenewalDate={setRenewalDate}
        notes={notes}
        setNotes={setNotes}
      />
    </FormPanel>
  );
}

function DocumentFields(props: {
  docType: string;
  setDocType: (v: string) => void;
  title: string;
  setTitle: (v: string) => void;
  issuingBody: string;
  setIssuingBody: (v: string) => void;
  documentDate: string;
  setDocumentDate: (v: string) => void;
  renewalDate: string;
  setRenewalDate: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
}) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title">
          <Input value={props.title} onChange={(e) => props.setTitle(e.target.value)} required />
        </Field>
        <Field label="Type">
          <Select value={props.docType} onChange={(e) => props.setDocType(e.target.value)} options={options(DOC_TYPES)} />
        </Field>
        <Field label="Issued by" hint="For example IRS, PA Department of State.">
          <Input value={props.issuingBody} onChange={(e) => props.setIssuingBody(e.target.value)} />
        </Field>
        <Field label="Document date">
          <Input type="date" value={props.documentDate} onChange={(e) => props.setDocumentDate(e.target.value)} />
        </Field>
        <Field label="Renews or expires on" hint="Leave empty if it does not renew.">
          <Input type="date" value={props.renewalDate} onChange={(e) => props.setRenewalDate(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea value={props.notes} onChange={(e) => props.setNotes(e.target.value)} rows={2} />
      </Field>
    </>
  );
}

export function DocumentEditForm({
  companyId,
  document,
  onSaved,
  onCancel,
}: {
  companyId: string;
  document: DocumentApi;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [docType, setDocType] = useState<string>(document.docType);
  const [title, setTitle] = useState(document.title);
  const [issuingBody, setIssuingBody] = useState(document.issuingBody ?? "");
  const [documentDate, setDocumentDate] = useState(document.documentDate ?? "");
  const [renewalDate, setRenewalDate] = useState(document.renewalDate ?? "");
  const [notes, setNotes] = useState(document.notes ?? "");
  return (
    <FormPanel
      title="Edit document"
      onCancel={onCancel}
      onSave={async () => {
        await recordsApi.updateDocument(companyId, document.id, {
          docType,
          title: title.trim(),
          issuingBody: orNull(issuingBody),
          documentDate: orNull(documentDate),
          renewalDate: orNull(renewalDate),
          notes: orNull(notes),
        });
        onSaved();
      }}
    >
      <DocumentFields
        docType={docType}
        setDocType={setDocType}
        title={title}
        setTitle={setTitle}
        issuingBody={issuingBody}
        setIssuingBody={setIssuingBody}
        documentDate={documentDate}
        setDocumentDate={setDocumentDate}
        renewalDate={renewalDate}
        setRenewalDate={setRenewalDate}
        notes={notes}
        setNotes={setNotes}
      />
    </FormPanel>
  );
}

export function DocumentRemoveForm({
  companyId,
  document,
  onSaved,
  onCancel,
}: {
  companyId: string;
  document: DocumentApi;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <FormPanel
      title={`Remove "${document.title}" from the record?`}
      saveLabel="Remove"
      destructive
      onCancel={onCancel}
      onSave={async () => {
        await recordsApi.removeDocument(companyId, document.id, orNull(reason));
        onSaved();
      }}
    >
      <p className="text-xs text-muted-foreground">
        The file stays on its issue and the removal is kept in the history. If this document is the proof for a status
        or a filing, change that first.
      </p>
      <Field label="Reason (optional)">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </FormPanel>
  );
}

// ---- Filings ----

export function FilingForm({
  companyId,
  business,
  filing,
  onSaved,
  onCancel,
}: {
  companyId: string;
  business: BusinessApi;
  filing?: FilingApi;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(filing?.filing ?? "");
  const [authority, setAuthority] = useState(filing?.authority ?? "");
  const [periodLabel, setPeriodLabel] = useState(filing?.periodLabel ?? "");
  const [periodStart, setPeriodStart] = useState(filing?.periodStart ?? "");
  const [periodEnd, setPeriodEnd] = useState(filing?.periodEnd ?? "");
  const [dueDate, setDueDate] = useState(filing?.dueDate ?? "");
  const [preparer, setPreparer] = useState<string>(filing?.preparer ?? "");
  const [notes, setNotes] = useState(filing?.notes ?? "");
  return (
    <FormPanel
      title={filing ? `Edit ${filing.filing} (${filing.periodLabel})` : "Add a filing"}
      saveLabel={filing ? "Save changes" : "Add filing"}
      onCancel={onCancel}
      onSave={async () => {
        const body = {
          businessId: business.id,
          filing: name.trim(),
          authority: authority.trim(),
          periodLabel: periodLabel.trim(),
          periodStart: orNull(periodStart),
          periodEnd: orNull(periodEnd),
          dueDate,
          preparer: preparer || null,
          notes: orNull(notes),
        };
        if (filing) await recordsApi.updateFiling(companyId, filing.id, body);
        else await recordsApi.createFiling(companyId, body);
        onSaved();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Filing" hint="For example Form 1120-S, Annual report.">
          <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </Field>
        <Field label="Filed with" hint="For example IRS, PA Department of State.">
          <Input value={authority} onChange={(e) => setAuthority(e.target.value)} required />
        </Field>
        <Field label="Period" hint="For example 2025, or 2026 Q1.">
          <Input value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)} required />
        </Field>
        <Field label="Due date">
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </Field>
        <Field label="Period starts">
          <Input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
        </Field>
        <Field label="Period ends">
          <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
        </Field>
        <Field label="Prepared by">
          <Select
            value={preparer}
            onChange={(e) => setPreparer(e.target.value)}
            options={options(PREPARERS, preparerLabel)}
            placeholder="Not decided"
          />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </Field>
    </FormPanel>
  );
}

const NOT_REQUIRED_SOURCES = [
  { value: "document", label: "A document on file" },
  { value: "professional_advice", label: "Advice from a CPA or lawyer" },
  { value: "official_guidance", label: "Official guidance" },
];

export function FilingStatusForm({
  companyId,
  filing,
  documents,
  onSaved,
  onCancel,
}: {
  companyId: string;
  filing: FilingApi;
  documents: DocumentApi[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [status, setStatus] = useState<string>(filing.status);
  const [proofDocumentId, setProofDocumentId] = useState(filing.proofDocumentId ?? "");
  const [extendedDueDate, setExtendedDueDate] = useState(filing.extendedDueDate ?? "");
  const [reason, setReason] = useState(filing.notRequiredReason ?? "");
  const [sourceKind, setSourceKind] = useState("professional_advice");
  const [sourceDocumentId, setSourceDocumentId] = useState("");
  const [sourceNote, setSourceNote] = useState("");

  const needsProof = (PROOF_REQUIRED_FILING_STATUSES as readonly string[]).includes(status);
  return (
    <FormPanel
      title={`Change status: ${filing.filing} (${filing.periodLabel})`}
      onCancel={onCancel}
      onSave={async () => {
        await recordsApi.setFilingStatus(companyId, filing.id, {
          status,
          ...(needsProof && proofDocumentId ? { proofDocumentId } : {}),
          ...(status === "extension_filed" ? { extendedDueDate: orNull(extendedDueDate) } : {}),
          ...(status === "not_required"
            ? {
                reason: orNull(reason),
                source: {
                  kind: sourceKind,
                  ...(sourceKind === "document" && sourceDocumentId ? { documentId: sourceDocumentId } : {}),
                  ...(sourceNote.trim() ? { note: sourceNote.trim() } : {}),
                },
              }
            : {}),
        });
        onSaved();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} options={options(FILING_STATUSES)} />
        </Field>
        {needsProof && (
          <Field label="Proof on file" hint="The confirmation, the accepted return or the extension notice.">
            <Select
              value={proofDocumentId}
              onChange={(e) => setProofDocumentId(e.target.value)}
              options={documentOptions(documents)}
              placeholder={documents.length === 0 ? "Add the proof as a document first" : "Choose the proof"}
            />
          </Field>
        )}
        {status === "extension_filed" && (
          <Field label="New due date">
            <Input type="date" value={extendedDueDate} onChange={(e) => setExtendedDueDate(e.target.value)} required />
          </Field>
        )}
      </div>
      {status === "not_required" && (
        <>
          <Field label="Why it is not required">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} required />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="On whose word">
              <Select value={sourceKind} onChange={(e) => setSourceKind(e.target.value)} options={NOT_REQUIRED_SOURCES} />
            </Field>
            {sourceKind === "document" ? (
              <Field label="Document">
                <Select
                  value={sourceDocumentId}
                  onChange={(e) => setSourceDocumentId(e.target.value)}
                  options={documentOptions(documents)}
                  placeholder="Choose a document"
                />
              </Field>
            ) : (
              <Field label="Who said so, and when">
                <Input value={sourceNote} onChange={(e) => setSourceNote(e.target.value)} />
              </Field>
            )}
          </div>
        </>
      )}
    </FormPanel>
  );
}
