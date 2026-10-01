type Section = { status?: string; data?: Record<string, unknown> };
const sectionNames = ["inventory", "performance", "storage", "services", "events", "updates", "printers"];
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter(item => item && typeof item === "object") : []; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
/** Observed conditions warrant investigation; a warning is not a diagnosed root cause. */
export function evaluateHealth(findings: Record<string, unknown>) {
  const sections = (findings.sections ?? {}) as Record<string, Section>;
  const observed: { kind: string; severity: "critical" | "warning" | "info"; evidence: string }[] = [];
  const unavailable = sectionNames.filter(name => sections[name]?.status !== "available" || !sections[name]?.data || typeof sections[name]?.data !== "object");
  const data = (name: string) => unavailable.includes(name) ? {} : sections[name]!.data!;
  for (const disk of records(data("storage").disks)) {
    const total = number(disk.sizeGB); const free = number(disk.freeGB);
    if (total === null || free === null || total <= 0 || free < 0) continue;
    const percent = free / total * 100;
    if (free < 2 || percent <= 5) observed.push({ kind: "disk_space", severity: "critical", evidence: `${String(disk.drive).slice(0, 20)} has ${free} GB free (${percent.toFixed(1)}%).` });
    else if (percent < 10) observed.push({ kind: "disk_space", severity: "warning", evidence: `${String(disk.drive).slice(0, 20)} has ${percent.toFixed(1)}% free space.` });
  }
  const performance = data("performance"); const totalMemory = number(performance.totalMemoryMB); const freeMemory = number(performance.freeMemoryMB);
  if (totalMemory && freeMemory !== null && freeMemory >= 0 && freeMemory / totalMemory < 0.1) observed.push({ kind: "memory", severity: "warning", evidence: `${(freeMemory / totalMemory * 100).toFixed(1)}% memory free in one sample; check persistence and workload.` });
  if (Array.isArray(performance.cpuLoadPercent) && performance.cpuLoadPercent.some(value => number(value) !== null && Number(value) >= 90)) observed.push({ kind: "cpu", severity: "warning", evidence: "At least one CPU reports 90% or higher load in one sample; this may be temporary." });
  const stopped = records(data("services").stoppedAutomaticServices);
  if (stopped.length) observed.push({ kind: "services", severity: "info", evidence: `${stopped.length} automatic services were stopped (up to 50 reported). Trigger-start or unused services may legitimately be stopped.` });
  const errors = records(data("events").events);
  if (errors.length) observed.push({ kind: "system_events", severity: "warning", evidence: `${errors.length} recent System error/critical events (up to 20 in 24 hours). Inspect their IDs and context before diagnosing a fault.` });
  const restart = data("updates").pendingRestart;
  if (restart && typeof restart === "object" && Object.values(restart).some(value => value === true)) observed.push({ kind: "pending_restart", severity: "info", evidence: "Windows restart indicators are present. No restart was requested." });
  const printers = records(data("printers").printers);
  for (const printer of printers) if (/error|offline|paperout|paperjam|userintervention|notavailable/i.test(String(printer.PrinterStatus))) observed.push({ kind: "printer", severity: "warning", evidence: `${String(printer.Name).slice(0, 150)} reports ${String(printer.PrinterStatus).slice(0, 80)}. Confirm the queue and physical device status.` });
  return { assessment: unavailable.length ? "partial" : "snapshot_completed", observed, unavailable,
    needsAttention: observed.some(item => item.severity !== "info"),
    instruction: "Observed conditions are evidence for follow-up, not confirmed root causes or proof that the original problem exists/is resolved. No findings is not a clean bill of health. This snapshot omits disk reliability, long-term performance, application-specific checks and physical printer state." };
}
