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
import { Drive } from "./drive.js";
import { testMailbox, waitForLoginCode, type MailboxSettings } from "./loginCode.js";
import { CARRIERS, runCarrier, type CarrierKey } from "./portal.js";
import { safeFileName, splitDrivePath } from "./safety.js";

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
  chromePath?: string;
  showBrowser?: boolean;
  debugScreenshots?: boolean;
  maxDocuments?: number;
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

export async function fetchDocuments(
  ctx: PluginContext,
  cfg: InstanceConfig,
  params: { carrier?: unknown; destination?: unknown },
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
  // Connect to Drive before signing in, so a Drive problem doesn't cost a login.
  const drive = await driveFor(ctx, cfg, companyId);
  const folderId = await drive.ensureFolder(destination);

  let mailbox: MailboxSettings | null = null;
  const getCode = async (requestedAt: Date) => {
    mailbox ??= await mailboxSettings(ctx, cfg, companyId);
    return waitForLoginCode(mailbox, carrier.senderDomains, requestedAt, CODE_WAIT_MS);
  };

  const debugDir = cfg.debugScreenshots
    ? join(tmpdir(), "paperclip-insurance-portals-debug", `${carrierKey}-${new Date().toISOString().replace(/[:.]/g, "-")}`)
    : null;
  if (debugDir) ctx.logger.info("insurance-portals: debug screenshots for this run", { debugDir });

  const browser = await Browser.launch({ executablePath: findChrome(cfg.chromePath), headless: !cfg.showBrowser });
  let result;
  try {
    result = await runCarrier(browser, carrier, {
      username,
      password,
      getCode,
      deadline: started + TOOL_BUDGET_MS,
      maxDocuments: Math.max(1, Math.min(50, cfg.maxDocuments ?? 20)),
      debugDir,
      log: (step, meta) => ctx.logger.info(`insurance-portals: ${carrierKey} ${step}`, meta ?? {}),
    });
  } finally {
    await browser.close();
  }

  const files = [];
  const date = today();
  for (const doc of result.documents) {
    const name = safeFileName(`${carrier.name} - ${doc.label} - ${date}`);
    files.push(await drive.savePdf(folderId, name, doc.bytes));
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

  const lines = files.map((f) => `- ${f.name}${f.status === "already_saved" ? " (already in Drive, unchanged)" : ""}`);
  return {
    content:
      `${carrier.name}: found ${files.length} document(s); ${saved} new file(s) saved to "${destination}".` +
      (lines.length ? `\n${lines.join("\n")}` : "") +
      (result.notes.length ? `\n${result.notes.join("\n")}` : ""),
    data: {
      carrier: carrierKey,
      destination,
      files,
      pagesVisited: result.pagesVisited,
      blockedWriteRequests: result.blockedRequests,
      notes: result.notes,
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
      await check("Google Drive", async () => {
        await driveFor(ctx, cfg);
        return "signed in";
      });
      return { ok: checks.every((c) => c.passed), checks };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
