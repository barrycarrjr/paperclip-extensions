import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { TOOL_DEFS } from "./toolDefs.js";

const PLUGIN_ID = "amazon-tools";
const PLUGIN_VERSION = "0.1.0";

const accountItemSchema = {
  type: "object",
  required: ["key", "region", "marketplaceIds", "lwaClientIdRef", "lwaClientSecretRef", "refreshTokenRef", "allowedCompanies"],
  propertyOrder: [
    "name",
    "key",
    "allowedCompanies",
    "region",
    "marketplaceIds",
    "sellerId",
    "lwaClientIdRef",
    "lwaClientSecretRef",
    "refreshTokenRef",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description: "Short stable ID agents pass as `account` (e.g. 'main-store'). Lowercase, no spaces. Unique across accounts.",
    },
    name: {
      type: "string",
      title: "Display name",
      description: "Human-readable label shown in this settings form. Free-form; you can rename it later without breaking anything.",
    },
    region: {
      type: "string",
      title: "Region",
      enum: ["na", "eu", "fe"],
      description: "na = North America (US, CA, MX, BR). eu = Europe, Middle East, India. fe = Japan, Australia, Singapore.",
    },
    marketplaceIds: {
      type: "array",
      items: { type: "string" },
      title: "Marketplace IDs",
      description: "Amazon marketplace IDs to read, e.g. ATVPDKIKX0DER for amazon.com. The first one is the default.",
    },
    sellerId: {
      type: "string",
      title: "Seller (merchant) ID",
      description: "Seller Central → Settings → Account Info → Merchant Token. Only needed for merchant-fulfilled inventory.",
    },
    lwaClientIdRef: {
      type: "string",
      format: "secret-ref",
      title: "LWA client ID",
      description: "UUID of the Paperclip secret holding the app's Login with Amazon client ID (amzn1.application-oa2-client...).",
    },
    lwaClientSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "LWA client secret",
      description: "UUID of the Paperclip secret holding the app's Login with Amazon client secret.",
    },
    refreshTokenRef: {
      type: "string",
      format: "secret-ref",
      title: "Refresh token",
      description: "UUID of the Paperclip secret holding the refresh token from self-authorizing the app (Atzr|...).",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description: "Companies whose agents may read this seller account. Normally just the company that owns the store. Empty = unusable.",
    },
  },
} as const;

const SETUP_INSTRUCTIONS = `# Setup: Amazon Seller Tools

Gives agents **read-only** access to your own Amazon Seller Central data: orders (without buyer details), inventory, settlements, financial events and reports. The plugin has no tool that changes anything on Amazon. Reckon on **about 20 minutes** the first time.

---

## 1. Register as a private developer

- In Seller Central, open **Apps and Services → Develop Apps** (the Solution Provider Portal).
- Fill in the developer profile and choose **Private developer: I build application(s) that integrate my own company with Amazon Selling Partner APIs**.
- Request only these roles:
  - **Finance and Accounting** (settlements, financial events, settlement reports)
  - **Inventory and Order Tracking** (orders, FBA inventory)
  - **Selling Partner Insights** (sales and traffic report), if you want it
  - **Product Listing**, only if you want merchant-fulfilled inventory. Amazon bundles read and write in this role; the plugin never calls a write.
- Do **not** request roles for buyer personal information. The plugin does not use them.

Amazon reviews the profile; this can take a few days.

---

## 2. Create the app and self-authorize it

- In **Develop Apps**, click **Add new app client**. API type: **SP API**. Pick the same roles.
- Open the app's **LWA credentials** and copy the **client ID** and **client secret**.
- Click the arrow next to **Edit App → Authorize**, then **Authorize app**. Copy the **refresh token** (starts with \`Atzr|\`).

> If you change the app's roles later, authorize it again to get a new refresh token.

---

## 3. Store the three values as Paperclip secrets

In Paperclip, switch to the company that owns the store, go to **Secrets → Add**, and create one secret each for the client ID, client secret and refresh token (e.g. \`AMAZON_LWA_CLIENT_ID\`, \`AMAZON_LWA_CLIENT_SECRET\`, \`AMAZON_REFRESH_TOKEN\`). Copy each secret's UUID.

---

## 4. Configure the plugin (**Configuration** tab)

Under **Seller accounts**, click **+ Add item**:

| Field | Value |
|---|---|
| **Identifier** | e.g. \`main-store\` |
| **Region** | \`na\`, \`eu\` or \`fe\` |
| **Marketplace IDs** | e.g. \`ATVPDKIKX0DER\` (US), \`A2EUQ1WTGCTBG2\` (CA), \`A1F83G8C2ARO7P\` (UK), \`A1PA6795UKMFR9\` (DE) |
| **Seller ID** | only for merchant-fulfilled inventory |
| **LWA client ID / secret / refresh token** | the three secret UUIDs from step 3 |
| **Allowed companies** | tick the company that owns the store |

Set **Default account**, **save**, then click **Test Configuration**. The test signs in to Amazon and checks that each marketplace ID belongs to the account.

---

## Troubleshooting

- **Test Configuration says a secret was not found**: save the configuration first, wait 30 seconds (Paperclip refreshes its list of secrets the plugin may read every 30 seconds), then test again.
- **[EAMAZON_AUTH] invalid_grant**: the refresh token is wrong or was replaced. Authorize the app again (step 2) and update the secret.
- **[EAMAZON_FORBIDDEN]**: the app lacks the role for that data. Add the role, then authorize again.
- **[EAMAZON_RATE_LIMIT]**: Amazon kept throttling after several retries with back-off. Wait a minute and try again.
- **A report returns [EREPORT_TYPE_BLOCKED]**: only the report types listed in this plugin can be read, so order reports with buyer details stay out of agent context.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Amazon Seller Tools",
  setupInstructions: SETUP_INSTRUCTIONS,
  description:
    "Read-only Amazon Seller Central data for agents: orders without buyer details, FBA and merchant inventory, settlements, financial events and reports. Never writes to Amazon. Per-account allowedCompanies.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["defaultAccount", "accounts"],
    properties: {
      defaultAccount: {
        type: "string",
        title: "Default account",
        "x-paperclip-optionsFromSibling": {
          sibling: "accounts",
          valueKey: "key",
          labelKey: "name",
        },
        description:
          "Account used when an agent omits `account`. Still subject to that account's Allowed companies.",
      },
      accounts: {
        type: "array",
        title: "Seller accounts",
        description: "One entry per Amazon seller account (one self-authorized private developer app).",
        items: accountItemSchema,
      },
    },
  },
  tools: TOOL_DEFS,
};

export default manifest;
