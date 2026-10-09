import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCompanyAccess } from "./companyAccess.js";
import { Browser, findChrome } from "./cdp.js";
import { Drive, type SavedFile } from "./drive.js";
import { LocalFolder } from "./localFolder.js";
import { profileDirFor } from "./profiles.js";
import { addPrivateItems, privateItemsFromPolicies, privateListPath } from "./privateList.js";
import { pdfText } from "./pdfText.js";
import { assignTerms, existingFileFor, fileNameFor, findTerm, termFromName } from "./terms.js";
import { testMailbox, waitForLoginCode, type MailboxSettings } from "./loginCode.js";
import { CARRIERS, runCarrier, type CarrierKey } from "./portal.js";
import { splitDrivePath } from "./safety.js";

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
}

const CREDENTIAL_FIELDS: Record<CarrierKey, [keyof InstanceConfig, keyof InstanceConfig]> = {
  foremost: ["foremostUsername", "foremostPassword"],
  liberty_mutual: ["libertyMutualUsername", "libertyMutualPassword"],
  selective: ["selectiveUsername", "selectivePassword"],
};

const TOOL_BUDGET_MS = 290_000;
/** How long to wait for a code email once the portal has asked for it. */
const CODE_WAIT_MS = 120_000;

/** One portal run at a time: each run starts its own Chrome. */
let running: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = running.then(fn, fn);
  running = next.catch(() => undefined);
  return next;
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
): Promise<ToolResult> {
  const started = Date.now();
  const carrierKey = String(params.carrier ?? "") as CarrierKey;
  const carrier = CARRIERS[carrierKey];
  if (!carrier) return { error: "[EINVALID_INPUT] carrier must be one of: foremost, liberty_mutual, selective." };
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
      deadline: started + TOOL_BUDGET_MS,
      maxDocuments: Math.max(1, Math.min(50, cfg.maxDocuments ?? 20)),
      alreadyHave: (d) => existingFileFor(alreadyThere, carrier.name, d),
      debugDir,
      log: (step, meta) => ctx.logger.info(`insurance-portals: ${carrierKey} ${step}`, meta ?? {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(debugDir ? `${message} (debug screenshots: ${debugDir})` : message);
  } finally {
    await browser.close();
  }

  // Read each document's policy period, then sort into current and prior terms.
  const termsWanted = params.terms === "current" || params.terms === "all" ? params.terms : (cfg.defaultTerms ?? "all");
  const read: Array<(typeof result.documents)[number] & { term: ReturnType<typeof findTerm>; existingName?: string }> = [];
  for (const doc of result.documents) {
    read.push({ ...doc, term: findTerm(await pdfText(doc.bytes)) });
  }
  // Documents already saved by an earlier run take part in the current/prior
  // sorting (their term is in their file name) and are reported, unchanged.
  for (const s of result.skipped) {
    read.push({ ...s, bytes: Buffer.alloc(0), sha256: "", term: termFromName(s.existingName), existingName: s.existingName });
  }
  const sorted = assignTerms(read, today());
  const keep = termsWanted === "current" ? sorted.filter((d) => d.current) : sorted;

  const files = [];
  for (const doc of keep) {
    const savedFile = doc.existingName
      ? { name: doc.existingName, id: doc.existingName, link: null, status: "already_saved" as const }
      : await drive.savePdf(folderId, fileNameFor(carrier.name, doc), doc.bytes);
    files.push({
      ...savedFile,
      policy: doc.policy || null,
      term: doc.term,
      posted: doc.posted,
      current: doc.current,
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
    (f) => `- [${f.current ? "current" : "prior"}] ${f.name}${f.status === "already_saved" ? " (already there, unchanged)" : ""}`,
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
    // it in the background and `fetch-status` reports on it. Jobs live in
    // memory only and are dropped after an hour.
    const jobs = new Map<string, { status: "running" | "done" | "failed"; startedAt: string; result?: ToolResult; error?: string }>();
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
      const jobId = randomUUID();
      const job: { status: "running" | "done" | "failed"; startedAt: string; result?: ToolResult; error?: string } = {
        status: "running",
        startedAt: new Date().toISOString(),
      };
      jobs.set(jobId, job);
      void serialize(() => fetchDocuments(ctx, cfg, params as Record<string, unknown>, companyId))
        .then((result) => {
          job.result = result;
          job.status = result.error ? "failed" : "done";
          if (result.error) job.error = result.error;
        })
        .catch((err) => {
          job.status = "failed";
          job.error = err instanceof Error ? err.message : String(err);
          ctx.logger.warn("insurance-portals: operator run failed", { error: job.error });
        })
        .finally(() => setTimeout(() => jobs.delete(jobId), 3_600_000).unref?.());
      return { jobId, status: job.status };
    });
    ctx.actions.register("fetch-status", async (params) => {
      const job = jobs.get(String(params.jobId ?? ""));
      if (!job) throw new Error("[ENOT_FOUND] No run with that id (runs are kept for an hour).");
      return job;
    });

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
        if (!cfg[u] && !cfg[p]) {
          checks.push({ name, passed: true, message: "not configured (skipped)" });
          continue;
        }
        await check(name, async () => {
          await need(ctx, cfg[u] as string | undefined, `${name} user name`);
          await need(ctx, cfg[p] as string | undefined, `${name} password`);
          return "user name and password secrets readable";
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
