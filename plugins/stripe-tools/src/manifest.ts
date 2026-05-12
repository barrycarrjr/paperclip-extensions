import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "stripe-tools";
const PLUGIN_VERSION = "0.2.7";

const SETUP_INSTRUCTIONS = `# Setup — Stripe Tools

Connect a Stripe account so agents can look up customers, subscriptions, charges, disputes, and pull metrics. Reckon on **about 10 minutes**.

---

## 1. Create a Stripe Restricted API Key

Use a **restricted key** — not the secret key (\`sk_live_...\`). Restricted keys limit blast radius if a key is ever compromised.

- Log into the [Stripe Dashboard](https://dashboard.stripe.com)
- Go to **Developers → API keys → Restricted keys → Create restricted key**
- **Key name**: "Paperclip"
- Set the following permissions:

| Resource | Permission |
|---|---|
| Customers | Read |
| Subscriptions | Read |
| Charges | Read |
| Balance | Read |
| Disputes | Read |
| Invoices | Read |
| Prices | Read |
| Coupons | Write *(only if you'll enable allowMutations)* |
| Promotion codes | Write *(only if you'll enable allowMutations)* |

- Click **Create key** and **copy it now**

> The key starts with \`rk_live_...\` (production) or \`rk_test_...\` (test mode). Keep separate keys for each environment.

---

## 2. Create a Paperclip secret

In Paperclip, switch to the company that should own this Stripe connection.

- Go to **Secrets → Add**
- Name it (e.g. \`stripe-restricted-key\` or \`stripe-test-key\`)
- Paste the restricted key as the value
- Save, then **copy the secret's UUID**

---

## 3. Configure the plugin (this page, **Configuration** tab)

Click the **Configuration** tab above. Under **Stripe accounts**, click **+ Add item** and fill in:

| Field | Value |
|---|---|
| **Identifier** | \`main\` (or \`test\` for the sandbox account) |
| **Display name** | e.g. "Production live" |
| **Mode** | \`live\` or \`test\` |
| **Restricted secret key** | UUID of the secret from step 2 |
| **Allowed companies** | tick the companies whose agents may use this account |

Set **Default account key** to \`main\` at the top.

---

## 4. Add a test-mode account (recommended)

Repeat steps 1–3 with a \`rk_test_...\` key, set **Mode** to \`test\`, and use identifier \`test\`. Skills can then pass \`"account": "test"\` during development so they never touch live billing data.

---

## Troubleshooting

- **401 / \`[ESTRIPE_AUTH]\`** — the secret UUID is wrong, or the key was rolled. Update the Paperclip secret value and re-save the plugin config.
- **403 / \`[ESTRIPE_PERMISSION]\`** — the restricted key is missing a scope. Edit the key in the Stripe dashboard to add it.
- **\`[ESTRIPE_MIXED_CURRENCY]\`** from \`stripe_get_metrics_snapshot\`** — your active subscriptions span more than one currency. The metrics tool doesn't do FX conversion; export to CSV and aggregate externally, or filter by currency.
- **Test data showing in production reports** — make sure your test account uses a \`rk_test_...\` key and production uses \`rk_live_...\`. Stripe silently accepts both; the \`mode\` field in config is informational only.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Stripe Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Exposes Stripe operations (customers, subscriptions, charges, balance, disputes, coupons, CSV export, MRR/ARR/churn metrics) as agent tools. Multi-account, per-account company isolation, mutations gated by a master switch.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow mutating tools",
        description:
          "Master switch for stripe_create_coupon and stripe_create_promotion_code. Set false (default) to put the plugin into read-only mode — mutation tools return [EDISABLED] without hitting the Stripe API. Read tools are unaffected. Flip to true only after you've reviewed which agents/skills can call mutations.",
        default: false,
      },
      accounts: {
        type: "array",
        title: "Stripe accounts",
        description:
          "One entry per Stripe account the plugin can talk to. Most companies have one live account; you may also add a separate test-mode account for development. Every account must list the company UUIDs allowed to use it under 'Allowed companies' — empty list = unusable (fail-safe default deny).",
        items: {
          type: "object",
          required: ["key", "secretKeyRef", "allowedCompanies"],
          properties: {
            name: {
              type: "string",
              title: "Display name",
              description:
                "Human-readable label shown in this settings form (e.g. 'Production live', 'Test sandbox'). Free-form; you can rename it later without breaking anything.",
            },
            key: {
              type: "string",
              title: "Identifier",
              description:
                "Short stable ID agents pass when calling Stripe tools (e.g. 'main', 'test'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it. Must be unique across accounts.",
            },
            allowedCompanies: {
              type: "array",
              items: { type: "string", format: "company-id" },
              title: "Allowed companies",
              description:
                "Companies allowed to use this Stripe account. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable (fail-safe deny — useful for staged setup).",
            },
            mode: {
              type: "string",
              enum: ["live", "test"],
              default: "live",
              title: "Mode",
              description:
                "Informational. Stripe doesn't expose mode from the API key alone, so this lets the worker label log lines and helps you avoid mixing live/test accounts in the same row. Use 'test' for sandbox restricted keys; 'live' for production.",
            },
            secretKeyRef: {
              type: "string",
              format: "secret-ref",
              title: "Restricted secret key (UUID of secret)",
              description:
                "Paste the UUID of the paperclip secret holding this account's Stripe restricted API key (rk_live_... or rk_test_...). Create the secret first on the company's Secrets page; never paste the raw key here. Required scopes for this plugin: read on customers, subscriptions, charges, balance, disputes, invoices, prices; write on coupons + promotion_codes (only if you'll enable allowMutations).",
            },
            apiVersion: {
              type: "string",
              title: "Stripe API version pin (optional)",
              description:
                "Optional Stripe API version override (e.g. '2024-12-18.acacia'). Leave blank to let the SDK pin automatically — recommended unless you need to align with specific webhook payloads or downstream integrations.",
            },
          },
        },
      },
      defaultAccount: {
        type: "string",
        title: "Default account key",
        "x-paperclip-optionsFromSibling": {
          sibling: "accounts",
          valueKey: "key",
          labelKey: "displayName",
        },
        description:
          "Identifier of the account used when an agent omits the `account` parameter in a tool call. Strict: if the calling company isn't in the default account's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no automatic fallback). Leave blank to require an explicit `account` on every call.",
      },
    },
  },
  tools: [
    {
      name: "stripe_search_customers",
      displayName: "Search Stripe customers",
      description:
        "Search Stripe customers using Stripe Search query syntax (e.g. \"email:'foo@bar.com'\" or \"metadata['signup_source']:'web'\"). Returns up to `limit` customers (max 100).",
      parametersSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Stripe search query (Stripe Query Language). Examples: \"email:'foo@bar.com'\", \"created>1700000000\", \"metadata['plan']:'pro'\".",
          },
          account: {
            type: "string",
            description:
              "Stripe account identifier as configured on the plugin settings page. Optional — falls back to defaultAccount.",
          },
          limit: {
            type: "number",
            description: "Maximum results to return. Default 25, max 100.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "stripe_get_customer",
      displayName: "Get Stripe customer",
      description:
        "Retrieve a Stripe customer by ID, with optional expansions (e.g. ['subscriptions','invoices']).",
      parametersSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "Stripe customer ID (cus_...).",
          },
          account: {
            type: "string",
            description:
              "Stripe account identifier. Optional — falls back to defaultAccount.",
          },
          expand: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of fields to expand. Accepts standard Stripe expansion paths (e.g. 'subscriptions', 'default_source').",
          },
        },
        required: ["customerId"],
      },
    },
    {
      name: "stripe_list_subscriptions",
      displayName: "List Stripe subscriptions",
      description:
        "List subscriptions filtered by customer / status / price / created. Pagination via startingAfter.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          customerId: { type: "string", description: "Filter to one customer (cus_...)." },
          status: {
            type: "string",
            enum: ["active", "canceled", "past_due", "trialing", "unpaid", "incomplete", "incomplete_expired", "paused", "all"],
            description: "Subscription status filter. 'all' returns every status.",
          },
          priceId: { type: "string", description: "Filter to subscriptions on this price (price_...)." },
          createdAfter: {
            type: "string",
            description: "ISO 8601 date — subscriptions created at or after this timestamp.",
          },
          limit: { type: "number", description: "Page size (default 25, max 100)." },
          startingAfter: {
            type: "string",
            description: "Pagination cursor — the ID of the last item from the previous page.",
          },
        },
      },
    },
    {
      name: "stripe_get_subscription",
      displayName: "Get Stripe subscription",
      description: "Retrieve one subscription by ID, including its items and latest invoice.",
      parametersSchema: {
        type: "object",
        properties: {
          subscriptionId: { type: "string", description: "Stripe subscription ID (sub_...)." },
          account: { type: "string", description: "Stripe account identifier. Optional." },
        },
        required: ["subscriptionId"],
      },
    },
    {
      name: "stripe_list_charges",
      displayName: "List Stripe charges",
      description:
        "List charges filtered by customer / status / created window. Pagination via startingAfter.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          customerId: { type: "string", description: "Filter to one customer (cus_...)." },
          createdAfter: { type: "string", description: "ISO 8601 lower bound (inclusive)." },
          createdBefore: { type: "string", description: "ISO 8601 upper bound (inclusive)." },
          status: {
            type: "string",
            enum: ["succeeded", "pending", "failed"],
            description: "Charge status filter.",
          },
          limit: { type: "number", description: "Page size (default 25, max 100)." },
          startingAfter: { type: "string", description: "Pagination cursor." },
        },
      },
    },
    {
      name: "stripe_get_balance_summary",
      displayName: "Get Stripe balance summary",
      description:
        "Return the account's current available, pending, and reserved balances per currency. Wraps stripe.balance.retrieve.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
        },
      },
    },
    {
      name: "stripe_list_disputes",
      displayName: "List Stripe disputes",
      description:
        "List disputes (chargebacks). Defaults to status = 'needs_response' so agents only surface the actionable queue.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          status: {
            type: "string",
            enum: [
              "warning_needs_response",
              "warning_under_review",
              "warning_closed",
              "needs_response",
              "under_review",
              "won",
              "lost",
              "all",
            ],
            description: "Dispute status filter. Default 'needs_response'.",
          },
          limit: { type: "number", description: "Page size (default 25, max 100)." },
        },
      },
    },
    {
      name: "stripe_get_metrics_snapshot",
      displayName: "Get Stripe metrics snapshot",
      description:
        "Approximate revenue / growth / churn snapshot. Computed by aggregating subscriptions and charges on the fly. Returns MRR / ARR / active subs / 30d churn / 7d & 30d signups. Errors with [ESTRIPE_MIXED_CURRENCY] if active subscriptions span multiple currencies (no FX conversion in this version).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          asOfDate: {
            type: "string",
            description:
              "ISO 8601 timestamp the snapshot is computed against. Defaults to now. Only affects the 30d churn / 7d & 30d signups windows; balance and active-subs are real-time.",
          },
        },
      },
    },
    {
      name: "stripe_create_coupon",
      displayName: "Create Stripe coupon",
      description:
        "Create a new Stripe coupon. Gated by allowMutations on the plugin config. Provide either percentOff OR (amountOff + currency).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          name: {
            type: "string",
            description: "Display name shown to customers (e.g. 'Free month - winback Apr 2026').",
          },
          duration: {
            type: "string",
            enum: ["once", "repeating", "forever"],
            description:
              "How long the discount applies. 'repeating' requires durationInMonths.",
          },
          durationInMonths: {
            type: "number",
            description: "Required when duration='repeating'. Number of months the discount applies.",
          },
          percentOff: {
            type: "number",
            description: "Percent discount (1-100). Mutually exclusive with amountOff.",
          },
          amountOff: {
            type: "number",
            description:
              "Fixed-amount discount, in the smallest currency unit (cents). Requires currency. Mutually exclusive with percentOff.",
          },
          currency: {
            type: "string",
            description: "ISO currency code (lowercase, e.g. 'usd'). Required with amountOff.",
          },
          maxRedemptions: {
            type: "number",
            description: "Maximum total redemptions across all customers.",
          },
          metadata: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Arbitrary string metadata stored on the coupon.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional Stripe idempotency key. Reuse to safely retry a creation; Stripe returns the original coupon if it has been seen.",
          },
        },
        required: ["name", "duration"],
      },
    },
    {
      name: "stripe_create_promotion_code",
      displayName: "Create Stripe promotion code",
      description:
        "Create a customer-facing promotion code that wraps a coupon. Gated by allowMutations. If `code` is omitted, Stripe auto-generates one.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          couponId: {
            type: "string",
            description: "ID of the coupon this promotion code applies (e.g. from stripe_create_coupon).",
          },
          code: {
            type: "string",
            description:
              "Optional human-readable code (e.g. 'WINBACK-FRED'). Stripe auto-generates if omitted.",
          },
          customerId: {
            type: "string",
            description:
              "Optional. Restrict the code so only this customer can redeem it. Useful for one-off win-back / referral codes.",
          },
          maxRedemptions: { type: "number", description: "Max total redemptions." },
          expiresAt: {
            type: "string",
            description: "ISO 8601 timestamp the code expires.",
          },
          idempotencyKey: {
            type: "string",
            description: "Optional Stripe idempotency key.",
          },
        },
        required: ["couponId"],
      },
    },
    {
      name: "stripe_export_charges_csv",
      displayName: "Export Stripe charges to CSV",
      description:
        "Stream charges between `from` and `to` into a CSV file in the run workspace. Returns the file path, row count, and gross/net/refund summary. Doesn't email — calling skill should pass the path to email-tools if it wants to deliver the file.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Stripe account identifier. Optional." },
          from: { type: "string", description: "ISO 8601 lower bound (inclusive)." },
          to: { type: "string", description: "ISO 8601 upper bound (inclusive)." },
          columns: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional CSV columns. Default: created, customerEmail, amount, currency, status, refunded, fee, net, description.",
          },
          outputPath: {
            type: "string",
            description:
              "Optional absolute file path for the CSV. Defaults to a timestamped file under the run workspace.",
          },
        },
        required: ["from", "to"],
      },
    },
  ],
};

export default manifest;
