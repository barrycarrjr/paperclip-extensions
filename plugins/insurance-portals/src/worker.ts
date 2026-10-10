import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCompanyAccess } from "./companyAccess.js";
import { Browser, findChrome } from "./cdp.js";
import { Drive, type SavedFile } from "./drive.js";
import { LocalFolder } from "./localFolder.js";
import { profileDirFor } from "./profiles.js";
import { addPrivateItems, privateItemsFromPolicies, privateListPath } from "./privateList.js";
import { pdfText } from "./pdfText.js";
import { assignTerms, existingFileFor, fileNameFor, findRevision, findTerm, termFromName } from "./terms.js";
import { testMailbox, waitForLoginCode, type MailboxSettings } from "./loginCode.js";
import { CARRIERS, runCarrier, type CarrierKey } from "./portal.js";
import { policyNumberIn, policyNamedInPdf, splitDrivePath } from "./safety.js";
import { asHistory, describeHealth, recordRun, type HealthReport } from "./history.js";
import { JobStore, jobView } from "./jobs.js";
import { hasKeyFigures, readKeyFigures, type KeyFigures } from "./declarations.js";
import manifest from "./manifest.js";

const PLUGIN_VERSION_FOR_SUMMARY = `v${manifest.version}`;
/** Subfolder of the destination that holds the PDFs' summaries. */
export const SUMMARIES_FOLDER = "_Summaries";

interface InstanceConfig {
  allowedCompanies?: string[];
  foremostUsername?: string;
  foremostPassword?: string;
  libertyMutualUsername?: string;
  libertyMutualPassword?: string;
  selectiveUsername?: string;
  selectivePassword?: string;
  codeMailboxAddress?: string;
  codeMailboxPassword?: string;
  codeMailboxHost?: string;
  codeMailboxFolder?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRefreshToken?: string;
  saveTo?: "auto" | "local" | "google-drive";
  localFolder?: string;
  chromePath?: string;
  rememberSignIn?: boolean;
  profilesFolder?: string;
  showBrowser?: boolean;
  debugScreenshots?: boolean;
  maxDocuments?: number;
  defaultTerms?: "all" | "current";
  privateListFile?: string;
  enableForemost?: boolean;
  enableLibertyMutual?: boolean;
  enableSelective?: boolean;
}

/** Each carrier's on/off switch in the settings. Missing means on. */
const ENABLE_FIELDS: Record<CarrierKey, keyof InstanceConfig> = {
  foremost: "enableForemost",
  liberty_mutual: "enableLibertyMutual",
  selective: "enableSelective",
};
const carrierOn = (cfg: InstanceConfig, key: CarrierKey) => cfg[ENABLE_FIELDS[key]] !== false;

/** Where a carrier's run record is kept: per company, per carrier. */
const historyKey = (companyId: string, carrier: CarrierKey) => ({
  scopeKind: "company" as const,
  scopeId: companyId,
  namespace: carrier,
  // "-2": records from 0.6.23 counted repeat copies as missing; they are not read.
  stateKey: "run-history-2",
});

