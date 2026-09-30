import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { IntakeError, type Config } from "./routing.js";
import { ownedCase, resolveInteractiveTarget } from "./interactive-support.js";
import { diagnosticScript } from "./diagnostic-catalog.js";

export const repairRecipes = [
  { id: "start_service", title: "Start an exact service", options: ["service"], disruption: "Starts the selected service and its required dependencies." },
  { id: "restart_service", title: "Restart an exact service", options: ["service"], disruption: "Interrupts work handled by that service. Refuses a restart that requires forcing dependent services." },
  { id: "restart_spooler", title: "Restart the print spooler", options: [], disruption: "Briefly interrupts all printing on this computer. Keeps queued jobs." },
  { id: "flush_dns", title: "Flush the client DNS cache", options: ["testTarget"], disruption: "Clears cached name results; lookups must be repeated. Verification resolves the specified company hostname." },
  { id: "refresh_computer_policy", title: "Refresh computer Group Policy", options: [], disruption: "Reapplies existing computer policy. Policy extensions may change software/settings. No restart/logoff is requested." },
  { id: "restart_print_job", title: "Restart one print job", options: ["printer", "jobId", "submittedAtUtc"], disruption: "Can produce duplicate printed pages. Requires the exact queue, job ID and observed submission timestamp." },
  { id: "cancel_print_job", title: "Cancel one print job", options: ["printer", "jobId", "submittedAtUtc"], disruption: "Cancels that document irreversibly. It must be resubmitted from the originating application." },
] as const;

