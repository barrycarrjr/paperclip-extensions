import { useCallback, useEffect, useMemo, useState } from "react";
import { useHostContext, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { BusinessApi, DocumentApi, FilingApi, HistoryApi, LinkApi, StatusField } from "../domain.js";
import { Badge, Empty, ErrorBanner, Input, Section, cn } from "./_primitives.js";
import { recordsApi, type BusinessDetail, type Overview } from "./api.js";
import {
  RENEWAL_WINDOW_DAYS,
  describeSource,
  humanize,
  isFilingOpen,
  isFilingOverdue,
  renewalTone,
  sortFilingsByDue,
} from "./format.js";

const STATUS_LABELS: Record<StatusField, string> = {
  operating: "Operating status",
  legal: "Legal status",
  tax_account: "Tax account status",
};

function issueHref(companyPrefix: string | null, issueId: string): string {
  return companyPrefix ? `/${companyPrefix}/issues/${issueId}` : `/issues/${issueId}`;
}

// ---- Needs attention ----

function NeedsAttention({
  overview,
  onOpen,
}: {
  overview: Overview | null;
  onOpen: (businessId: string) => void;
}) {
  if (!overview) return null;
  const { overdueFilings, filingsDueSoon, documentsRenewingSoon, today } = overview;
  const total = overdueFilings.length + filingsDueSoon.length + documentsRenewingSoon.length;
  return (
    <Section title="Needs attention" count={total}>
      {total === 0 ? (
        <Empty>Nothing overdue, nothing due in the next 30 days, no renewals in the next {RENEWAL_WINDOW_DAYS} days.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <h4 className="mb-1 text-xs font-semibold text-red-700 dark:text-red-300">
              Overdue, no proof of filing ({overdueFilings.length})
            </h4>
            {overdueFilings.length === 0 ? (
              <Empty>None.</Empty>
            ) : (
              <ul className="space-y-1">
                {overdueFilings.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="text-left text-red-700 hover:underline dark:text-red-300" onClick={() => onOpen(f.businessId)}>
                      {f.businessName}: {f.filing} ({f.periodLabel}), due {f.effectiveDueDate}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-foreground">Filings due in 30 days ({filingsDueSoon.length})</h4>
            {filingsDueSoon.length === 0 ? (
              <Empty>None.</Empty>
            ) : (
              <ul className="space-y-1">
                {filingsDueSoon.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="text-left hover:underline" onClick={() => onOpen(f.businessId)}>
                      {f.businessName}: {f.filing} ({f.periodLabel}), due {f.effectiveDueDate}, {humanize(f.status).toLowerCase()}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-1 text-xs font-semibold text-foreground">
              Renewals in {RENEWAL_WINDOW_DAYS} days ({documentsRenewingSoon.length})
            </h4>
            {documentsRenewingSoon.length === 0 ? (
              <Empty>None.</Empty>
            ) : (
              <ul className="space-y-1">
                {documentsRenewingSoon.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      className={cn("text-left hover:underline", renewalTone(d.renewalDate, today) === "bad" && "text-red-700 dark:text-red-300")}
                      onClick={() => onOpen(d.businessId)}
                    >
                      {d.businessName}: {d.title}, renews {d.renewalDate}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---- Business list ----

function BusinessList({
  businesses,
  selectedId,
  onSelect,
  loading,
}: {
  businesses: BusinessApi[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
}) {
  if (loading && businesses.length === 0) return <Empty>Loading...</Empty>;
  if (businesses.length === 0) return <Empty>No businesses on record.</Empty>;
  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {businesses.map((b) => (
        <li key={b.id}>
          <button
            type="button"
            onClick={() => onSelect(b.id)}
            className={cn(
              "block w-full px-3 py-2 text-left transition-colors",
              b.id === selectedId ? "bg-accent/50" : "hover:bg-accent/20",
            )}
          >
            <div className="truncate text-sm font-medium text-foreground">{b.name}</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {humanize(b.relationship)}, legal {humanize(b.statuses.legal.value).toLowerCase()}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

// ---- Business detail parts ----

function StatusesPart({ business, docTitles }: { business: BusinessApi; docTitles: Record<string, string> }) {
  return (
    <Section title="Statuses">
      <dl className="grid gap-3 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as StatusField[]).map((field) => {
          const s = business.statuses[field];
          return (
            <div key={field}>
              <dt className="text-xs text-muted-foreground">{STATUS_LABELS[field]}</dt>
              <dd className="text-sm font-medium">{humanize(s.value)}</dd>
              <dd className="text-xs text-muted-foreground">{s.asOf ? `as of ${s.asOf}` : "no as-of date"}</dd>
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
        <Empty>No documents on file.</Empty>
      ) : (
        <ul className="space-y-2">
          {documents.map((d) => {
            const tone = renewalTone(d.renewalDate, today);
            return (
              <li key={d.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <a href={issueHref(companyPrefix, d.issueId)} className="font-medium hover:underline">
                    {d.title}
                  </a>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {humanize(d.docType)}
                    {d.issuingBody ? `, ${d.issuingBody}` : ""}
                    {d.documentDate ? `, dated ${d.documentDate}` : ""}
                    {d.attachmentRef ? `, file ${d.attachmentRef}` : ""}
                  </span>
                </div>
                {d.renewalDate && (
                  <Badge tone={tone === "bad" ? "bad" : tone === "warn" ? "warn" : "neutral"}>
                    {tone === "bad" ? "Lapsed" : "Renews"} {d.renewalDate}
                  </Badge>
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
        <Empty>No filings on the calendar.</Empty>
      ) : (
        <ul className="space-y-2">
          {sorted.map((f) => {
            const overdue = isFilingOverdue(f, today);
            return (
              <li key={f.id} className={cn("rounded-md px-2 py-1", overdue && "bg-red-500/10")}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className={cn("font-medium", overdue && "text-red-700 dark:text-red-300")}>
                    {f.filing} <span className="font-normal text-muted-foreground">({f.authority}, {f.periodLabel})</span>
                  </span>
                  <Badge tone={overdue ? "bad" : isFilingOpen(f) ? "neutral" : "good"}>{humanize(f.status)}</Badge>
                </div>
                <div className={cn("text-xs", overdue ? "text-red-700 dark:text-red-300" : "text-muted-foreground")}>
                  Due {f.effectiveDueDate}
                  {f.extendedDueDate ? ` (extended from ${f.dueDate})` : ""}
                  {overdue ? ", overdue" : ""}
                  {f.preparer ? `, prepared by ${humanize(f.preparer).toLowerCase()}` : ""}
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
                      ? `Proof: ${f.proofTitle ?? f.proofDocumentId}`
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

function LinksPart({ links, companyPrefix }: { links: LinkApi[]; companyPrefix: string | null }) {
  return (
    <Section title="Linked cases" count={links.length}>
      {links.length === 0 ? (
        <Empty>No linked issues.</Empty>
      ) : (
        <ul className="space-y-1">
          {links.map((l) => (
            <li key={l.issueId} className="flex flex-wrap items-baseline gap-2">
              <Badge>{l.role}</Badge>
              <a href={issueHref(companyPrefix, l.issueId)} className="hover:underline">
                {l.issue ? `${l.issue.identifier ? `${l.issue.identifier} ` : ""}${l.issue.title}` : l.issueId}
              </a>
              {l.issue && (
                <span className="text-xs text-muted-foreground">
                  {humanize(l.issue.status)}
                  {l.issue.dueDate ? `, due ${l.issue.dueDate}` : ""}
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
        <ul className="space-y-1">
          {history.map((h) => (
            <li key={h.id} className="text-xs">
              <span className="text-muted-foreground tabular-nums">{new Date(h.createdAt).toLocaleString()}</span>{" "}
              <span className="font-medium">{humanize(h.kind)}</span>{" "}
              {h.field ? <span>{humanize(h.field)}: </span> : null}
              {h.oldValue !== null && h.kind !== "document_added" ? <span>{h.oldValue} to </span> : null}
              <span>{h.newValue ?? ""}</span>
              {h.asOf ? <span className="text-muted-foreground"> (as of {h.asOf})</span> : null}
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
      ? `taxed as ${business.taxClassification}${business.taxClassificationEffective ? ` since ${business.taxClassificationEffective}` : ""}`
      : null,
    business.taxIdLast4 ? `tax id ending ${business.taxIdLast4}` : null,
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      <header>
        <h2 className="text-lg font-semibold text-foreground">{business.name}</h2>
        <p className="text-xs text-muted-foreground">
          {humanize(business.relationship)}
          {facts.length > 0 ? `, ${facts.join(", ")}` : ""}
          {business.otherNames.length > 0 ? `. Also trading as ${business.otherNames.join(", ")}` : ""}
        </p>
        {business.notes && <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{business.notes}</p>}
      </header>
      <StatusesPart business={business} docTitles={docTitles} />
      <DocumentsPart documents={documents} today={today} companyPrefix={companyPrefix} />
      <FilingsPart filings={filings} today={today} companyPrefix={companyPrefix} />
      <LinksPart links={links} companyPrefix={companyPrefix} />
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
  const [businesses, setBusinesses] = useState<BusinessApi[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BusinessDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!companyId) return;
    recordsApi
      .overview(companyId)
      .then(setOverview)
      .catch((err: Error) => setError(err.message));
  }, [companyId]);

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
  }, [companyId, query]);

  const open = useCallback(
    (id: string) => {
      if (!companyId) return;
      setSelectedId(id);
      setDetailLoading(true);
      recordsApi
        .get(companyId, id)
        .then(setDetail)
        .catch((err: Error) => {
          setDetail(null);
          setError(err.message);
        })
        .finally(() => setDetailLoading(false));
    },
    [companyId],
  );

  if (!companyId) {
    return <div className="p-6 text-sm text-muted-foreground">Select a company to see its business records.</div>;
  }

  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Corporate Operations</h1>
        <p className="text-xs text-muted-foreground">
          Business records, documents and filings. Changes are made by the Corporate Operations agent, which must cite
          a document on file before any closure, formation or filing is recorded.
        </p>
      </header>

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <NeedsAttention overview={overview} onOpen={open} />

      <div className="grid gap-4 md:grid-cols-[280px_1fr]">
        <aside className="space-y-2">
          <Input
            type="search"
            placeholder="Search businesses"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search businesses"
          />
          <BusinessList businesses={businesses} selectedId={selectedId} onSelect={open} loading={listLoading} />
        </aside>
        <main>
          {detailLoading && <Empty>Loading...</Empty>}
          {!detailLoading && detail && <BusinessDetailView detail={detail} companyPrefix={companyPrefix} />}
          {!detailLoading && !detail && <Empty>Pick a business to see its statuses, documents, filings and history.</Empty>}
        </main>
      </div>
    </div>
  );
}
