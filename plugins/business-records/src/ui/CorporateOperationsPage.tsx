import { useCallback, useEffect, useMemo, useState } from "react";
import { useHostContext, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { BusinessApi, DocumentApi, FilingApi, HistoryApi, LinkApi, StatusField } from "../domain.js";
import { Badge, Button, Dot, Empty, EmptyState, ErrorBanner, Input, Section, cn } from "./_primitives.js";
import { hostApi, recordsApi, type BusinessDetail, type HostAttachment, type Overview } from "./api.js";
import {
  BusinessForm,
  DocumentAddForm,
  DocumentEditForm,
  DocumentRemoveForm,
  FilingForm,
  FilingStatusForm,
  StatusForm,
} from "./forms.js";
import { DocumentViewer } from "./viewer.js";
import {
  RENEWAL_WINDOW_DAYS,
  STATUS_LABELS,
  allStatusesUnknown,
  attentionByBusiness,
  describeDue,
  describeHistory,
  describeRenewal,
  describeSource,
  dueTone,
  formatDate,
  formatDateTime,
  humanize,
  isFilingOpen,
  legalStatusSummary,
  preparerLabel,
  relativeDays,
  renewalTone,
  roleLabel,
  sortFilingsByDue,
  type AttentionCounts,
} from "./format.js";

const BUSINESS_PARAM = "business";

function issueHref(companyPrefix: string | null, issueId: string): string {
  return companyPrefix ? `/${companyPrefix}/issues/${issueId}` : `/issues/${issueId}`;
}

/** The business id carried in the page URL, so a reload or a shared link lands on the same record. */
function readBusinessFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(BUSINESS_PARAM);
}

function writeBusinessToUrl(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id) url.searchParams.set(BUSINESS_PARAM, id);
  else url.searchParams.delete(BUSINESS_PARAM);
  window.history.replaceState(window.history.state, "", url.toString());
}

// ---- Needs attention ----