function validatedOptions(operation: string, input: unknown) {
  const recipe = repairRecipes.find(item => item.id === operation);
  if (!recipe) throw new IntakeError(422, "Choose a repair recipe from support_list_capabilities");
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new IntakeError(422, "Repair options must be an object");
  const raw = (input ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!(recipe.options as readonly string[]).includes(key)) throw new IntakeError(422, `Option ${key} does not apply to ${operation}`);
  const values: Record<string, string | number> = {};
  for (const key of recipe.options) {
    const value = raw[key];
    if (key === "jobId") {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) throw new IntakeError(422, "jobId must be a positive integer");
      values[key] = value;
    } else {
      if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f]/.test(value)) throw new IntakeError(422, `${key} is required (maximum 200 characters)`);
      if (key === "service" && !/^[a-z0-9_.-]+$/i.test(value)) throw new IntakeError(422, "Use the exact service name without wildcards");
      if (key === "submittedAtUtc" && !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value)) throw new IntakeError(422, "Use the observed UTC ISO submission timestamp");
      values[key] = value.trim();
    }
  }
  return { recipe, values };
}
const serviceLookup = "$service = Get-Service | Where-Object { $_.Name -eq [string]$SupportOptions.service }\nif (-not $service) { throw 'Exact service was not found' }";
const jobLookup = "$queue = Get-Printer | Where-Object { $_.Name -eq [string]$SupportOptions.printer }\nif (-not $queue) { throw 'Exact printer was not found' }\n$job = Get-PrintJob -PrinterName $queue.Name -ID ([int]$SupportOptions.jobId) -ErrorAction SilentlyContinue";
export function buildRepairRecipe(operation: string, input: unknown) {
  const { recipe, values } = validatedOptions(operation, input);
  let script: string; let verification: string; let recovery: string;
  if (["start_service", "restart_service", "restart_spooler"].includes(operation)) {
    if (operation === "restart_spooler") values.service = "Spooler";
    const command = operation === "start_service" ? "Start-Service" : "Restart-Service";
    script = `${serviceLookup}\n$service | ${command} -ErrorAction Stop\n$service.WaitForStatus('Running',[TimeSpan]::FromSeconds(20))`;
    verification = `${serviceLookup}\nif ($service.Status -ne 'Running') { throw 'Service is not running' }`;
    recovery = "Service configuration is unchanged. Inspect service/event logs if it fails. A restart cannot restore interrupted requests; check the original symptom and queued work. No forced dependency restart or queue deletion is performed.";
  } else if (operation === "flush_dns") {
    script = "Clear-DnsClientCache -ErrorAction Stop";
    verification = "$records = @(Resolve-DnsName -Name ([string]$SupportOptions.testTarget) -DnsOnly -ErrorAction Stop)\nif (-not $records.Count) { throw 'No DNS answer' }";
    recovery = "DNS cache entries cannot be restored; normal lookups repopulate them. No adapter, DNS server, route or firewall configuration is changed. A successful lookup alone does not verify the original application symptom.";
  } else if (operation === "refresh_computer_policy") {
    script = "$result = & gpupdate.exe /target:computer /force /wait:30 2>&1\nif ($LASTEXITCODE -ne 0) { throw 'Policy refresh did not report success' }";
    verification = "$result = & gpresult.exe /scope computer /r 2>&1\nif ($LASTEXITCODE -ne 0) { throw 'Resultant policy could not be read' }";
    recovery = "This reapplies existing policy and may change settings through policy extensions. Restore affected settings through an approved GPO/configuration backup when required. No new GPO or forced restart is created. Successful gpresult is not proof that a specific setting applied; inspect resultant policy afterward.";
  } else {
    script = `${jobLookup}\nif (-not $job -or $job.SubmittedTime.ToUniversalTime().ToString('o') -ne [string]$SupportOptions.submittedAtUtc) { throw 'Print job identity changed; inspect the queue again' }\n${operation === "cancel_print_job" ? "Remove" : "Restart"}-PrintJob -PrinterName $queue.Name -ID $job.ID -ErrorAction Stop`;
    verification = `${jobLookup}\n` + (operation === "cancel_print_job"
      ? "if ($job -and $job.SubmittedTime.ToUniversalTime().ToString('o') -eq [string]$SupportOptions.submittedAtUtc) { throw 'Original print job is still queued' }"
      : "if ($job -and $job.SubmittedTime.ToUniversalTime().ToString('o') -eq [string]$SupportOptions.submittedAtUtc -and [string]$job.JobStatus -match 'Error|Blocked|Offline|PaperOut') { throw 'Print job still has an error' }");
    recovery = operation === "cancel_print_job" ? "Cancellation cannot be undone. Resubmit the document from its originating application; the support tool does not retain its contents."
      : "A restarted job can duplicate pages. Confirm physical output with the person and cancel an unwanted duplicate only after reviewing its current identity. Job disappearance alone is not proof that paper was printed.";
  }
  return { recipe, script: diagnosticScript(`$ErrorActionPreference = 'Stop'\n${script}`, values),
    verificationScript: diagnosticScript(`$ErrorActionPreference = 'Stop'\n${verification}`, values), recoveryNotes: recovery,
    expectedEffect: recipe.title, disruption: recipe.disruption };
}

export async function prepareRepair(ctx: PluginContext, cfg: Config, run: ToolRunContext, input: Record<string, unknown>) {
  if (run.userPermission !== "support:repair") throw new IntakeError(403, "Repair permission required");
  const supportCase = await ownedCase(ctx, cfg, run, input.caseId);
  if (supportCase.status === "resolved") throw new IntakeError(409, "Case is resolved; review it before a new repair");
  if (input.options !== undefined && (!input.options || typeof input.options !== "object" || Array.isArray(input.options))) throw new IntakeError(422, "Repair options must be an object");
  const options = { ...((input.options ?? {}) as Record<string, unknown>) };
  if (input.operation === "flush_dns") options.testTarget = resolveInteractiveTarget(cfg, run.companyId, options.testTarget);
  const prepared = buildRepairRecipe(input.operation as string, options);
  const { recipe, disruption, ...parameters } = prepared;
  return { operation: recipe.id, disruption, repair: { caseId: supportCase.id, target: supportCase.target_address, expectedReviewVersion: supportCase.review_version, ...parameters },
    instruction: "Prepared only; nothing was executed or approved. Confirm diagnosis and applicability, explain disruption/recovery, then pass the exact repair object to support_run_repair or the actively delegated repair tool. The host still checks consent. Verification covers the stated check, not every possible cause." };
}
