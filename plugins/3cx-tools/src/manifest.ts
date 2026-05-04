import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "3cx-tools";
const PLUGIN_VERSION = "0.3.0";

const companyRoutingItemSchema = {
  type: "object",
  required: ["companyId"],
  propertyOrder: [
    "companyId",
    "extensionRanges",
    "queueIds",
    "dids",
    "outboundDialPrefix",
    "queueThresholds",
  ],
  properties: {
    companyId: {
      type: "string",
      format: "company-id",
      title: "Company",
      description:
        "Paperclip company that owns the resources listed below. Each company appears at most once per account.",
    },
    extensionRanges: {
      type: "array",
      items: { type: "string" },
      title: "Extension ranges",
      description:
        "Internal extension numbers belonging to this company. Each entry is either a single extension (e.g. \"201\") or a contiguous range with a hyphen (e.g. \"100-119\"). LEAVE EMPTY for shared-extensions setups (one physical extension serves multiple LLCs and the outbound trunk is selected at dial time via prefix). When empty, click-to-call falls back to allowMutations + the daily cap as gates, and per-LLC outbound call attribution is unavailable until trunk-based scoping ships in v0.2. When populated, used by every read tool to filter results client-side and by click-to-call to validate fromExtension is in scope.",
    },
    queueIds: {
      type: "array",
      items: { type: "string" },
      title: "Queue extensions or IDs",
      description:
        "Queue extensions (the number callers dial — e.g. \"800\" for support) or 3CX internal queue IDs that route to this company. Use pbx_queue_list once after setup to discover the IDs.",
    },
    dids: {
      type: "array",
      items: { type: "string" },
      title: "DIDs (E.164)",
      description:
        "External phone numbers (DIDs) routed to this company, in E.164 format (e.g. \"+18005551212\"). Used to attribute inbound calls when filtering active calls and call history.",
    },
    outboundDialPrefix: {
      type: "string",
      title: "Outbound dial prefix",
      description:
        "Optional. Single digit (or short string) that 3CX's outbound rules use to route this company's outbound calls through the right trunk — the same prefix a human at this company's extension would press before dialing (e.g. \"9\" for one LLC, \"8\" for another). When set, pbx_click_to_call from an agent in this company prepends the prefix to the destination so 3CX picks the correct outbound trunk. The plugin strips any leading \"+\" from the destination before prepending, so toNumber=\"+18005551212\" with prefix=\"9\" sends \"918005551212\" to 3CX. Leave blank if you don't want prefix-based trunk selection (3CX's default outbound rule applies).",
    },
    queueThresholds: {
      type: "array",
      title: "Queue threshold alerts (v0.3 realtime)",
      description:
        "Optional. Per-queue depth thresholds that emit a synthetic plugin.3cx-tools.queue.threshold event when crossed. Only consumed by the realtime WebSocket layer; safe to leave empty if you're not using event subscriptions.",
      items: {
        type: "object",
        required: ["queueId", "depth"],
        propertyOrder: ["queueId", "depth", "longestWaitSec"],
        properties: {
          queueId: { type: "string", title: "Queue ID or extension" },
          depth: {
            type: "integer",
            minimum: 1,
            title: "Depth threshold",
            description:
              "Emit threshold event when waiting calls in this queue is greater than or equal to this number.",
          },
          longestWaitSec: {
            type: "integer",
            minimum: 1,
            title: "Longest-wait threshold (seconds)",
            description:
              "Optional. Also emit when the longest-waiting caller has been queued for at least this many seconds.",
          },
        },
      },
    },
  },
} as const;

const companyTenantItemSchema = {
  type: "object",
  required: ["companyId", "tenantId"],
  propertyOrder: ["companyId", "tenantId"],
  properties: {
    companyId: {
      type: "string",
      format: "company-id",
      title: "Company",
      description: "Paperclip company that owns this tenant.",
    },
    tenantId: {
      type: "string",
      title: "3CX tenant_id",
      description:
        "Tenant identifier from 3CX's Multi-Company license configuration. The plugin sends this in the X-3CX-Tenant header on every API call so 3CX scopes results server-side.",
    },
  },
} as const;

