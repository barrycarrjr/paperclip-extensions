import { IntakeError } from "./routing.js";

export const diagnosticChecks = [
  { id: "connectivity", title: "Connection from the support host", script: null, description: "DNS and remote-management TCP ports from the Paperclip host." },
  { id: "inventory", title: "Hardware and available tools", script: "Get-SupportInventory.ps1", description: "Windows build, hardware, domain, PowerShell, and available administrative modules. Saves a company device snapshot." },
  { id: "health", title: "Windows health snapshot", script: "Get-SupportHealth.ps1", description: "One read-only snapshot of inventory, CPU/memory, disk space, stopped services, recent System event metadata, restart indicators and Windows queues. Each unavailable section is explicit. Does not establish overall health or run repairs." },
  { id: "performance", title: "Current CPU and memory", script: "Get-SupportPerformance.ps1", description: "One CPU/memory/process sample." },
  { id: "performance_trace", title: "Performance over time", script: "Get-SupportPerformanceTrace.ps1", description: "Six CPU/memory samples over 15 seconds; no persistent tracing." },
  { id: "storage", title: "Disk space", script: "Get-SupportStorage.ps1", description: "Capacity and free space of local disks." },
  { id: "services", title: "Stopped automatic services", script: "Get-SupportServices.ps1", description: "Stopped automatic services, not proof of a fault." },
  { id: "events", title: "Event logs", script: "Get-SupportEvents.ps1", description: "Bounded recent errors/warnings in System, Application, Group Policy or PrintService logs. Options: log, hours, limit." },
  { id: "network", title: "Network configuration", script: "Get-SupportNetwork.ps1", description: "Adapters, addresses, DNS, default routes and firewall profiles. Optional testTarget and port test from the workstation within company access groups." },
  { id: "printers", title: "Printers and queues", script: "Get-SupportPrinters.ps1", description: "Spooler, printer status, drivers, ports and job counts; optional exact printer queue and job IDs. Does not read document contents." },
  { id: "group_policy", title: "Applied computer Group Policy", script: "Get-SupportGroupPolicy.ps1", description: "Computer gpresult, applied GPOs when RSAT is present, and recent Group Policy errors. Does not assume the support account is the affected user." },
  { id: "directory", title: "Domain and Active Directory", script: "Get-SupportDirectory.ps1", description: "Domain membership, time synchronization and secure channel; domain/controller and optional exact user account metadata when RSAT is installed. Never tests/repairs trust on a domain controller." },
  { id: "software", title: "Installed applications", script: "Get-SupportSoftware.ps1", description: "Up to 80 application name/version/vendor entries from uninstall registry keys. Never queries Win32_Product." },
  { id: "updates", title: "Update and restart status", script: "Get-SupportUpdates.ps1", description: "Recent hotfixes, update service status and pending restart indicators. Does not initiate updates." },
  { id: "tasks", title: "Scheduled task health", script: "Get-SupportTasks.ps1", description: "Up to 30 enabled scheduled tasks with a nonzero last result. Does not expose task command arguments." },
  { id: "certificates", title: "Machine certificate expiration", script: "Get-SupportCertificates.ps1", description: "Up to 40 expired/soon-expiring machine certificates; metadata only, never exports keys." },
  { id: "shares", title: "File shares and permissions", script: "Get-SupportShares.ps1", description: "Local SMB share names and optional exact share access entries. Does not read files or enumerate remote shares." },
] as const;

export type DiagnosticCheck = typeof diagnosticChecks[number]["id"];
export const diagnosticIds = diagnosticChecks.map(check => check.id);
const optionKeys = new Set(["log", "hours", "limit", "printer", "testTarget", "port", "userIdentity", "share"]);

export function validateDiagnosticOptions(check: string, raw: unknown): Record<string, string | number> {
  if (!diagnosticIds.includes(check as DiagnosticCheck)) throw new IntakeError(422, "Choose a check from support_list_capabilities");
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new IntakeError(422, "Diagnostic options must be an object");
  const input = raw as Record<string, unknown>;
  const allowed: Record<string, string[]> = { events: ["log", "hours", "limit"], network: ["testTarget", "port"], printers: ["printer"], directory: ["userIdentity"], shares: ["share"] };
  for (const key of Object.keys(input)) if (!optionKeys.has(key) || !allowed[check]?.includes(key)) throw new IntakeError(422, `Option ${key} does not apply to ${check}`);
  const result: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(input)) {
    if (["hours", "limit", "port"].includes(key)) {
      const max = key === "hours" ? 168 : key === "limit" ? 30 : 65535;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) throw new IntakeError(422, `${key} must be an integer from 1 to ${max}`);
    } else if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) {
      throw new IntakeError(422, `${key} must be a nonempty name of at most 200 characters`);
    }
    result[key] = typeof value === "string" ? value.trim() : value as number;
  }
  if (result.log && !["System", "Application", "GroupPolicy", "PrintService"].includes(result.log as string)) throw new IntakeError(422, "Choose System, Application, GroupPolicy or PrintService");
  if (result.port && !result.testTarget) throw new IntakeError(422, "A port test needs testTarget");
  return result;
}

/** Values are data, never interpolated PowerShell expressions or command arguments. */
export function diagnosticScript(script: string, options: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(options), "utf8").toString("base64");
  return `$SupportOptions = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json\n${script}`;
}
