/**
 * 3cx-tools instance-config seeder — TEMPLATE.
 *
 * ┌───────────────────────────────────────────────────────────────────┐
 * │  EDIT THE CONSTANTS BELOW BEFORE RUNNING — DO NOT COMMIT YOUR     │
 * │  EDITS. This file lives in version control as a template;         │
 * │  copying it to e.g. `seed-config.local.ts` (gitignored) and       │
 * │  filling values there is the recommended pattern.                 │
 * └───────────────────────────────────────────────────────────────────┘
 *
 * What this script does:
 *   - Connects to the embedded postgres that backs your Paperclip
 *     instance (default: postgres://paperclip:paperclip@127.0.0.1:54329/paperclip).
 *   - Resolves: the `3cx-tools` plugin id, the secret-ref UUIDs by name,
 *     and the company UUIDs by display name.
 *   - Builds an instance-config payload (one account in `manual` mode
 *     with one routing entry per LLC) and upserts the `plugin_config`
 *     row. Same write path the browser settings form uses.
 *
 * When to use it:
 *   - First-time setup if you'd rather not click through the settings UI.
 *   - Whenever you add/remove DIDs, queues, or LLCs and want to reapply
 *     the routing table programmatically.
 *
 * How to run:
 *   1. Edit COMPANY_NAMES + ROUTING + ACCOUNT_BASE_URL below.
 *   2. From the paperclipai workspace:
 *        pnpm exec tsx <path-to-this-file>
 *   3. Verify with: paperclipai plugin inspect 3cx-tools --json
 *   4. Trigger a worker reload: paperclipai plugin reinstall 3cx-tools
 */
import { desc, eq } from "drizzle-orm";
import {
  createDb,
  plugins,
  pluginConfig,
  companies,
  companySecrets,
} from "@paperclipai/db";

// ─── EDIT THESE ────────────────────────────────────────────────────

const DB_URL =
  process.env.DATABASE_URL ??
  "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";

/** PBX base URL — fully qualified, scheme included, no trailing path. */
const ACCOUNT_BASE_URL = "https://pbx.example.com";

/** Identifier the plugin's `account` parameter resolves against. */
const ACCOUNT_KEY = "main";
const ACCOUNT_DISPLAY_NAME = "Primary PBX";

/** Names of the Paperclip secrets you created on a Secrets page.
 *  These are looked up by name; any company can own them.            */
const SECRET_NAME_CLIENT_ID = "XAPI_3CX_CLIENT_ID";
const SECRET_NAME_CLIENT_SECRET = "XAPI_3CX_CLIENT_SECRET";

/**
 * Map every Paperclip company that uses the PBX to its display name
 * (case-sensitive) as it appears in the Companies table. The keys on
 * the left are local short-IDs you use only inside this file.
 */
const COMPANY_NAMES = {
  companyA: "Company A",
  companyB: "Company B",
  // companyC: "Company C",
} as const;

type Routing = {
  parent: keyof typeof COMPANY_NAMES;
  /** Queue extensions or 3CX queue IDs owned by this company.        */
  queueIds: string[];
  /** External numbers (E.164) routed to this company.                */
  dids: string[];
  /** Optional outbound dial prefix (e.g. "9", "8") so 3CX's outbound
   *  rules pick the right trunk when click-to-call originates from an
   *  agent in this company. Same digit a human at this company's
   *  extension would press before dialing externally. Leave blank if
   *  3CX's default outbound rule for the originating extension is fine. */
  outboundDialPrefix?: string;
};

const ROUTING: Routing[] = [
  {
    parent: "companyA",
    queueIds: ["800"],
    dids: ["+15555550100", "+15555550101"],
    outboundDialPrefix: "9",
  },
  {
    parent: "companyB",
    queueIds: ["810"],
    dids: ["+15555550200"],
    outboundDialPrefix: "8",
  },
  // Add more entries as needed.
];

const ACCOUNT_MODE: "single" | "manual" | "native" = "manual";
const EXPOSE_RECORDINGS = false;
const MAX_CLICK_TO_CALL_PER_DAY = 50;
const ALLOW_MUTATIONS = false; // master switch — leave off until reviewed

