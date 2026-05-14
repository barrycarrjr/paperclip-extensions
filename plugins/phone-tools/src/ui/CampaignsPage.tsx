import { useEffect, useState, type CSSProperties } from "react";
import { useHostContext, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { CampaignsList } from "./CampaignsList.js";
import { CampaignDetail } from "./CampaignDetail.js";
import { CampaignWizard } from "./CampaignWizard.js";
import { PortfolioRollup } from "./PortfolioRollup.js";

/**
 * Top-level Campaigns page (v0.5.1).
 *
 * Mounted at /<companyPrefix>/campaigns by the host (via the page slot's
 * routePath), this page owns its own internal navigation between three
 * sub-views:
 *
 *   - list:    table of all campaigns with status filter + new button
 *   - detail:  single-campaign view with counters + leads + actions
 *   - new:     creation wizard with inline compliance preflight
 *
 * The host doesn't expose a router for plugin-internal routes, so we
 * thread state via React useState and reflect it in window.location.search
 * so back/forward + page reload preserve the view. Cheap; works.
 */
export function CampaignsPage(_props: PluginPageProps) {
  const host = useHostContext();
  const [view, setView] = useState<View>(() => readViewFromUrl());
  const [refreshKey, setRefreshKey] = useState(0);

  // Reflect view in URL so deep-links + browser back work.
  useEffect(() => {
    writeViewToUrl(view);
  }, [view]);

  // Listen for browser back/forward.
  useEffect(() => {
    const onPop = () => setView(readViewFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (!host.companyId) {
    return (
      <div style={{ padding: 24 }}>
        <p style={muted}>No company in context.</p>
      </div>
    );
  }
  const companyId = host.companyId;

  function refresh() {
    setRefreshKey((k) => k + 1);
  }

  return (
    <div style={pageRoot}>
      <header style={pageHeader}>
        <button
          type="button"
          onClick={() => setView({ kind: "list" })}
          style={breadcrumbButton}
          disabled={view.kind === "list"}
        >
          📋 Campaigns
        </button>
        {view.kind === "detail" && (
          <>
            <span style={muted}>›</span>
            <span>Detail</span>
          </>
        )}
        {view.kind === "new" && (
          <>
            <span style={muted}>›</span>
            <span>New campaign</span>
          </>
        )}
        {view.kind === "portfolio" && (
          <>
            <span style={muted}>›</span>
            <span>Portfolio rollup</span>
          </>
        )}
        {view.kind === "list" && (
          <button
            type="button"
            onClick={() => setView({ kind: "portfolio" })}
            style={{ ...breadcrumbButton, marginLeft: "auto", fontWeight: 400, fontSize: 12 }}
            title="Cross-LLC view of every company's campaign activity. Most useful from HQ / portfolio root."
          >
            🌐 Portfolio rollup
          </button>
        )}
      </header>

      {view.kind === "list" && (
        <CampaignsList
          key={refreshKey}
          companyId={companyId}
          onSelect={(id) => setView({ kind: "detail", campaignId: id })}
          onNew={() => setView({ kind: "new" })}
        />
      )}
      {view.kind === "detail" && (
        <CampaignDetail
          key={`${view.campaignId}:${refreshKey}`}
          campaignId={view.campaignId}
          companyId={companyId}
          onBack={() => setView({ kind: "list" })}
          onChanged={refresh}
        />
      )}
      {view.kind === "new" && (
        <CampaignWizard
          companyId={companyId}
          onCancel={() => setView({ kind: "list" })}
          onCreated={(id) => setView({ kind: "detail", campaignId: id })}
        />
      )}
      {view.kind === "portfolio" && (
        <PortfolioRollup companyId={companyId} onBack={() => setView({ kind: "list" })} />
      )}
    </div>
  );
}

type View =
  | { kind: "list" }
  | { kind: "detail"; campaignId: string }
  | { kind: "new" }
  | { kind: "portfolio" };

function readViewFromUrl(): View {
  if (typeof window === "undefined") return { kind: "list" };
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1") return { kind: "new" };
  if (params.get("portfolio") === "1") return { kind: "portfolio" };
  const id = params.get("id");
  if (id) return { kind: "detail", campaignId: id };
  return { kind: "list" };
}

function writeViewToUrl(view: View): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete("new");
  url.searchParams.delete("id");
  url.searchParams.delete("portfolio");
  if (view.kind === "new") url.searchParams.set("new", "1");
  if (view.kind === "detail") url.searchParams.set("id", view.campaignId);
  if (view.kind === "portfolio") url.searchParams.set("portfolio", "1");
  window.history.replaceState({}, "", url.toString());
}

const pageRoot: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  padding: 24,
  maxWidth: 1100,
  margin: "0 auto",
};

const pageHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
};

const muted: CSSProperties = { color: "var(--muted-foreground)" };

const breadcrumbButton: CSSProperties = {
  appearance: "none",
  border: "none",
  background: "transparent",
  color: "inherit",
  padding: 0,
  fontSize: 14,
  cursor: "pointer",
  fontWeight: 600,
};