function NeedsAttention({
  overview,
  loading,
  onOpen,
}: {
  overview: Overview | null;
  loading: boolean;
  onOpen: (businessId: string) => void;
}) {
  if (!overview) {
    return (
      <Section title="Needs attention">
        <Empty>{loading ? "Checking filings and renewals..." : "Could not load the needs-attention list."}</Empty>
      </Section>
    );
  }
  const { overdueFilings, filingsDueSoon, documentsRenewingSoon, today } = overview;
  const total = overdueFilings.length + filingsDueSoon.length + documentsRenewingSoon.length;
  const rowClass = "flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md px-2 py-1 text-left hover:bg-accent/50";
  return (
    <Section title="Needs attention" count={total}>
      {total === 0 ? (
        <Empty>
          Nothing overdue, nothing due in the next 30 days, and no renewals in the next {RENEWAL_WINDOW_DAYS} days.
        </Empty>
      ) : (
        <div className="space-y-3">
          {overdueFilings.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold text-red-700 dark:text-red-300">Overdue, no proof of filing</h4>
              <ul>
                {overdueFilings.map((f) => (
                  <li key={f.id}>
                    <button type="button" className={rowClass} onClick={() => onOpen(f.businessId)}>
                      <span className="font-medium text-red-700 dark:text-red-300">
                        {f.businessName}: {f.filing} ({f.periodLabel})
                      </span>
                      <span className="text-xs text-red-700 dark:text-red-300">{describeDue(f, today)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {filingsDueSoon.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold text-foreground">Due in the next 30 days</h4>
              <ul>
                {filingsDueSoon.map((f) => {
                  const tone = dueTone(f, today);
                  return (
                    <li key={f.id}>
                      <button type="button" className={rowClass} onClick={() => onOpen(f.businessId)}>
                        <span className="font-medium">
                          {f.businessName}: {f.filing} ({f.periodLabel})
                        </span>
                        <span className={cn("text-xs", tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>
                          {describeDue(f, today)}, {humanize(f.status).toLowerCase()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {documentsRenewingSoon.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-semibold text-foreground">Renewals in the next {RENEWAL_WINDOW_DAYS} days</h4>
              <ul>
                {documentsRenewingSoon.map((d) => {
                  const lapsed = renewalTone(d.renewalDate, today) === "bad";
                  return (
                    <li key={d.id}>
                      <button type="button" className={rowClass} onClick={() => onOpen(d.businessId)}>
                        <span className={cn("font-medium", lapsed && "text-red-700 dark:text-red-300")}>
                          {d.businessName}: {d.title}
                        </span>
                        <span className={cn("text-xs", lapsed ? "text-red-700 dark:text-red-300" : "text-muted-foreground")}>
                          {d.renewalDate ? describeRenewal(d.renewalDate, today) : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

// ---- Business list ----

function AttentionBadge({ counts }: { counts: AttentionCounts | undefined }) {
  if (!counts) return null;
  if (counts.overdue > 0) return <Badge tone="bad">{counts.overdue} overdue</Badge>;
  const soon = counts.dueSoon + counts.renewals;
  if (soon > 0) return <Badge tone="warn">{soon} due soon</Badge>;
  return null;
}

function BusinessList({
  businesses,
  attention,
  selectedId,
  onSelect,
  loading,
  searching,
}: {
  businesses: BusinessApi[];
  attention: Record<string, AttentionCounts>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  searching: boolean;
}) {
  if (loading && businesses.length === 0) return <Empty>Loading...</Empty>;
  if (businesses.length === 0) return <Empty>{searching ? "No business matches that search." : "No businesses on record."}</Empty>;
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-md border border-border bg-card">
      {businesses.map((b) => {
        const legal = legalStatusSummary(b.statuses.legal.value);
        return (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onSelect(b.id)}
              aria-current={b.id === selectedId ? "true" : undefined}
              className={cn(
                "block w-full px-3 py-2 text-left transition-colors",
                b.id === selectedId ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{b.name}</span>
                <AttentionBadge counts={attention[b.id]} />
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Dot tone={legal.tone} label={`Legal status: ${legal.text}`} />
                <span className="truncate">
                  {humanize(b.relationship)} · {legal.text}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ---- Business detail parts ----

/** What the detail view is currently editing, if anything. One form is open at a time. */
type Editing =
  | { kind: "business" }
  | { kind: "status"; field?: StatusField }
  | { kind: "addDocument" }
  | { kind: "editDocument"; id: string }
  | { kind: "removeDocument"; id: string }
  | { kind: "addFiling" }
  | { kind: "editFiling"; id: string }
  | { kind: "filingStatus"; id: string }
  | null;

interface EditProps {
  companyId: string;
  editing: Editing;
  setEditing: (next: Editing) => void;
  /** Close the form and reload the business after a save. */
  onSaved: () => void;
}

function StatusesPart({
  business,
  documents,
  docTitles,
  companyId,
  editing,
  setEditing,
  onSaved,
}: { business: BusinessApi; documents: DocumentApi[]; docTitles: Record<string, string> } & EditProps) {
  const form =
    editing?.kind === "status" ? (
      <StatusForm
        companyId={companyId}
        business={business}
        documents={documents}
        initialField={editing.field}
        onSaved={onSaved}
        onCancel={() => setEditing(null)}
      />
    ) : null;
  const action =
    editing?.kind === "status" ? null : (
      <Button variant="outline" size="xs" onClick={() => setEditing({ kind: "status" })}>
        Change status
      </Button>
    );
  if (allStatusesUnknown(business)) {
    return (
      <Section title="Statuses" action={action}>
        <div className="space-y-3">
          {form}
          <Empty>
            No status has been proven from a document yet. Legal status and the tax account need a document on file to
            be marked active, open or closed: the state's approval, the tax id letter, a dissolution certificate or a
            closure letter.
          </Empty>
        </div>
      </Section>
    );
  }
  return (
    <Section title="Statuses" action={action}>
      <div className="space-y-3">
        {form}
        <dl className="grid gap-4 sm:grid-cols-3">
          {(Object.keys(STATUS_LABELS) as StatusField[]).map((field) => {
            const s = business.statuses[field];
            return (
              <div key={field} className="space-y-0.5">
                <dt className="text-xs text-muted-foreground">{STATUS_LABELS[field]}</dt>
                <dd className="text-sm font-medium">{humanize(s.value)}</dd>
                <dd className="text-xs text-muted-foreground">{s.asOf ? `As of ${formatDate(s.asOf)}` : "No as-of date"}</dd>
                <dd className="text-xs text-muted-foreground">Source: {describeSource(s.source, docTitles)}</dd>
                <dd>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline hover:text-foreground"
                    onClick={() => setEditing({ kind: "status", field })}
                  >
                    Change
                  </button>
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Section>
  );
}

function DocumentsPart({
  business,
  documents,
  links,
  attachments,
  today,
  onView,
  companyId,
  editing,
  setEditing,
  onSaved,
}: {
  business: BusinessApi;
  documents: DocumentApi[];
  links: LinkApi[];
  attachments: Record<string, HostAttachment>;
  today: string;
  onView: (index: number) => void;
} & EditProps) {
  return (
    <Section
      title="Documents"
      count={documents.length}
      action={
        editing?.kind === "addDocument" ? null : (
          <Button variant="outline" size="xs" onClick={() => setEditing({ kind: "addDocument" })}>
            Add document
          </Button>
        )
      }
    >
      <div className="space-y-3">
        {editing?.kind === "addDocument" && (
          <DocumentAddForm
            companyId={companyId}
            business={business}
            links={links}
            documents={documents}
            onSaved={onSaved}
            onCancel={() => setEditing(null)}
          />
        )}
        {documents.length === 0 ? (
          <Empty>No documents on file yet. Add one here, or attach files to the business's records issue and ask the agent to file them.</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {documents.map((d, index) => {
              const tone = renewalTone(d.renewalDate, today);
              const file = d.attachmentRef ? attachments[d.attachmentRef] : undefined;
              const isEditing = editing?.kind === "editDocument" && editing.id === d.id;
              const isRemoving = editing?.kind === "removeDocument" && editing.id === d.id;
              return (
                <li key={d.id} className="space-y-2 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <button type="button" className="text-left font-medium hover:underline" onClick={() => onView(index)}>
                        {d.title}
                      </button>
                      <div className="text-xs text-muted-foreground">
                        {humanize(d.docType)}
                        {d.issuingBody ? ` from ${d.issuingBody}` : ""}
                        {d.documentDate ? `, dated ${formatDate(d.documentDate)}` : ""}
                        {file?.originalFilename ? `, ${file.originalFilename}` : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {d.renewalDate && (
                        <Badge tone={tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}>
                          {describeRenewal(d.renewalDate, today)}
                        </Badge>
                      )}
                      <Button variant="ghost" size="xs" onClick={() => setEditing({ kind: "editDocument", id: d.id })}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => setEditing({ kind: "removeDocument", id: d.id })}>
                        Remove
                      </Button>
                    </div>
                  </div>
                  {isEditing && (
                    <DocumentEditForm companyId={companyId} document={d} onSaved={onSaved} onCancel={() => setEditing(null)} />
                  )}
                  {isRemoving && (
                    <DocumentRemoveForm companyId={companyId} document={d} onSaved={onSaved} onCancel={() => setEditing(null)} />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Section>
  );
}

function FilingsPart({
  business,
  filings,
  documents,
  today,
  companyPrefix,
  companyId,
  editing,
  setEditing,
  onSaved,
}: {
  business: BusinessApi;
  filings: FilingApi[];
  documents: DocumentApi[];
  today: string;
  companyPrefix: string | null;
} & EditProps) {
  const sorted = sortFilingsByDue(filings);
  return (
    <Section
      title="Filings"
      count={filings.length}
      action={
        editing?.kind === "addFiling" ? null : (
          <Button variant="outline" size="xs" onClick={() => setEditing({ kind: "addFiling" })}>
            Add filing
          </Button>
        )
      }
    >
      {editing?.kind === "addFiling" && (
        <div className="mb-3">
          <FilingForm companyId={companyId} business={business} onSaved={onSaved} onCancel={() => setEditing(null)} />
        </div>
      )}
      {sorted.length === 0 ? (
        <Empty>No filings on the calendar yet. Add one here, or ask the agent what this business has to file and it will build the list.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {sorted.map((f) => {
            const tone = dueTone(f, today);
            const textTone =
              tone === "bad" ? "text-red-700 dark:text-red-300" : tone === "warn" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground";
            return (
              <li key={f.id} className={cn("space-y-0.5 py-2", tone === "bad" && "-mx-2 rounded-md bg-red-500/10 px-2")}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={cn("font-medium", tone === "bad" && "text-red-700 dark:text-red-300")}>
                    {f.filing} <span className="font-normal text-muted-foreground">({f.authority}, {f.periodLabel})</span>
                  </span>
                  <Badge tone={tone === "bad" ? "bad" : tone === "warn" ? "warn" : isFilingOpen(f) ? "neutral" : "good"}>
                    {humanize(f.status)}
                  </Badge>
                </div>
                <div className={cn("text-xs", textTone)}>
                  {describeDue(f, today)}
                  {f.extendedDueDate ? `, extended from ${formatDate(f.dueDate)}` : ""}
                  {f.preparer ? `, prepared by ${preparerLabel(f.preparer)}` : ""}
                  {f.issueId && (
                    <>
                      {", "}
                      <a href={issueHref(companyPrefix, f.issueId)} className="underline">
                        tracking issue
                      </a>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {f.status === "not_required"
                      ? `Not required: ${f.notRequiredReason ?? ""}`
                      : f.proofDocumentId
                        ? `Proof on file: ${f.proofTitle ?? f.proofDocumentId}`
                        : "No proof on file"}
                  </span>
                  <span className="flex items-center gap-1">
                    <Button variant="ghost" size="xs" onClick={() => setEditing({ kind: "filingStatus", id: f.id })}>
                      Change status
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => setEditing({ kind: "editFiling", id: f.id })}>
                      Edit
                    </Button>
                  </span>
                </div>
                {editing?.kind === "filingStatus" && editing.id === f.id && (
                  <div className="pt-2">
                    <FilingStatusForm
                      companyId={companyId}
                      filing={f}
                      documents={documents}
                      onSaved={onSaved}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )}
                {editing?.kind === "editFiling" && editing.id === f.id && (
                  <div className="pt-2">
                    <FilingForm
                      companyId={companyId}
                      business={business}
                      filing={f}
                      onSaved={onSaved}
                      onCancel={() => setEditing(null)}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function LinksPart({ links, companyPrefix, today }: { links: LinkApi[]; companyPrefix: string | null; today: string }) {
  return (
    <Section title="Linked cases" count={links.length}>
      {links.length === 0 ? (
        <Empty>No linked issues.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {links.map((l) => (
            <li key={l.issueId} className="flex flex-wrap items-baseline gap-2">
              <Badge>{roleLabel(l.role)}</Badge>
              <a href={issueHref(companyPrefix, l.issueId)} className="hover:underline">
                {l.issue ? `${l.issue.identifier ? `${l.issue.identifier} ` : ""}${l.issue.title}` : l.issueId}
              </a>
              {l.issue && (
                <span className="text-xs text-muted-foreground">
                  {humanize(l.issue.status)}
                  {l.issue.dueDate ? `, due ${formatDate(l.issue.dueDate)} (${relativeDays(l.issue.dueDate.slice(0, 10), today)})` : ""}
                </span>
              )}
              {!l.issue && <span className="text-xs text-muted-foreground">(issue not found)</span>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HistoryPart({ history }: { history: HistoryApi[] }) {
  return (
    <Section title="History" count={history.length}>
      {history.length === 0 ? (
        <Empty>No history yet.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {history.map((h) => (
            <li key={h.id} className="flex flex-wrap gap-x-3 text-xs">
              <span className="whitespace-nowrap text-muted-foreground tabular-nums">{formatDateTime(h.createdAt)}</span>
              <span className="min-w-0">{describeHistory(h)}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * The host's attachment records for every issue the documents live on, keyed
 * by attachment id, so a document can show its file name and open in the viewer.
 */
function useAttachments(documents: DocumentApi[]): Record<string, HostAttachment> {
  const [byId, setById] = useState<Record<string, HostAttachment>>({});
  const issueKey = useMemo(() => [...new Set(documents.map((d) => d.issueId))].sort().join(","), [documents]);
  useEffect(() => {
    if (!issueKey) {
      setById({});
      return;
    }
    let cancelled = false;
    Promise.all(issueKey.split(",").map((issueId) => hostApi.listAttachments(issueId).catch(() => [] as HostAttachment[])))
      .then((lists) => {
        if (cancelled) return;
        setById(Object.fromEntries(lists.flat().map((a) => [a.id, a])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [issueKey]);
  return byId;
}

function BusinessDetailView({
  detail,
  companyPrefix,
  companyId,
  onChanged,
}: {
  detail: BusinessDetail;
  companyPrefix: string | null;
  companyId: string;
  onChanged: () => void;
}) {
  const { business, documents, filings, links, history, today } = detail;
  const docTitles = useMemo(() => Object.fromEntries(documents.map((d) => [d.id, d.title])), [documents]);
  const attachments = useAttachments(documents);
  const [editing, setEditing] = useState<Editing>(null);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // A different business closes any open form.
  useEffect(() => setEditing(null), [business.id]);
  const edit: EditProps = {
    companyId,
    editing,
    setEditing,
    onSaved: () => {
      setEditing(null);
      onChanged();
    },
  };
  const facts = [
    business.legalForm,
    business.formationState ? `formed in ${business.formationState}` : null,
    business.taxClassification
      ? `taxed as ${business.taxClassification}${business.taxClassificationEffective ? ` since ${formatDate(business.taxClassificationEffective)}` : ""}`
      : null,
    business.taxIdLast4 ? `tax id ending ${business.taxIdLast4}` : null,
  ].filter(Boolean);
  if (editing?.kind === "business") {
    return (
      <BusinessForm
        companyId={companyId}
        business={business}
        onSaved={edit.onSaved}
        onCancel={() => setEditing(null)}
      />
    );
  }
  return (
    <div className="space-y-4">
      <header>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold text-foreground">{business.name}</h2>
          <Button variant="outline" size="xs" onClick={() => setEditing({ kind: "business" })}>
            Edit details
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {humanize(business.relationship)}
          {facts.length > 0 ? `, ${facts.join(", ")}` : ""}
          {business.otherNames.length > 0 ? `. Also trading as ${business.otherNames.join(", ")}` : ""}
        </p>
        {business.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{business.notes}</p>}
      </header>
      <StatusesPart business={business} documents={documents} docTitles={docTitles} {...edit} />
      <FilingsPart
        business={business}
        filings={filings}
        documents={documents}
        today={today}
        companyPrefix={companyPrefix}
        {...edit}
      />
      <DocumentsPart
        business={business}
        documents={documents}
        links={links}
        attachments={attachments}
        today={today}
        onView={setViewerIndex}
        {...edit}
      />
      <LinksPart links={links} companyPrefix={companyPrefix} today={today} />
      <HistoryPart history={history} />
      {viewerIndex !== null && (
        <DocumentViewer
          documents={documents}
          attachments={attachments}
          index={viewerIndex}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
        />
      )}
    </div>
  );
}

// ---- Page ----

export function CorporateOperationsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const companyId = host.companyId;
  const companyPrefix = host.companyPrefix;

  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [businesses, setBusinesses] = useState<BusinessApi[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => readBusinessFromUrl());
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<Date | null>(null);
  const [addingBusiness, setAddingBusiness] = useState(false);
  // Bumped to make every fetch run again (the Refresh button and regaining focus).
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((n) => n + 1), []);

  useEffect(() => {
    if (!companyId) return;
    setOverviewLoading(true);
    recordsApi
      .overview(companyId)
      .then((o) => {
        setOverview(o);
        setRefreshedAt(new Date());
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setOverviewLoading(false));
  }, [companyId, refreshTick]);

  useEffect(() => {
    if (!companyId) return;
    setListLoading(true);
    const timer = setTimeout(() => {
      recordsApi
        .list(companyId, query.trim())
        .then((r) => setBusinesses(r.businesses))
        .catch((err: Error) => setError(err.message))
        .finally(() => setListLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [companyId, query, refreshTick]);

  useEffect(() => {
    if (!companyId || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    recordsApi
      .get(companyId, selectedId)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setDetail(null);
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyId, selectedId, refreshTick]);

  // The agent changes records while this page sits open, so pick up its work
  // when the tab comes back into view rather than waiting for a reload.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const open = useCallback((id: string) => {
    setSelectedId(id);
    writeBusinessToUrl(id);
  }, []);

  const attention = useMemo(() => (overview ? attentionByBusiness(overview) : {}), [overview]);
  const nothingOnRecord = !listLoading && businesses.length === 0 && query.trim() === "";

  if (!companyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to see its business records.</div>;
  }

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-foreground">Corporate Operations</h1>
          <p className="text-sm text-muted-foreground">
            Every business you own, are starting, closing or looking at: its records, documents and tax filings. The
            Corporate Operations agent keeps this up to date, and you can change anything here. Either way, a document
            on file is needed before a business can be marked formed or closed, or a filing done.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {refreshedAt && <span>Updated {formatDateTime(refreshedAt).replace(/^.*, /, "")}</span>}
          <Button variant="outline" size="sm" onClick={refresh} disabled={overviewLoading || listLoading || detailLoading}>
            Refresh
          </Button>
        </div>
      </header>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {nothingOnRecord && !addingBusiness ? (
        <EmptyState title="No businesses on record yet">
          <p>
            Add one here, or ask the Corporate Operations agent, for example "Add Example Widgets LLC, a Pennsylvania
            LLC we own".
          </p>
          <div className="mt-3">
            <Button size="sm" onClick={() => setAddingBusiness(true)}>
              Add a business
            </Button>
          </div>
        </EmptyState>
      ) : (
        <>
          <NeedsAttention overview={overview} loading={overviewLoading} onOpen={open} />

          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-2">
              <Button variant="outline" size="sm" className="w-full" onClick={() => setAddingBusiness(true)} disabled={addingBusiness}>
                Add a business
              </Button>
              <Input
                type="search"
                placeholder="Search businesses"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search businesses"
              />
              <BusinessList
                businesses={businesses}
                attention={attention}
                selectedId={selectedId}
                onSelect={open}
                loading={listLoading}
                searching={query.trim() !== ""}
              />
            </aside>
            <main className="min-w-0">
              {addingBusiness ? (
                <BusinessForm
                  companyId={companyId}
                  onSaved={(id) => {
                    setAddingBusiness(false);
                    open(id);
                    refresh();
                  }}
                  onCancel={() => setAddingBusiness(false)}
                />
              ) : (
                <>
                  {detailLoading && !detail && <Empty>Loading...</Empty>}
                  {detail && (
                    <BusinessDetailView detail={detail} companyPrefix={companyPrefix} companyId={companyId} onChanged={refresh} />
                  )}
                </>
              )}
              {!addingBusiness && !detailLoading && !detail && (
                <EmptyState title="Pick a business">Its statuses, filings, documents, linked cases and history show here.</EmptyState>
              )}
            </main>
          </div>
        </>
      )}
    </div>
  );
}
