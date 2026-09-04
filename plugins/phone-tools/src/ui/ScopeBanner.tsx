import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { describeAccountReach, type AccountScopeSummary } from "../accountScope.js";

/**
 * Says which PBX account is behind this page, and who else it serves.
 *
 * The host project's scope document lists "Shared service/account" as its own
 * kind of scope, with the rule: show the real account/location scope
 * alongside the current company filter. Every other page in Paperclip is
 * company-bound, so a page opened inside a company reads as being about that
 * company. A PBX account allow-listed to every company breaks that
 * expectation silently, and until now nothing on screen said so.
 *
 * Renders nothing at all when every account this company can reach belongs to
 * it alone. There is nothing to disclose then, and a banner that always
 * appears is one people stop reading.
 */
export function ScopeBanner() {
  const host = useHostContext();
  const { data, loading } = usePluginData<AccountScopeSummary>("phone.account-scope", {
    companyId: host.companyId,
  });

  // Quiet while loading and quiet on failure: this is a disclosure, and an
  // error box in its place would be noise on a page that is working. The
  // absence of the banner never means "private" — it means nothing shared was
  // found, and a failed read simply says nothing either way.
  if (loading || !data || !data.anyShared) return null;

  const shared = data.accounts.filter((entry) => entry.reach !== "this-company-only");

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        padding: "8px 12px",
        marginBottom: 12,
        borderRadius: 8,
        border: "1px solid rgba(217, 119, 6, 0.35)",
        background: "rgba(217, 119, 6, 0.08)",
        fontSize: 13,
        lineHeight: 1.45,
      }}
      role="note"
    >
      <span aria-hidden style={{ flexShrink: 0 }}>🔗</span>
      <div>
        <strong style={{ fontWeight: 600 }}>
          This is a shared phone {shared.length === 1 ? "account" : "service"}.
        </strong>{" "}
        <span>
          What you see here is not limited to the company you are in.
        </span>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {shared.map((entry) => (
            <li key={entry.key}>
              <code style={{ fontFamily: "monospace" }}>{entry.key}</code>
              {entry.name && entry.name !== entry.key ? ` (${entry.name})` : ""} —{" "}
              {describeAccountReach(entry)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
