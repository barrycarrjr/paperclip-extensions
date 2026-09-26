import { useCallback, useEffect, useMemo, useState } from "react";
import { useHostContext, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { BusinessApi, DocumentApi, FilingApi, HistoryApi, LinkApi, StatusField } from "../domain.js";
import { Badge, Button, Dot, Empty, EmptyState, ErrorBanner, Input, Section, cn } from "./_primitives.js";
import { recordsApi, type BusinessDetail, type Overview } from "./api.js";
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

function StatusesPart({ business, docTitles }: { business: BusinessApi; docTitles: Record<string, string> }) {
  if (allStatusesUnknown(business)) {
    return (
      <Section title="Statuses">
        <Empty>
          No status has been proven from a document yet. The agent sets these from documents on file: the state's
          approval for legal status, the tax id letter for the tax account, a dissolution certificate or closure
          letter when a business closes.
        </Empty>
      </Section>
    );
  }
  return (
    <Section title="Statuses">
      <dl className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as StatusField[]).map((field) => {
          const s = business.statuses[field];
          return (
            <div key={field} className="space-y-0.5">
              <dt className="text-xs text-muted-foreground">{STATUS_LABELS[field]}</dt>
              <dd className="text-sm font-medium">{humanize(s.value)}</dd>
              <dd className="text-xs text-muted-foreground">{s.asOf ? `As of ${formatDate(s.asOf)}` : "No as-of date"}</dd>
              <dd className="text-xs text-muted-foreground">Source: {describeSource(s.source, docTitles)}</dd>
            </div>
          );
        })}
      </dl>
    </Section>
  );
}

function DocumentsPart({
  documents,
  today,
  companyPrefix,
}: {
  documents: DocumentApi[];
  today: string;
  companyPrefix: string | null;
}) {
  return (
    <Section title="Documents" count={documents.length}>
      {documents.length === 0 ? (
        <Empty>No documents on file. Attach files to the business's records issue and the agent will index them here.</Empty>
      ) : (
        <ul className="divide-y divide-border">
          {documents.map((d) => {
            const tone = renewalTone(d.renewalDate, today);
            return (
              <li key={d.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <a href={issueHref(companyPrefix, d.issueId)} className="font-medium hover:underline">
                    {d.title}
                  </a>
                  <div className="text-xs text-muted-foreground">
                    {humanize(d.docType)}
                    {d.issuingBody ? ` from ${d.issuingBody}` : ""}
                    {d.documentDate ? `, dated ${formatDate(d.documentDate)}` : ""}
                    {d.attachmentRef ? `, file ${d.attachmentRef}` : ""}
                  </div>
                </div>
                {d.renewalDate && (
                  <Badge tone={tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}>{describeRenewal(d.renewalDate, today)}</Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

function FilingsPart({
  filings,
  today,
  companyPrefix,
}: {
  filings: FilingApi[];
  today: string;
  companyPrefix: string | null;
}) {
  const sorted = sortFilingsByDue(filings);
  return (
    <Section title="Filings" count={filings.length}>
      {sorted.length === 0 ? (
        <Empty>No filings on the calendar yet. Ask the agent what this business has to file and it will build the list.</Empty>
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
                <div className="text-xs text-muted-foreground">
                  {f.status === "not_required"
                    ? `Not required: ${f.notRequiredReason ?? ""}`
                    : f.proofDocumentId
                      ? `Proof on file: ${f.proofTitle ?? f.proofDocumentId}`
                      : "No proof on file"}
                </div>
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

function BusinessDetailView({ detail, companyPrefix }: { detail: BusinessDetail; companyPrefix: string | null }) {
  const { business, documents, filings, links, history, today } = detail;
  const docTitles = useMemo(() => Object.fromEntries(documents.map((d) => [d.id, d.title])), [documents]);
  const facts = [
    business.legalForm,
    business.formationState ? `formed in ${business.formationState}` : null,
    business.taxClassification
      ? `taxed as ${business.taxClassification}${business.taxClassificationEffective ? ` since ${formatDate(business.taxClassificationEffective)}` : ""}`
      : null,
    business.taxIdLast4 ? `tax id ending ${business.taxIdLast4}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-foreground">{business.name}</h2>
        <p className="text-sm text-muted-foreground">
          {humanize(business.relationship)}
          {facts.length > 0 ? `, ${facts.join(", ")}` : ""}
          {business.otherNames.length > 0 ? `. Also trading as ${business.otherNames.join(", ")}` : ""}
        </p>
        {business.notes && <p className="mt-2 whitespace-pre-wrap text-sm text-foreground">{business.notes}</p>}
      </header>
      <StatusesPart business={business} docTitles={docTitles} />
      <FilingsPart filings={filings} today={today} companyPrefix={companyPrefix} />
      <DocumentsPart documents={documents} today={today} companyPrefix={companyPrefix} />
      <LinksPart links={links} companyPrefix={companyPrefix} today={today} />
      <HistoryPart history={history} />
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
            Corporate Operations agent keeps this up to date and must cite a document on file before it can mark a
            business formed or closed, or a filing done.
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

      {nothingOnRecord ? (
        <EmptyState title="No businesses on record yet">
          Ask the Corporate Operations agent to add one, for example "Add Example Widgets LLC, a Pennsylvania LLC we
          own", or drop a business document into its chat and it will file it. Nothing on this page is edited by hand.
        </EmptyState>
      ) : (
        <>
          <NeedsAttention overview={overview} loading={overviewLoading} onOpen={open} />

          <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            <aside className="space-y-2">
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
              {detailLoading && !detail && <Empty>Loading...</Empty>}
              {detail && <BusinessDetailView detail={detail} companyPrefix={companyPrefix} />}
              {!detailLoading && !detail && (
                <EmptyState title="Pick a business">Its statuses, filings, documents, linked cases and history show here.</EmptyState>
              )}
            </main>
          </div>
        </>
      )}
    </div>
  );
}