/** Add this run to the carrier's record. The record is a help, never a reason to fail a run. */
async function noteRun(
  ctx: PluginContext,
  companyId: string,
  carrier: CarrierKey,
  carrierName: string,
  run: Parameters<typeof recordRun>[1],
): Promise<HealthReport | null> {
  try {
    const prev = asHistory(await ctx.state.get(historyKey(companyId, carrier)));
    const { history, report } = recordRun(prev, run, carrierName);
    await ctx.state.set(historyKey(companyId, carrier), history);
    return report;
  } catch (err) {
    ctx.logger.warn("insurance-portals: could not update the run record", { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Errors that mean the run never got past sign-in. */
const SIGN_IN_FAILURE = /\[E(LOGIN_[A-Z_]+|CODE_[A-Z_]+|CAPTCHA|MAIL_AUTH_FAILED)\]/;

const CREDENTIAL_FIELDS: Record<CarrierKey, [keyof InstanceConfig, keyof InstanceConfig]> = {
  foremost: ["foremostUsername", "foremostPassword"],
  liberty_mutual: ["libertyMutualUsername", "libertyMutualPassword"],
  selective: ["selectiveUsername", "selectivePassword"],
};

const TOOL_BUDGET_MS = 290_000;
/**
 * A run started by the operator in the background is not held to the
 * 5-minute tool limit; an account with many policies needs longer.
 */
const OPERATOR_BUDGET_MS = 900_000;
/** How long to wait for a code email once the portal has asked for it. */
const CODE_WAIT_MS = 120_000;

/** One portal run at a time: each run starts its own Chrome. */
let running: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = running.then(fn, fn);
  running = next.catch(() => undefined);
  return next;
}

/** Background fetch jobs, shared by the agent tools and the operator actions. */
const jobs = new JobStore<ToolResult>();
/** Longest a status call waits, inside the 5-minute tool limit. */
const STATUS_WAIT_MAX_S = 240;

/** A reason the fetch cannot start, checked before any job is made. */
function checkFetchParams(cfg: InstanceConfig, params: { carrier?: unknown; destination?: unknown }): string | null {
  const key = String(params.carrier ?? "") as CarrierKey;
  if (!CARRIERS[key]) return "[EINVALID_INPUT] carrier must be one of: foremost, liberty_mutual, selective.";
  if (!carrierOn(cfg, key)) return `[ECARRIER_OFF] ${CARRIERS[key].name} is turned off in the Insurance Portals plugin settings.`;
  if (typeof params.destination !== "string" || !params.destination.trim()) return "[EINVALID_INPUT] destination (a Drive folder path) is required.";
  return null;
}

/** The fetch a background job runs. Tests put a stand-in here (no browser, no sign-in). */
let runFetch: typeof fetchDocuments = (...args) => fetchDocuments(...args);
export function setFetchForTests(fn: typeof fetchDocuments | null): void {
  runFetch = fn ?? ((...args) => fetchDocuments(...args));
}

/** Start a background fetch, or hand back the one already running for this company and carrier. */
function startJob(ctx: PluginContext, cfg: InstanceConfig, params: Record<string, unknown>, companyId: string) {
  const carrier = String(params.carrier ?? "");
  return jobs.start(
    companyId,
    carrier,
    () =>
      serialize(() => runFetch(ctx, cfg, params, companyId, OPERATOR_BUDGET_MS)).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.logger.warn("insurance-portals: background run failed", { error: message, companyId });
        throw err;
      }),
    (r) => r.error ?? null,
  );
}

/** The summary saved for a PDF (in the _Summaries subfolder): its key figures as read, and what could not be read. */
function summaryJson(
  carrierName: string,
  pdfName: string,
  doc: { policy: string; title: string; posted: string | null; term: ReturnType<typeof findTerm> },
  f: KeyFigures,
): string {
  return `${JSON.stringify(
    {
      document: pdfName,
      carrier: carrierName,
      policy: doc.policy || null,
      title: doc.title,
      term: doc.term,
      posted: doc.posted,
      policyType: f.policyType,
      premium: f.premium,
      dwelling: f.dwelling,
      dwellingKind: f.dwellingKind,
      liability: f.liability,
      liabilityText: f.liabilityText,
      mortgagee: f.lender,
      namedInsured: f.namedInsured,
      notFound: f.notFound,
      notApplicable: f.notApplicable,
      note: `Read automatically from the PDF's text by the Insurance Portals plugin ${PLUGIN_VERSION_FOR_SUMMARY}. A figure the page does not show, or does not label clearly, is null and listed under notFound (for a mortgagee, the page may simply have none). Only the loan number's last 4 digits are kept. Check the PDF before acting on a figure.`,
      readOn: today(),
    },
    null,
    2,
  )}\n`;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function need(ctx: PluginContext, ref: string | undefined, what: string, companyId?: string): Promise<string> {
  if (!ref) throw new Error(`[ECONFIG_MISSING] '${what}' is not set in the Insurance Portals settings.`);
  try {
    return await ctx.secrets.resolve(ref, companyId);
  } catch {
    throw new Error(
      `[ESECRET_UNREADABLE] The secret picked for '${what}' could not be read. It must exist and belong to the company running the tool.`,
    );
  }
}

async function mailboxSettings(ctx: PluginContext, cfg: InstanceConfig, companyId?: string): Promise<MailboxSettings> {
  if (!cfg.codeMailboxAddress) throw new Error("[ECONFIG_MISSING] 'Code mailbox address' is not set in the Insurance Portals settings.");
  return {
    user: cfg.codeMailboxAddress.trim(),
    password: await need(ctx, cfg.codeMailboxPassword, "Code mailbox app password", companyId),
    host: (cfg.codeMailboxHost || "imap.gmail.com").trim(),
    port: 993,
    folder: (cfg.codeMailboxFolder || "INBOX").trim(),
  };
}

async function driveFor(ctx: PluginContext, cfg: InstanceConfig, companyId?: string): Promise<Drive> {
  return Drive.connect({
    clientId: await need(ctx, cfg.googleClientId, "Google OAuth client ID", companyId),
    clientSecret: await need(ctx, cfg.googleClientSecret, "Google OAuth client secret", companyId),
    refreshToken: await need(ctx, cfg.googleRefreshToken, "Google refresh token", companyId),
  });
}

interface Saver {
  ensureFolder(path: string): Promise<string>;
  listNames(folder: string): Promise<string[]>;
  savePdf(folder: string, name: string, bytes: Buffer): Promise<SavedFile>;
  saveText(folder: string, name: string, text: string): Promise<{ name: string; status: "saved" | "exists" }>;
}

/** Google Drive API when chosen (or when "auto" and all three Google keys are set); otherwise the local folder. */
function usesLocal(cfg: InstanceConfig): boolean {
  const mode = cfg.saveTo ?? "auto";
  if (mode === "local") return true;
  if (mode === "google-drive") return false;
  return !(cfg.googleClientId && cfg.googleClientSecret && cfg.googleRefreshToken);
}

async function saverFor(ctx: PluginContext, cfg: InstanceConfig, companyId?: string): Promise<Saver> {
  return usesLocal(cfg) ? LocalFolder.open(cfg.localFolder) : driveFor(ctx, cfg, companyId);
}

export async function fetchDocuments(
  ctx: PluginContext,
  cfg: InstanceConfig,
  params: { carrier?: unknown; destination?: unknown; terms?: unknown },
  companyId: string,
  budgetMs = TOOL_BUDGET_MS,
): Promise<ToolResult> {
  const started = Date.now();
  const carrierKey = String(params.carrier ?? "") as CarrierKey;
  const carrier = CARRIERS[carrierKey];
  if (!carrier) return { error: "[EINVALID_INPUT] carrier must be one of: foremost, liberty_mutual, selective." };
  if (!carrierOn(cfg, carrierKey)) {
    return { error: `[ECARRIER_OFF] ${carrier.name} is turned off in the Insurance Portals plugin settings.` };
  }
  const destination = typeof params.destination === "string" ? params.destination.trim() : "";
  if (!destination) return { error: "[EINVALID_INPUT] destination (a Drive folder path) is required." };
  try {
    if (splitDrivePath(destination).length === 0) {
      return { error: "[EINVALID_DESTINATION] Give a folder under My Drive, e.g. 'Insurance/Selective'." };
    }
  } catch (err) {
    return { error: (err as Error).message };
  }

  const [userField, passField] = CREDENTIAL_FIELDS[carrierKey];
  const username = await need(ctx, cfg[userField] as string | undefined, `${carrier.name} user name`, companyId);
  const password = await need(ctx, cfg[passField] as string | undefined, `${carrier.name} password`, companyId);
  // Open the save location before signing in, so a problem there doesn't cost a login.
  const drive = await saverFor(ctx, cfg, companyId);
  const folderId = await drive.ensureFolder(destination);
  const alreadyThere = await drive.listNames(folderId);

  let mailbox: MailboxSettings | null = null;
  const getCode = async (requestedAt: Date) => {
    mailbox ??= await mailboxSettings(ctx, cfg, companyId);
    return waitForLoginCode(mailbox, carrier.senderDomains, requestedAt, CODE_WAIT_MS);
  };

  const debugDir = cfg.debugScreenshots
    ? join(tmpdir(), "paperclip-insurance-portals-debug", `${carrierKey}-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    : null;
  if (debugDir) ctx.logger.info("insurance-portals: debug screenshots for this run", { debugDir });

  const browser = await Browser.launch({
    executablePath: findChrome(cfg.chromePath),
    headless: !cfg.showBrowser,
    profileDir: profileDirFor(cfg, carrierKey) ?? undefined,
  });
  let result;
  try {
    result = await runCarrier(browser, carrier, {
      username,
      password,
      getCode,
      deadline: started + budgetMs,
      maxDocuments: Math.max(1, Math.min(50, cfg.maxDocuments ?? 20)),
      alreadyHave: (d) => existingFileFor(alreadyThere, carrier.name, d),
      debugDir,
      log: (step, meta) => ctx.logger.info(`insurance-portals: ${carrierKey} ${step}`, meta ?? {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const report = await noteRun(ctx, companyId, carrierKey, carrier.name, {
      at: new Date().toISOString(),
      outcome: SIGN_IN_FAILURE.test(message) ? "signin_failed" : "error",
      got: [],
      missed: [],
    });
    const alert = report?.alert ? ` ALERT: ${report.alert}` : "";
    throw new Error(`${message}${alert}${debugDir ? ` (debug screenshots: ${debugDir})` : ""}`);
  } finally {
    await browser.close();
  }

  // Read each document's policy period, then sort into current and prior terms.
  const termsWanted = params.terms === "current" || params.terms === "all" ? params.terms : (cfg.defaultTerms ?? "all");
  const read: Array<
    (typeof result.documents)[number] & { term: ReturnType<typeof findTerm>; revision?: string | null; figures?: KeyFigures | null; existingName?: string }
  > = [];
  // The account's own policy numbers, to check each PDF is filed under the
  // policy it is about.
  // Only numbers documents were found under: never a billing account.
  const knownPolicies = [...new Set([...result.documents, ...result.skipped].map((d) => policyNumberIn(d.policy)).filter((x): x is string => !!x))];
  for (const doc of result.documents) {
    // Most forms print the term on their first pages; a welcome packet can
    // hold its declarations page 50 pages in, so read on when needed.
    let text = await pdfText(doc.bytes);
    let term = findTerm(text);
    if (!term) {
      text = await pdfText(doc.bytes, 150);
      term = findTerm(text);
    }
    // A page that had not yet switched to the policy clicked can hand over
    // another policy's PDF. When the PDF does not mention the policy it was
    // found under but does mention another of the account's policies, file
    // it under that one.
    const named = policyNumberIn(doc.policy) ?? "";
    const actual = policyNamedInPdf(named, text, knownPolicies);
    if (actual && actual !== named) {
      ctx.logger.info("insurance-portals: document filed under the policy it names", { from: named ? `...${named.slice(-4)}` : "none", to: `...${actual.slice(-4)}` });
      doc.policy = `Policy ${actual}`;
    }
    // Two endorsements can be issued the same day; the form's revision code
    // tells them apart in the file name.
    const revision = /\b(endorsement|policy change)\b/i.test(doc.title) ? findRevision(text) : null;
    // The declarations page's key figures, for a summary beside the PDF.
    const figures = readKeyFigures(text);
    read.push({ ...doc, term, revision, figures: hasKeyFigures(figures) ? figures : null });
  }
  // Documents already saved by an earlier run take part in the current/prior
  // sorting (their term is in their file name) and are reported, unchanged.
  for (const s of result.skipped) {
    read.push({ ...s, bytes: Buffer.alloc(0), sha256: "", term: termFromName(s.existingName), existingName: s.existingName });
  }
  const sorted = assignTerms(read, today());
  const keep = termsWanted === "current" ? sorted.filter((d) => d.current) : sorted;

  const files = [];
  // Summaries go in one place per insurance folder: its _Summaries subfolder,
  // created the first time a summary is saved.
  let summariesFolder: string | null = null;
  const summariesFolderId = async () => (summariesFolder ??= await drive.ensureFolder(`${destination}/${SUMMARIES_FOLDER}`));
  for (const doc of keep) {
    const savedFile = doc.existingName
      ? { name: doc.existingName, id: doc.existingName, link: null, status: "already_saved" as const }
      : await drive.savePdf(folderId, fileNameFor(carrier.name, doc), doc.bytes);
    // A new PDF with a declarations page gets a small summary beside it.
    let summary: string | null = null;
    if (savedFile.status === "saved" && doc.figures) {
      try {
        const s = await drive.saveText(
          await summariesFolderId(),
          `${savedFile.name.replace(/\.pdf$/i, "")} - summary.json`,
          summaryJson(carrier.name, savedFile.name, doc, doc.figures),
        );
        summary = `${SUMMARIES_FOLDER}/${s.name}`;
      } catch (err) {
        result.notes.push(`Could not save the summary for ${savedFile.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    files.push({
      ...savedFile,
      policy: doc.policy || null,
      term: doc.term,
      posted: doc.posted,
      current: doc.current,
      keyFigures: doc.figures ?? null,
      summary,
    });
  }
  if (keep.length < sorted.length) {
    result.notes.push(`Kept the current term only: skipped ${sorted.length - keep.length} prior-term document(s).`);
  }
  const noTerm = files.filter((f) => !f.term).length;
  if (noTerm) {
    result.notes.push(
      `${noTerm} document(s) had no readable policy period, so they are named by posted date and marked current or prior from the posted dates.`,
    );
  }

  // Keep the operator's private-details list current (only if it exists).
  const listPath = privateListPath(cfg.privateListFile);
  // Always include each downloaded (or already saved) document's own policy
  // number and property address, whatever else the pages showed.
  const fromDocs = privateItemsFromPolicies(sorted.map((d) => d.policy));
  const privateItems = [...new Set([...fromDocs, ...result.identifiers])];
  if (listPath && privateItems.length) {
    try {
      const added = await addPrivateItems(listPath, carrier.name, privateItems, today());
      if (added) result.notes.push(`Added ${added} new policy/account number(s) or address(es) to the private-details list.`);
    } catch {
      result.notes.push("Could not update the private-details list.");
    }
  }

  // The carrier's run record: what is still missing, and whether it looks broken.
  const got = read.map((d) => ({ policy: d.policy, title: d.title, posted: d.posted }));
  const health = await noteRun(ctx, companyId, carrierKey, carrier.name, {
    at: new Date().toISOString(),
    outcome: "ok",
    got,
    missed: result.missed,
  });
  if (health) result.notes.push(...describeHealth(health));

  const saved = files.filter((f) => f.status === "saved").length;
  await ctx.activity
    .log({
      companyId,
      message: `Insurance Portals: fetched ${files.length} document(s) from ${carrier.name}; saved ${saved} new to Drive folder "${destination}"`,
      metadata: { carrier: carrierKey, destination, saved, alreadySaved: files.length - saved },
    })
    .catch(() => undefined);
  await ctx.telemetry
    .track("insurance-portals.fetch_documents", { carrier: carrierKey, documents: files.length, saved, companyId })
    .catch(() => undefined);

  const lines = files.map(
    (f) =>
      `- [${f.current ? "current" : "prior"}] ${f.name}${f.status === "already_saved" ? " (already there, unchanged)" : ""}${f.summary ? " (+ summary)" : ""}`,
  );
  return {
    content:
      `${carrier.name}: found ${files.length} document(s); ${saved} new file(s) saved to "${destination}".` +
      (lines.length ? `\n${lines.join("\n")}` : "") +
      (result.notes.length ? `\n${result.notes.join("\n")}` : ""),
    data: {
      carrier: carrierKey,
      destination,
      terms: termsWanted,
      files,
      pagesVisited: result.pagesVisited,
      blockedWriteRequests: result.blockedRequests,
      blockedPaths: result.blockedPaths,
      notes: result.notes,
      health: health ?? null,
      debugDir,
      seconds: Math.round((Date.now() - started) / 1000),
    },
  };
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("insurance-portals plugin setup");

    ctx.tools.register(
      "insurance_fetch_documents",
      {
        displayName: "Fetch insurance policy documents",
        description:
          "Sign in to an insurance carrier portal (read-only) and save the current policy and declarations-page PDFs to a Drive folder.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const cfg = (await ctx.config.get()) as InstanceConfig;
        assertCompanyAccess(ctx, {
          tool: "insurance_fetch_documents",
          resourceLabel: "insurance-portals",
          resourceKey: "instance",
          allowedCompanies: cfg.allowedCompanies,
          companyId: runCtx.companyId,
        });
        try {
          return await serialize(() =>
            fetchDocuments(ctx, cfg, (params ?? {}) as Record<string, unknown>, runCtx.companyId),
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.logger.warn("insurance-portals: run failed", { error: message, companyId: runCtx.companyId });
          return { error: message };
        }
      },
    );

    // Operator lane. Board-only (the host checks), company-gated like the
    // tool. A run outlasts the 30-second action limit, so `start-fetch` starts
    // it in the background and `fetch-status` reports on it. It shares the
    // agents' job store: one run per company and carrier at a time.
    ctx.actions.register("start-fetch", async (params) => {
      const scope = (params.hostScope ?? {}) as { companyId?: string | null };
      const companyId = scope.companyId ?? null;
      if (!companyId) throw new Error("[EINVALID_INPUT] Pick a company (companyId) to run under.");
      const cfg = (await ctx.config.get()) as InstanceConfig;
      assertCompanyAccess(ctx, {
        tool: "start-fetch",
        resourceLabel: "insurance-portals",
        resourceKey: "instance",
        allowedCompanies: cfg.allowedCompanies,
        companyId,
      });
      const { job, reused } = startJob(ctx, cfg, params as Record<string, unknown>, companyId);
      return { jobId: job.id, status: job.status, reused };
    });
    ctx.actions.register("fetch-status", async (params) => {
      const scope = (params.hostScope ?? {}) as { companyId?: string | null };
      const id = String(params.jobId ?? "");
      const job = scope.companyId ? jobs.get(id, scope.companyId) : jobs.getAny(id);
      if (!job) throw new Error("[ENOT_FOUND] No run with that id (runs are kept for an hour).");
      return jobView(job);
    });

    // Agent lane for long runs: start in the background, then ask how it is
    // going. Each call fits well inside the 5-minute tool limit.
    ctx.tools.register(
      "insurance_start_fetch",
      {
        displayName: "Start an insurance document fetch",
        description: "Start a fetch from one carrier in the background and return its job id at once.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const cfg = (await ctx.config.get()) as InstanceConfig;
        assertCompanyAccess(ctx, {
          tool: "insurance_start_fetch",
          resourceLabel: "insurance-portals",
          resourceKey: "instance",
          allowedCompanies: cfg.allowedCompanies,
          companyId: runCtx.companyId,
        });
        const problem = checkFetchParams(cfg, (params ?? {}) as Record<string, unknown>);
        if (problem) return { error: problem };
        const { job, reused } = startJob(ctx, cfg, (params ?? {}) as Record<string, unknown>, runCtx.companyId);
        return {
          content: reused
            ? `A ${job.carrier} fetch was already running for this company (job ${job.id}, started ${job.startedAt}). No second run was started. Check it with insurance_fetch_status.`
            : `Started the ${job.carrier} fetch in the background (job ${job.id}). Check it with insurance_fetch_status; a run takes 5 to 15 minutes.`,
          data: { jobId: job.id, status: job.status, reused, carrier: job.carrier, startedAt: job.startedAt },
        };
      },
    );
    ctx.tools.register(
      "insurance_fetch_status",
      {
        displayName: "Check an insurance document fetch",
        description: "Wait up to about 4 minutes for a background fetch, then return its result or say it is still running.",
        parametersSchema: {} as Record<string, unknown>,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as { jobId?: unknown; waitSeconds?: unknown };
        const waitS = Math.max(0, Math.min(STATUS_WAIT_MAX_S, Number(p.waitSeconds ?? STATUS_WAIT_MAX_S) || 0));
        const job = await jobs.wait(String(p.jobId ?? ""), runCtx.companyId, waitS * 1000);
        if (!job) {
          return {
            error:
              "[ENOT_FOUND] No fetch with that job id for this company. Jobs are kept for an hour after they finish and are lost if the plugin restarts; start the carrier again (documents already saved are skipped).",
          };
        }
        if (job.status === "running") {
          return {
            content: `The ${job.carrier} fetch (job ${job.id}, started ${job.startedAt}) is still running. Call insurance_fetch_status again.`,
            data: { jobId: job.id, status: job.status, carrier: job.carrier, startedAt: job.startedAt },
          };
        }
        if (job.status === "failed") {
          return {
            error: `The ${job.carrier} fetch (job ${job.id}) failed: ${job.error ?? "unknown error"}`,
          };
        }
        const r = job.result!;
        return {
          content: `The ${job.carrier} fetch (job ${job.id}) is done.\n${r.content ?? ""}`,
          data: { jobId: job.id, status: job.status, carrier: job.carrier, startedAt: job.startedAt, finishedAt: job.finishedAt, result: r.data ?? null },
        };
      },
    );

    // Operator check (no carrier sign-in): Chrome found, secrets readable,
    // mailbox opens read-only, Drive signs in.
    ctx.actions.register("check-setup", async () => {
      const cfg = (await ctx.config.get()) as InstanceConfig;
      const checks: Array<{ name: string; passed: boolean; message: string }> = [];
      const check = async (name: string, fn: () => Promise<string>) => {
        try {
          checks.push({ name, passed: true, message: await fn() });
        } catch (err) {
          checks.push({ name, passed: false, message: err instanceof Error ? err.message : String(err) });
        }
      };
      await check("Chrome", async () => {
        const path = findChrome(cfg.chromePath);
        const browser = await Browser.launch({ executablePath: path, headless: true });
        try {
          const page = await browser.firstPage();
          const ok = await page.evaluate<number>(() => 1 + 1);
          if (ok !== 2) throw new Error("Chrome started but did not run a page script");
        } finally {
          await browser.close();
        }
        return `started and controlled ${path}`;
      });
      for (const key of Object.keys(CREDENTIAL_FIELDS) as CarrierKey[]) {
        const [u, p] = CREDENTIAL_FIELDS[key];
        const name = CARRIERS[key].name;
        if (!carrierOn(cfg, key)) {
          checks.push({ name, passed: true, message: "turned off in the settings (skipped)" });
          continue;
        }
        if (!cfg[u] && !cfg[p]) {
          checks.push({ name, passed: true, message: "on, but not configured (skipped)" });
          continue;
        }
        await check(name, async () => {
          await need(ctx, cfg[u] as string | undefined, `${name} user name`);
          await need(ctx, cfg[p] as string | undefined, `${name} password`);
          return "on; user name and password secrets readable";
        });
      }
      await check("Code mailbox", async () => {
        await testMailbox(await mailboxSettings(ctx, cfg));
        return "signed in and opened the folder read-only";
      });
      await check("Save to", async () => {
        if (usesLocal(cfg)) {
          const local = await LocalFolder.open(cfg.localFolder);
          return `local folder ${local.root}`;
        }
        await driveFor(ctx, cfg);
        return "Google Drive (signed in)";
      });
      return { ok: checks.every((c) => c.passed), checks };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
