export type PermissionState = { allowed: boolean | null; error?: string };
export async function checkSetupPermission(fetcher: typeof fetch, companyId: string, action: "diagnose" | "repair" | "respond"): Promise<PermissionState> {
  try {
    const response = await fetcher(`/api/plugins/customer-support/api/setup/permissions/${action}?companyId=${encodeURIComponent(companyId)}`, { credentials: "same-origin" });
    if (response.status === 403) return { allowed: false };
    if (!response.ok) return { allowed: null, error: `Permission check returned HTTP ${response.status}.` };
    const body = await response.json() as { allowed?: unknown; permission?: unknown };
    if (body.allowed !== true || body.permission !== `support:${action}`) return { allowed: null, error: "The host returned an unexpected permission result. Update Paperclip and Support Desk together." };
    return { allowed: true };
  } catch { return { allowed: null, error: "Permission check could not reach Paperclip. Refresh or sign in again." }; }
}
export function identitySummary(result: Record<string, unknown>) {
  if (result.status !== "succeeded") return "The identity check did not confirm a connection.";
  const method = ({ wmi_dcom_smb: "WMI / DCOM + SMB", winrm_https: "WinRM HTTPS", winrm_http: "WinRM HTTP" } as Record<string, string>)[String(result.transport)] ?? "the selected connection method";
  let identity = "";
  try {
    const data = JSON.parse(typeof result.output === "string" ? result.output : "{}");
    if (typeof data.identity === "string" && data.identity.length < 200) identity = ` as ${data.identity}`;
  } catch { /* Keep detailed output in the expandable technical result. */ }
  return `Connected to ${typeof result.target === "string" ? result.target : "the test computer"}${identity} using ${method}. This check did not diagnose or repair the computer.`;
}
