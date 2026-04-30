# Paperclip plugins — author conventions

If you're building a new Paperclip plugin in this directory, read this first.
It documents the conventions every plugin in `paperclip-extensions/plugins/`
follows. The three reference plugins are:

- `email-tools/` — SMTP send (multi-mailbox)
- `social-poster/` — Facebook / Instagram / X
- `google-analytics/` — GA4 + Search Console read

Mirror their layout (`src/{index.ts, manifest.ts, worker.ts, companyAccess.ts}`,
`package.json` with `paperclipPlugin: { manifest, worker }`, `tsconfig.json`).

---

## 1. The resource-array shape — every plugin must follow this

If your plugin's `instanceConfigSchema` has an array of items the operator can
configure (mailboxes, social accounts, GA sites, Stripe accounts, GitHub orgs,
etc.) — **every item in that array MUST have these four fields**, in this
order, before any plugin-specific fields:

| Field | JSON property | Form title | Purpose |
|---|---|---|---|
| Display name | `name` | `Display name` | Human-readable label shown as the row heading in the settings form. Free-form. The user can rename it later without breaking anything. |
| Identifier | `key` | `Identifier` | Short stable ID agents pass when calling tools (e.g. `mailbox: "personal"`). Lowercase, no spaces, unique within the array. **Don't rename once skills reference it.** |
| Allowed companies | `allowedCompanies` | `Allowed companies` | Array of Paperclip company UUIDs allowed to use this resource. The form renders this as a multi-select picker (one checkbox per company + a "Portfolio-wide" toggle) when items declare `format: "company-id"`. Stored as `["*"]` for portfolio-wide or specific UUIDs otherwise. Empty/missing = unusable (fail-safe deny). |
| (rest of fields) | — | — | Plugin-specific (host, token, page ID, etc.). |

The JSON property names are `name`, `key`, `allowedCompanies` — those are
load-bearing. The form titles are what the user reads ("Display name",
"Identifier", "Allowed companies").

### Schema snippet to copy

```ts
items: {
  type: "object",
  required: ["name", "key", "allowedCompanies", /* + your required fields */],
  properties: {
    name: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown in this settings form. Free-form; you can rename it later without breaking anything.",
    },
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling this resource (e.g. 'main', 'sales'). Lowercase, no spaces. Once skills reference it, don't change it. Must be unique.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies allowed to use this resource. Tick 'Portfolio-wide' to allow every company; otherwise tick specific companies. Empty = unusable.",
    },
    // ...your plugin-specific fields below
  },
}
```

### Why two fields (`name` AND `key`) instead of one

- **Display name** is what humans see — "Personal Mailbox", "Brand B FB".
  Free to change.
- **Identifier** is what agents pass in tool calls — `mailbox: "personal"`.
  Stable. If you renamed by collapsing into one field, an operator renaming
  "Personal Mailbox" → "Personal Email" would silently break every skill
  and heartbeat that referenced the old name.

### Why the form heading uses Display name

The shared `JsonSchemaForm` component in paperclip core
(`paperclip/ui/src/components/JsonSchemaForm.tsx`, helper `itemHeading()`)
reads each array item's `name` property and renders it as the row heading.
Falls back to `key`, then to "Item N". So with both fields populated, your
operator sees their actual labels — "Personal Mailbox", "Brand A FB" —
instead of "Item 1", "Item 2".

You don't have to do anything to opt in. As long as your items have a `name`
property (string), the renderer picks it up automatically.

---

## 2. Company isolation — every tool MUST enforce it

Plugins are installed at the instance level, but their resources belong to
specific companies. Without enforcement, an agent in any company can address
any resource. This is a real cross-tenant bug.

The pattern, in every tool handler:

```ts
import { assertCompanyAccess } from "./companyAccess.js";

ctx.tools.register("my_tool", { /* … */ }, async (params, runCtx) => {
  const cfg = findResourceByKey(config.resources, params.resourceKey);
  if (!cfg) return { error: `Resource "${params.resourceKey}" not configured.` };

  try {
    assertCompanyAccess(ctx, {
      tool: "my_tool",
      resourceLabel: `my-plugin resource "${params.resourceKey}"`,
      resourceKey: params.resourceKey,
      allowedCompanies: cfg.allowedCompanies,
      companyId: runCtx.companyId,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }

  // …actual work here
});
```

`companyAccess.ts` is identical across all 3 reference plugins — copy from
`email-tools/src/companyAccess.ts` verbatim. It exports two functions:

- `assertCompanyAccess(ctx, args)` — throws `[ECOMPANY_NOT_ALLOWED]` and emits
  `ctx.logger.warn` if the calling company isn't allowed.
- `isCompanyAllowed(allowedCompanies, companyId)` — returns boolean. Use it
  for filtering listing-tool output.

### Listing tools must filter

If your plugin exposes a `list_resources`-style tool (e.g.
`google-analytics.list_sites`), it MUST filter the returned list to only
resources allowed for `runCtx.companyId`. Otherwise an agent learns the
existence of resources it can't use, which leaks structure.

### Cache authed clients per `(companyId, secretRef)`, not per secretRef

If two companies share one service-account secret, each gets an independent
auth client. Never share an authed client across company boundaries. See
`google-analytics/src/worker.ts` `getAuthClient()` for the canonical pattern.

### Setup-time orphan warning

In your plugin's `setup(ctx)`, log a warning naming any resource that has no
`allowedCompanies` configured. This gives operators a backfill TODO list.
Pattern:

```ts
const orphans = resources.filter((r) => !r.allowedCompanies || r.allowedCompanies.length === 0);
if (orphans.length > 0) {
  ctx.logger.warn(
    `my-plugin: ${orphans.length} resource(s) have no allowedCompanies and will reject every call. ` +
      `Backfill on the plugin settings page: ${orphans.map((r) => r.key ?? "(no-key)").join(", ")}`,
  );
}
```

---

## 3. Other non-negotiables (compressed)

Full text in `plugin-plans/README.md`. The bare minimum:

- **LLM-agnostic.** No `@anthropic-ai/sdk`, `openai`, `@google-ai/generative-ai`
  at the plugin layer. Image-gen / vision / audio providers are NOT LLM
  dependencies — those are external APIs.
- **Secret-refs only.** All credentials are stored as UUIDs (`format:
  "secret-ref"`) and resolved at runtime via `ctx.secrets.resolve(ref)`.
  Never hardcode a secret. Never put a raw secret value in plugin config.
- **Mutation gate.** Plugins that write external state ship with
  `allowMutations: false` (or similarly named) by default. Operator must opt
  in.
- **Idempotency.** Every mutation tool accepts an optional `idempotencyKey`.
- **Error wrapping.** Provider errors translate to `[ECODE_<UPSTREAM>] human
  message` shape so consuming skills can pattern-match.
- **Cost tracking.** Paid-API plugins emit `ctx.telemetry.track("<plugin>.<tool>",
  { ...dimensions })` so the cost-events service can aggregate.
- **Multi-account.** Every plugin's config supports an array of accounts /
  workspaces / projects (which is why the conventions in §1 exist).

---

## 4. Plugin folder layout

```
plugins/<plugin-id>/
  package.json          ← name: paperclip-plugin-<id>, paperclipPlugin: { manifest, worker }
  tsconfig.json         ← copy from email-tools verbatim
  README.md             ← setup walkthrough, tool reference, error codes
  src/
    index.ts            ← re-exports manifest + worker (copy from email-tools)
    manifest.ts         ← PaperclipPluginManifestV1 with instanceConfigSchema + tool decls
    companyAccess.ts    ← copy verbatim from any reference plugin
    worker.ts           ← definePlugin({ setup }) + runWorker(plugin, import.meta.url)
  dist/                 ← built artifacts (gitignored at repo root)
```

Build with `pnpm build`. Install locally with:

```bash
pnpm --filter paperclipai exec tsx src/index.ts plugin install --local <absolute-path>
```

(Run from inside the paperclip checkout, not from `paperclip-extensions/`.)

---

## 5. Per-plugin README requirements

Every plugin folder must ship a `README.md` that covers:

1. What the plugin does and which tools it registers.
2. Setup walkthrough — how to create the API key/token/OAuth client at the
   provider, what scopes/permissions to enable, how to wire the secret-ref
   step by step, how to bind the resource in plugin settings (with all four
   conventional fields: Display name, Identifier, Allowed companies,
   plugin-specific fields).
3. Tool reference — every tool documented with at least one sample
   invocation, including a `runContext` showing which `companyId` is
   required.
4. Error-code reference — every `[E...]` code the plugin can return,
   including `[ECOMPANY_NOT_ALLOWED]`.

A different operator should be able to set up the plugin from scratch using
only the settings-page helper text + this README. If they'd need to read
your code to figure something out, the docs aren't done.