const accountItemSchema = {
  type: "object",
  required: [
    "key",
    "pbxBaseUrl",
    "clientIdRef",
    "clientSecretRef",
    "mode",
    "allowedCompanies",
  ],
  propertyOrder: [
    "key",
    "displayName",
    "pbxBaseUrl",
    "pbxVersion",
    "clientIdRef",
    "clientSecretRef",
    "mode",
    "companyRouting",
    "companyTenants",
    "allowedCompanies",
    "exposeRecordings",
    "maxClickToCallPerDay",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Stable short ID agents pass to pbx tools (e.g. \"main\"). Lowercase, no spaces. Once heartbeats reference it, don't change it. Must be unique across accounts.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown on this settings page only (e.g. \"Primary PBX\"). Free-form.",
    },
    pbxBaseUrl: {
      type: "string",
      title: "PBX base URL",
      description:
        "Fully-qualified URL for the PBX, scheme included. Example: https://pbx.example.com. Don't include a path. The plugin appends /xapi/v1/... and /connect/token automatically. The PBX must be reachable from this Paperclip instance — open the network path before clicking Save.",
    },
    pbxVersion: {
      type: "string",
      enum: ["20", "18"],
      default: "20",
      title: "3CX version",
      description:
        "v0.1.0 supports v20 (XAPI). v18 (Call Control API) ships in a future release; selecting it now returns [EENGINE_NOT_AVAILABLE].",
    },
    clientIdRef: {
      type: "string",
      format: "secret-ref",
      title: "XAPI client_id",
      description:
        "Paperclip secret holding the XAPI client_id. To get it: log into 3CX admin → Integrations → API → Add (or pick an existing client) → copy the 'Client ID'. Create the secret first on the company's Secrets page; never paste the raw client_id here. The client must have at least 'Read' scope; for click-to-call / park / transfer / hangup it also needs 'Call Control'.",
    },
    clientSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "XAPI client_secret",
      description:
        "Paperclip secret holding the XAPI client_secret paired with the client_id above. 3CX shows this only once when the API client is created — copy it then. If you've lost it, regenerate the secret in 3CX admin and update the Paperclip secret.",
    },
    mode: {
      type: "string",
      enum: ["single", "manual", "native"],
      default: "manual",
      title: "Multi-company mode",
      description:
        "Tells the plugin how the PBX is partitioned across Paperclip companies. 'single' = the whole PBX is one company (no per-company filter — Allowed companies is the entire access list). 'manual' = one PBX shared across multiple companies, partitioned by extension/queue/DID convention (you fill in the routing table below). 'native' = the PBX has 3CX's Multi-Company license and you map each Paperclip company to a 3CX tenant_id.",
    },
    companyRouting: {
      type: "array",
      title: "Per-company routing (manual mode)",
      description:
        "Only used when mode = manual. One entry per Paperclip company, listing the extensions / queue IDs / DIDs that company owns on this shared PBX. Every read tool filters results client-side against these. Click-to-call and other mutations validate that the agent's chosen extension/call is in scope before hitting 3CX.",
      "x-paperclip-showWhen": { mode: "manual" },
      items: companyRoutingItemSchema,
    },
    companyTenants: {
      type: "array",
      title: "Per-company tenants (native mode)",
      description:
        "Only used when mode = native. One entry per Paperclip company, mapping it to the 3CX tenant_id that owns its extensions/queues/DIDs. The plugin sends this tenant_id in the X-3CX-Tenant header so 3CX scopes results server-side.",
      "x-paperclip-showWhen": { mode: "native" },
      items: companyTenantItemSchema,
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call pbx_* tools against this account at all — independent of mode. Even in manual or native mode, a company must be listed here AND have a routing/tenant entry to make calls. Empty = unusable (fail-safe deny). Use ['*'] for portfolio-wide (only meaningful in single mode).",
    },
    exposeRecordings: {
      type: "boolean",
      default: false,
      title: "Expose call recording URLs",
      description:
        "When enabled, pbx_call_history returns the recording URL (if 3CX has one for the call). Off by default for consent / privacy. Many jurisdictions require an audible 'this call may be recorded' disclosure — make sure your IVR or queue greeting handles that before flipping this on.",
    },
    maxClickToCallPerDay: {
      type: "integer",
      default: 50,
      minimum: 0,
      title: "Max click-to-call per day per company",
      description:
        "Hard cap on pbx_click_to_call invocations per (company, calendar-day, account). Prevents runaway loops if a skill misbehaves; PSTN minutes cost real money. Set 0 to disable click-to-call for this account regardless of allowMutations.",
    },
  },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "3CX PBX Tools",
  description:
    "Direct 3CX PBX integration for operational visibility (queue depth, parked calls, today's stats, agent presence, call history) and human-driven call control (click-to-call, park, transfer, hangup) — plus optional realtime WebSocket events. Multi-account; multi-company-mode (single / manual / native); per-account allowedCompanies; mutations gated.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["allowMutations", "defaultAccount", "accounts", "userExtensionMap"],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow click-to-call / park / transfer / hangup",
        description:
          "Master switch for every tool that mutates PBX state or originates a call. Off (default) = read-only; mutation tools return [EDISABLED]. On = pbx_click_to_call, pbx_park_call, pbx_pickup_park, pbx_transfer_call, pbx_hangup_call are all live. PSTN minutes cost real money and a misrouted click-to-call disturbs a real human's phone — leave this off until you've reviewed which agents and skills can originate calls.",
        default: false,
      },
      defaultAccount: {
        type: "string",
        title: "Default account key",
        description:
          "Account used when an agent omits the `account` parameter. Strict: if the calling company isn't in the default account's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no fallback). Leave blank to require an explicit `account` on every call.",
      },
      accounts: {
        type: "array",
        title: "3CX accounts",
        description:
          "One entry per 3CX PBX you want Paperclip to talk to. Most operators have one. Every account must list 'Allowed companies' — empty list = unusable.",
        items: accountItemSchema,
      },
      userExtensionMap: {
        type: "array",
        title: "User → extension map",
        description:
          "Optional. Maps Paperclip users to their 3CX extension so an agent (e.g. Clippy) can invoke pbx_click_to_call as 'call X from my extension' without the user typing their extension number every time. Each entry needs the extension and at least one identifier (Paperclip user UUID, email, or both). Resolution is case-insensitive on email. Empty list = the caller must always pass `fromExtension` explicitly.",
        items: {
          type: "object",
          required: ["extension"],
          propertyOrder: ["userId", "userEmail", "extension", "label"],
          properties: {
            userId: {
              type: "string",
              format: "user-id",
              title: "Paperclip user",
              description:
                "Optional. UUID of a Paperclip board user. Preferred when stable. If both userId and userEmail are set, either match wins.",
            },
            userEmail: {
              type: "string",
              title: "Email (case-insensitive)",
              description:
                "Optional. Email address — useful when the agent only knows who's calling from a chat actor's email. Lowercased on both sides before comparison.",
            },
            extension: {
              type: "string",
              title: "3CX extension",
              description:
                "Internal extension number to ring first when this user originates a click-to-call (e.g. \"200\").",
            },
            label: {
              type: "string",
              title: "Display label",
              description: "Free-form note shown only in this settings page.",
            },
          },
        },
      },
    },
    required: ["accounts"],
  },
  tools: [
    // ─── Phase 1: Read tools ───────────────────────────────────────
    {
      name: "pbx_queue_list",
      displayName: "List PBX queues",
      description:
        "List queues on the account, scoped to the calling company. Returns id, name, extension, agentsOn, depth (waiting calls), longestWaitSec.",
      parametersSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description:
              "Account identifier as configured on the plugin settings page. Optional — falls back to defaultAccount.",
          },
        },
      },
    },
    {
      name: "pbx_queue_status",
      displayName: "Get PBX queue status",
      description:
        "Snapshot of one queue right now: depth, longest wait, agents on / available, today's offered/answered/abandoned counts, average handle time. Pass either the queue ID or its extension number.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          queue: {
            type: "string",
            description:
              "Queue ID (3CX internal) or extension number (the number callers dial, e.g. '800'). Either works; the plugin resolves to the same queue.",
          },
        },
        required: ["queue"],
      },
    },
    {
      name: "pbx_parked_calls",
      displayName: "List parked calls",
      description:
        "Calls currently sitting in park slots, scoped to the calling company. Returns slot, callerNumber, parkedSinceSec, originalExtension when available.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },
    {
      name: "pbx_active_calls",
      displayName: "List active calls",
      description:
        "Calls currently in progress on the PBX, scoped to the calling company's extensions / queues / DIDs. Returns count and per-call: callId, fromNumber, toNumber, extension, queue, startedAt, durationSec, direction.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },
    {
      name: "pbx_agent_status",
      displayName: "List agent status",
      description:
        "Agent presence and call state, scoped to the company's extensions. Pass `extension` to look up exactly one. Each result: extension, name, presence ('available' | 'busy' | 'away' | 'dnd' | 'offline'), inCall, currentCallSec, queueMemberships.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          extension: {
            type: "string",
            description:
              "Optional. If provided, returns just that one extension's status. Must be in the company's extension scope.",
          },
        },
      },
    },
    {
      name: "pbx_today_stats",
      displayName: "Get today's PBX stats",
      description:
        "Today's call volumes for the company (or one queue if `queue` provided). Returns offered, answered, abandoned, internalCalls, avgWaitSec, avgHandleSec, peakDepth, abandonRate, sla.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          queue: {
            type: "string",
            description: "Optional queue ID or extension to narrow to one queue.",
          },
          direction: {
            type: "string",
            enum: ["inbound", "outbound", "internal"],
            description: "Optional direction filter.",
          },
        },
      },
    },
    {
      name: "pbx_call_history",
      displayName: "Get call history",
      description:
        "Paginated list of completed calls in a window, scoped to the company. Useful for end-of-day reports or troubleshooting. Returns calls + nextCursor for pagination. recordingUrl present only if exposeRecordings is enabled on the account.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          since: {
            type: "string",
            description:
              "ISO 8601 timestamp — only calls that started at or after this time. Required.",
          },
          until: {
            type: "string",
            description: "Optional ISO 8601 upper bound (exclusive). Defaults to 'now'.",
          },
          direction: {
            type: "string",
            enum: ["inbound", "outbound", "internal"],
            description: "Optional direction filter.",
          },
          extension: {
            type: "string",
            description:
              "Optional extension filter. Must be in the company's scope when in manual mode.",
          },
          queue: { type: "string", description: "Optional queue filter." },
          limit: {
            type: "integer",
            description: "Page size (default 100, max 500).",
            minimum: 1,
            maximum: 500,
          },
          cursor: {
            type: "string",
            description: "Opaque pagination cursor returned by a previous call.",
          },
        },
        required: ["since"],
      },
    },
    {
      name: "pbx_did_list",
      displayName: "List DIDs",
      description:
        "External phone numbers (DIDs) routed to the calling company. Returns e164, label, routedTo, queue.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },
    {
      name: "pbx_extension_list",
      displayName: "List extensions",
      description:
        "All extensions visible to the calling company. Each: number, displayName, type ('user' | 'queue' | 'ringgroup' | 'system'), email when present.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },

    // ─── Phase 2: Mutation tools ──────────────────────────────────
    {
      name: "pbx_click_to_call",
      displayName: "Originate a call (click-to-call)",
      description:
        "Originate a call from a human extension to a destination. 3CX rings fromExtension first; once the human picks up, 3CX dials toNumber. Either pass `fromExtension` directly OR pass `fromUserId` / `fromUserEmail` and the plugin resolves the extension from the configured user→extension map. The destination accepts any common phone format ('555.123.4567', '+15551234567', '(555) 123-4567', '15551234567') — the plugin normalizes to E.164 before applying any per-company outbound dial prefix. Mutation, gated by allowMutations and the per-day cap.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          fromExtension: {
            type: "string",
            description:
              "Internal extension to ring first. Must be in the company's extension scope when mode = manual; otherwise [ESCOPE_VIOLATION]. Optional if fromUserId or fromUserEmail is provided and the userExtensionMap has a matching entry.",
          },
          fromUserId: {
            type: "string",
            description:
              "Optional. Paperclip user UUID — the plugin looks up the user's extension from `userExtensionMap` in instance config. Use this when the agent knows who's asking ('call from my extension') without knowing the extension number.",
          },
          fromUserEmail: {
            type: "string",
            description:
              "Optional. Email of the calling user (case-insensitive). Falls back to lookup via `userExtensionMap` when fromExtension and fromUserId are both absent.",
          },
          toNumber: {
            type: "string",
            description:
              "Destination — any common format. The plugin normalizes 10/11-digit US/CA numbers to E.164, accepts '+' international forms, and passes internal 3-5 digit extensions through unchanged.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional. Repeat invocations with the same key within 24h return the existing callId rather than originating a duplicate call.",
          },
        },
        required: ["toNumber"],
      },
    },
    {
      name: "pbx_park_call",
      displayName: "Park an active call",
      description:
        "Park a currently-active call into a slot. If `slot` is omitted, 3CX assigns one and returns it. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "callId returned by pbx_active_calls." },
          slot: { type: "string", description: "Optional preferred park slot." },
        },
        required: ["callId"],
      },
    },
    {
      name: "pbx_pickup_park",
      displayName: "Pick up a parked call",
      description:
        "Retrieve a parked call to a specific extension. Mutation, gated. atExtension must be in the company's scope when manual mode is in effect.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          slot: { type: "string", description: "Park slot to pick up from." },
          atExtension: {
            type: "string",
            description: "Extension that should be connected to the parked call.",
          },
        },
        required: ["slot", "atExtension"],
      },
    },
    {
      name: "pbx_transfer_call",
      displayName: "Transfer an active call",
      description:
        "Transfer an active call to another extension. mode='blind' (default) is one-shot; 'attended' rings the target before bridging (3CX-version-dependent). Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "callId of the active call." },
          toExtension: {
            type: "string",
            description:
              "Destination extension. Must be in the company's scope when manual mode is in effect.",
          },
          mode: {
            type: "string",
            enum: ["blind", "attended"],
            default: "blind",
            description: "'blind' = direct hand-off. 'attended' = consult before bridging.",
          },
        },
        required: ["callId", "toExtension"],
      },
    },
    {
      name: "pbx_hangup_call",
      displayName: "Hang up an active call",
      description:
        "Force-end an active call. Used by escalation flows or to clear stuck calls. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "callId of the call to terminate." },
        },
        required: ["callId"],
      },
    },
  ],
};

export default manifest;