// ─── DO NOT EDIT BELOW ─────────────────────────────────────────────

const PLUGIN_KEY = "3cx-tools";

async function main() {
  const db = createDb(DB_URL);

  const pluginRow = await db
    .select({ id: plugins.id })
    .from(plugins)
    .where(eq(plugins.pluginKey, PLUGIN_KEY))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (!pluginRow) throw new Error(`plugin not found: ${PLUGIN_KEY}`);
  console.log(`plugin_id          = ${pluginRow.id}`);

  const clientIdRef = await resolveSecret(db, SECRET_NAME_CLIENT_ID);
  const clientSecretRef = await resolveSecret(db, SECRET_NAME_CLIENT_SECRET);
  console.log(`clientIdRef        = ${clientIdRef}`);
  console.log(`clientSecretRef    = ${clientSecretRef}`);

  const companyIds: Record<keyof typeof COMPANY_NAMES, string> = {} as never;
  for (const [key, name] of Object.entries(COMPANY_NAMES) as Array<
    [keyof typeof COMPANY_NAMES, string]
  >) {
    companyIds[key] = await resolveCompany(db, name);
    console.log(`company ${key.padEnd(15)} (${name}) = ${companyIds[key]}`);
  }

  const account = {
    key: ACCOUNT_KEY,
    displayName: ACCOUNT_DISPLAY_NAME,
    pbxBaseUrl: ACCOUNT_BASE_URL,
    pbxVersion: "20",
    clientIdRef,
    clientSecretRef,
    mode: ACCOUNT_MODE,
    companyRouting: ROUTING.map((r) => ({
      companyId: companyIds[r.parent],
      extensionRanges: [] as string[],
      queueIds: r.queueIds,
      dids: r.dids,
      ...(r.outboundDialPrefix
        ? { outboundDialPrefix: r.outboundDialPrefix }
        : {}),
    })),
    allowedCompanies: ROUTING.map((r) => companyIds[r.parent]),
    exposeRecordings: EXPOSE_RECORDINGS,
    maxClickToCallPerDay: MAX_CLICK_TO_CALL_PER_DAY,
  };

  const configJson = {
    allowMutations: ALLOW_MUTATIONS,
    defaultAccount: ACCOUNT_KEY,
    accounts: [account],
  } satisfies Record<string, unknown>;

  const existing = await db
    .select({ id: pluginConfig.id })
    .from(pluginConfig)
    .where(eq(pluginConfig.pluginId, pluginRow.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) {
    await db
      .update(pluginConfig)
      .set({ configJson, lastError: null, updatedAt: new Date() })
      .where(eq(pluginConfig.pluginId, pluginRow.id));
    console.log("\nUPDATE OK — existing plugin_config row replaced.");
  } else {
    await db
      .insert(pluginConfig)
      .values({ pluginId: pluginRow.id, configJson });
    console.log("\nINSERT OK — new plugin_config row created.");
  }

  const after = await db
    .select({ configJson: pluginConfig.configJson })
    .from(pluginConfig)
    .where(eq(pluginConfig.pluginId, pluginRow.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  console.log("\nFinal config_json:");
  console.log(JSON.stringify(after?.configJson, null, 2));
}

type Db = ReturnType<typeof createDb>;

async function resolveSecret(db: Db, name: string): Promise<string> {
  const rows = await db
    .select({ id: companySecrets.id })
    .from(companySecrets)
    .where(eq(companySecrets.name, name))
    .orderBy(desc(companySecrets.createdAt))
    .limit(1);
  if (!rows[0]) throw new Error(`secret not found by name: ${name}`);
  return rows[0].id;
}

async function resolveCompany(db: Db, name: string): Promise<string> {
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(eq(companies.name, name))
    .limit(1);
  if (!rows[0]) throw new Error(`company not found by name: ${name}`);
  return rows[0].id;
}

main()
  .catch((err) => {
    console.error("\nFAILED:", err.message);
    process.exit(1);
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 250).unref();
  });
