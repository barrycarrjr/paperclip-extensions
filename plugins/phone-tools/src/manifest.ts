import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "phone-tools";
const PLUGIN_VERSION = "0.1.0";

const accountItemSchema = {
  type: "object",
  required: ["key", "engine", "apiKeyRef", "allowedCompanies"],
  propertyOrder: [
    "key",
    "displayName",
    "engine",
    "apiKeyRef",
    "webhookSecretRef",
    "engineConfig",
    "defaultNumberId",
    "defaultAssistantId",
    "allowedNumbers",
    "allowedAssistants",
    "recordingEnabled",
    "maxConcurrentCalls",
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass to phone tools (e.g. 'main', 'private'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it. Must be unique across accounts.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description: "Human-readable label shown on this settings page only.",
    },
    engine: {
      type: "string",
      enum: ["vapi", "diy"],
      default: "vapi",
      title: "Engine",
      description:
        "Which voice-AI backend handles this account. 'vapi' = Vapi.ai (managed, hosted; ~$0.05/min on top of model costs). 'diy' = self-hosted Jambonz + OpenAI Realtime (ships in v0.2.0; selecting it now returns [EENGINE_NOT_AVAILABLE] so the field is forward-compatible).",
    },
    apiKeyRef: {
      type: "string",
      format: "secret-ref",
      title: "Engine API key",
      description:
        "Paperclip secret holding the engine's API key. For Vapi: get a Private API Key from https://dashboard.vapi.ai → Org → API Keys (NOT the public/web key — those can't initiate calls). Create the secret first on the company's Secrets page; never paste the raw token here.",
    },
    webhookSecretRef: {
      type: "string",
      format: "secret-ref",
      title: "Webhook signing secret",
      description:
        "Paperclip secret holding the HMAC secret used to verify inbound webhooks. For Vapi: configure under Org → Server URL (the 'serverUrlSecret' field). Set the matching value as a Paperclip secret and reference it here. Required: webhooks without a verified signature are rejected and no events are emitted. Leaving this blank disables verification (useful only for local dev — log warning emitted at startup).",
    },
    engineConfig: {
      type: "object",
      title: "Engine-specific config",
      description:
        "Engine-specific extras. For Vapi: leave empty in v0.1.0 (no extras needed). For DIY (v0.2.0): jambonzAccountSid, jambonzApplicationSid, openaiApiKeyRef, realtimeModel, realtimeVoice.",
      additionalProperties: true,
    },
    defaultNumberId: {
      type: "string",
      title: "Default phone-number ID",
      description:
        "Engine-side phone-number ID used when phone_call_make omits `from`. Get the ID by running phone_number_list once after setup — it's the engine's UUID, NOT the E.164 number. Must be in 'Allowed phone-number IDs' if that list is set.",
    },
    defaultAssistantId: {
      type: "string",
      title: "Default assistant ID",
      description:
        "Engine-side assistant ID used when phone_call_make omits `assistant`. Get the ID by running phone_assistant_list, OR create one with phone_assistant_create and copy the returned ID. Must be in 'Allowed assistant IDs' if that list is set.",
    },
    allowedNumbers: {
      type: "array",
      items: { type: "string" },
      title: "Allowed phone-number IDs",
      description:
        "If non-empty, restricts phone_call_make to these phone-number IDs. Useful when one Vapi org has many numbers but only one should be visible to agents in this company. Empty = unrestricted within the account.",
    },
    allowedAssistants: {
      type: "array",
      items: { type: "string" },
      title: "Allowed assistant IDs",
      description:
        "If non-empty, restricts phone_call_make to these assistant IDs (and prevents phone_call_make from accepting an inline ad-hoc assistant config). Empty = all assistants under this account allowed, AND inline configs are accepted.",
    },
    recordingEnabled: {
      type: "boolean",
      default: false,
      title: "Enable call recording",
      description:
        "When true, the engine records the audio and the recording URL is available via phone_call_recording_url. CONSENT NOTICE: many jurisdictions require an audible disclosure ('this call may be recorded') at the start. The plugin does not inject this — your assistant's firstMessage must include it. Default false to be conservative.",
    },
    maxConcurrentCalls: {
      type: "number",
      default: 3,
      title: "Max concurrent outbound calls",
      description:
        "Per-account cap on simultaneous outbound calls. phone_call_make returns [ECONCURRENCY_LIMIT] if exceeded. Prevents a runaway agent from blowing through PSTN minutes. Default 3.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may use this phone account. Tick 'Portfolio-wide' for ['*']; otherwise tick specific companies. Empty = unusable (fail-safe deny). A phone account typically belongs to one LLC — prefer single-company lists.",
    },
  },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Phone (AI calls via 3CX + Vapi/DIY)",
  description:
    "Place outbound and answer inbound AI-driven phone calls via the operator's 3CX PBX. v0.1.0 backs onto Vapi.ai; v0.2.0 will add a self-hosted DIY engine (jambonz + OpenAI Realtime) selectable from the same engine dropdown. Multi-account, per-account allowedCompanies, mutations gated, optional call recording per account.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "webhooks.receive",
    "events.emit",
    "plugin.state.read",
    "plugin.state.write",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  webhooks: [
    {
      endpointKey: "vapi",
      displayName: "Vapi inbound webhook",
      description:
        "Configure this URL on Vapi (Org → Server URL): https://<paperclip-host>/api/plugins/phone-tools/webhooks/vapi — Vapi posts assistant-request, status-update, transcript, end-of-call-report, and function-call events here.",
    },
    {
      endpointKey: "diy",
      displayName: "DIY engine inbound webhook (v0.2.0)",
      description:
        "Reserved for the v0.2.0 DIY engine. Jambonz application URL: https://<paperclip-host>/api/plugins/phone-tools/webhooks/diy. No-op in v0.1.0 (returns 200 without emitting events).",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["allowMutations", "defaultAccount", "accounts"],
    properties: {
      allowMutations: {
        type: "boolean",
        default: false,
        title: "Allow place-call / hangup / assistant mutations",
        description:
          "Master switch for every tool that can spend money or modify the engine state: phone_call_make, phone_call_end, phone_assistant_create, phone_assistant_update, phone_assistant_delete. Off (default) = those tools return [EDISABLED]. Read tools (status, transcript, list, recording_url) are unaffected. Strongly recommended to leave OFF until you've reviewed which agents/skills can place outbound calls — PSTN minutes cost money and a misconfigured assistant can talk to anyone.",
      },
      defaultAccount: {
        type: "string",
        title: "Default account key",
        description:
          "Identifier of the account used when an agent omits the `account` parameter. Strict: if the calling company isn't in the default account's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no automatic fallback). Leave blank to require an explicit `account` per call.",
      },
      accounts: {
        type: "array",
        title: "Phone accounts",
        description:
          "One entry per backend voice engine you've set up. Most operators will have one Vapi account per LLC; later, you may add a 'private' account using the DIY engine for sensitive calls.",
        items: accountItemSchema,
      },
    },
    required: ["accounts"],
  },
  tools: [
    {
      name: "phone_call_make",
      displayName: "Place outbound phone call",
      description:
        "Place an AI-driven outbound phone call to an E.164 number. The engine connects, the assistant introduces itself with its firstMessage, and conducts the conversation. Returns immediately with a callId; use phone_call_status to poll, or subscribe to plugin.phone-tools.call.ended to be notified. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description: "Account identifier as configured on the plugin settings page. Optional — falls back to defaultAccount.",
          },
          to: {
            type: "string",
            description: "E.164 destination number (e.g. '+15551234567'). Required.",
          },
          from: {
            type: "string",
            description:
              "Engine-side phone-number ID to call from (NOT the E.164 number — the UUID returned by phone_number_list). Optional — falls back to defaultNumberId. Must be in allowedNumbers if that list is set.",
          },
          assistant: {
            description:
              "Either an assistant ID (string) referring to a saved assistant on the engine, OR an inline assistant config object. Inline configs are rejected if the account has a non-empty allowedAssistants list.",
            oneOf: [
              { type: "string", description: "Assistant ID." },
              {
                type: "object",
                properties: {
                  name: { type: "string" },
                  systemPrompt: { type: "string" },
                  firstMessage: { type: "string" },
                  voice: { type: "string", description: "Engine voice spec, e.g. '11labs:rachel'." },
                  model: { type: "string", description: "Engine model spec, e.g. 'openai:gpt-4o'." },
                },
                required: ["name", "systemPrompt"],
              },
            ],
          },
          metadata: {
            type: "object",
            additionalProperties: true,
            description: "Free-form metadata persisted on the engine call record. Useful for correlation back to the calling skill / issue.",
          },
          idempotencyKey: {
            type: "string",
            description:
              "Optional. Identical key within 24 h returns the existing callId rather than placing a duplicate call.",
          },
        },
        required: ["to", "assistant"],
      },
    },
    {
      name: "phone_call_status",
      displayName: "Get phone call status",
      description:
        "Poll the current status of a call (queued, ringing, in-progress, ended, failed, no-answer, busy, canceled) plus duration, cost, end reason. Cached briefly per (account, callId) for completed calls.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Engine call ID returned by phone_call_make or surfaced via the call.received event." },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_call_transcript",
      displayName: "Get phone call transcript",
      description:
        "Retrieve the dialog transcript for a call. format='plain' returns a single string; format='structured' returns role-tagged turns with timestamps. Available once the call ends; partial transcripts during the call arrive via plugin.phone-tools.call.transcript.partial events instead.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Call ID." },
          format: {
            type: "string",
            enum: ["plain", "structured"],
            default: "plain",
            description: "'plain' = single string. 'structured' = array of {role, text, ts} turns.",
          },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_call_recording_url",
      displayName: "Get phone call recording URL",
      description:
        "Return a short-lived signed URL to the call audio recording. Only available if the account has recordingEnabled=true and the call has ended. Returns [EVAPI_NOT_FOUND] otherwise.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Call ID." },
          expiresInSec: {
            type: "number",
            default: 3600,
            description: "Hint for how long the URL should remain valid. Engine may cap to its own maximum.",
          },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_call_list",
      displayName: "List phone calls",
      description:
        "List calls (inbound, outbound, or both) with optional filters. Filtered to numbers/assistants in the calling company's allow-list — calls placed/received under another company's allow-list are NOT returned.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          since: { type: "string", description: "ISO 8601 timestamp; only calls created at or after this time." },
          until: { type: "string", description: "ISO 8601 timestamp; only calls created at or before this time." },
          direction: {
            type: "string",
            enum: ["inbound", "outbound", "any"],
            default: "any",
            description: "Direction filter.",
          },
          assistant: { type: "string", description: "Filter to one assistant ID." },
          status: {
            type: "string",
            enum: ["queued", "ringing", "in-progress", "ended", "failed", "no-answer", "busy", "canceled"],
            description: "Filter to one status.",
          },
          limit: { type: "number", default: 25, description: "Page size. Max 100." },
          cursor: { type: "string", description: "Opaque cursor returned by a previous call." },
        },
      },
    },
    {
      name: "phone_call_end",
      displayName: "End phone call (force hangup)",
      description:
        "Force-end an active call. Useful if a call has gone off the rails. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          callId: { type: "string", description: "Call ID." },
          reason: {
            type: "string",
            description: "Optional human-readable reason persisted on the call's metadata.",
          },
        },
        required: ["callId"],
      },
    },
    {
      name: "phone_assistant_list",
      displayName: "List phone assistants",
      description:
        "List the named, reusable AI personas configured on the engine. Filtered to allowedAssistants if the account has that list set.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },
    {
      name: "phone_assistant_create",
      displayName: "Create phone assistant",
      description:
        "Create a new named assistant on the engine. Idempotent on name within the account: calling twice with the same name returns the existing assistant. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          name: {
            type: "string",
            description: "Stable, human-readable name (e.g. 'AppointmentBookerV2'). Used for idempotency.",
          },
          systemPrompt: {
            type: "string",
            description: "The system prompt that defines the assistant's persona and rules. Be specific; voice models follow instructions less precisely than chat.",
          },
          firstMessage: {
            type: "string",
            description: "First spoken line. For recorded-call jurisdictions include the consent disclosure here, e.g. 'This call may be recorded.'",
          },
          voice: {
            type: "string",
            description: "Engine voice spec, e.g. '11labs:rachel' or 'cartesia:sonic-male'. Engine-specific format.",
          },
          model: {
            type: "string",
            description: "Engine model spec, e.g. 'openai:gpt-4o'. Engine-specific format.",
          },
          tools: {
            type: "array",
            items: { type: "string" },
            description: "Names of plugin-internal tools the in-call assistant may invoke mid-call. v0.1.0 ships only 'take_note'; full set lands in v0.1.1.",
          },
          idempotencyKey: {
            type: "string",
            description: "Optional. Subsequent calls with the same key short-circuit to the existing assistant.",
          },
        },
        required: ["name", "systemPrompt"],
      },
    },
    {
      name: "phone_assistant_update",
      displayName: "Update phone assistant",
      description: "Patch an existing assistant. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          assistantId: { type: "string", description: "Engine assistant ID." },
          name: { type: "string" },
          systemPrompt: { type: "string" },
          firstMessage: { type: "string" },
          voice: { type: "string" },
          model: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
        },
        required: ["assistantId"],
      },
    },
    {
      name: "phone_assistant_delete",
      displayName: "Delete phone assistant",
      description: "Remove an assistant from the engine. Mutation, gated by allowMutations.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          assistantId: { type: "string", description: "Engine assistant ID." },
        },
        required: ["assistantId"],
      },
    },
    {
      name: "phone_number_list",
      displayName: "List phone numbers",
      description:
        "List the engine-side phone numbers configured under the account. Returns id, e164, label, and (where applicable) the SIP-trunk identifier so you can confirm a number is bound to your 3CX trunk. Filtered to allowedNumbers if the account has that list set.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
        },
      },
    },
  ],
};

export default manifest;
