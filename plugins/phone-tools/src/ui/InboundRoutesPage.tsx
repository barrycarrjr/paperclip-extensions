import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  Badge,
  EmptyState,
  ErrorBanner,
  PageContainer,
  PageHeader,
  Table,
  Td,
  Th,
} from "./common.js";

/**
 * Inbound routes page — DID → assistant mapping. Today this is a
 * read-only listing of allow-listed numbers per account, surfaced from
 * the engine's `listNumbers` plus the per-account `defaultAssistantId`.
 *
 * Routes:
 *   - Vapi: numbers come from the engine; the assistant they route to is
 *     either the account-level default OR (in v0.6.x) a per-DID mapping
 *     that lands when the inbound-routes mutation API ships.
 *   - DIY: phone numbers live in Jambonz; the slot-to-assistant mapping
 *     happens inside `engine.handleCallHook` (currently a stub for true
 *     inbound — outbound is the verified path).
 *
 * "Coming soon" rows: routes flagged for the v0.6.x mutation surface
 * render as read-only until the create/update routes ship. The page
 * shape is stable so the next slice just adds buttons and a wizard.
 */

interface InboundRoute {
  numberId: string;
  e164: string;
  label?: string;
  assistantId?: string;
  assistantName?: string;
  engine: "vapi" | "diy";
  accountKey: string;
}
interface InboundRoutesResponse {
  routes: InboundRoute[];
  error?: string;
}

export function InboundRoutesPage(_props: PluginPageProps) {
  const host = useHostContext();
  const { data, loading } = usePluginData<InboundRoutesResponse>(
    "phone.inbound-routes",
    { companyId: host.companyId },
  );

  const routes = data?.routes ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Inbound routes"
        subtitle={
          loading
            ? "loading…"
            : `${routes.length} inbound number${routes.length === 1 ? "" : "s"} mapped`
        }
      />
      {data?.error ? <ErrorBanner message={data.error} /> : null}
      {!loading && !data?.error && routes.length === 0 ? (
        <EmptyState>
          No inbound numbers configured for this company. Configure a
          phone number on Vapi or Jambonz, then return here to see it
          show up.
        </EmptyState>
      ) : null}
      {routes.length > 0 ? (
        <Table>
          <thead>
            <tr>
              <Th>Number</Th>
              <Th>Label</Th>
              <Th>Routes to</Th>
              <Th>Engine</Th>
              <Th>Account</Th>
            </tr>
          </thead>
          <tbody>
            {routes.map((r) => (
              <tr key={`${r.engine}:${r.numberId}`}>
                <Td mono>{r.e164}</Td>
                <Td>{r.label ?? "—"}</Td>
                <Td>{r.assistantName ?? r.assistantId ?? "—"}</Td>
                <Td>
                  <Badge tone={r.engine === "vapi" ? "blue" : "green"}>{r.engine}</Badge>
                </Td>
                <Td mono>{r.accountKey}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : null}

      <div
        style={{
          marginTop: 24,
          padding: 14,
          background: "rgba(80, 140, 220, 0.08)",
          border: "1px solid rgba(80, 140, 220, 0.25)",
          borderRadius: 6,
          fontSize: 12,
          opacity: 0.85,
        }}
      >
        <strong>Inbound routing UX is in v0.6.x.</strong> Today the
        assistant a number routes to is set at the account level
        (<code>defaultAssistantId</code> on the phone-tools account
        settings). A per-DID mapping with business-hours + voicemail-drop
        fallback lands in the next slice — at that point this page
        becomes editable and gets a "+ Add route" wizard.
      </div>
    </PageContainer>
  );
}
