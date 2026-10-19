# Email Tools routing screenshots

R4 evidence correction: all earlier Error/string-based error captures below
are fixture-only, pre-R4 evidence and are insufficient proof of a real host
bridge failure. The real host throws a plain `PluginBridgeError` object.
See the R4 section for replacement evidence using the actual core hooks.
Earlier assets are preserved unchanged.

Captured 2026-10-18 in the native T3 collaborative preview, using an isolated
incognito tab and a loopback-only synthetic component fixture. Viewport:
1280 by 1100 CSS pixels. No live application, provider, private mail, real
company record or production setting was accessed.

- `before-light.png`, `before-dark.png`: actual `RulesSettingsPage.tsx`
  extracted with `git show HEAD:plugins/email-tools/src/ui/RulesSettingsPage.tsx`
  from base `11aca6b1b95b578b394107ed58a5c8cad794adb4`.
- `after-light.png`, `after-dark.png`: actual current `RulesSettingsPage`
  plus the new `RoutingSettingsPage`, exported by the production UI entry.
  Existing sender rules remain above the additive routing panel.
- `data-error.png`: the actual new component displaying an injected
  data-handler error, rather than reporting an empty queue.
- `action-error.png`: the actual new component displaying an injected
  action refusal while retaining the waiting entry and controls.

The fixture uses React, the actual components and their actual CSS-token
styles. Its enclosing page supplies the matching core checkout's light/dark
theme variable blocks. The heading explicitly identifies the synthetic
fixture; it does not imitate application navigation or authentication.

Only the SDK UI bridge hooks are substituted to call the fixture HTTP
server. Routing data/actions use the production MailRouting service with
real migrated PGlite, synthetic host scope, fake issue/wake services, and an
explicit injected message reader. Sender rules are synthetic read data for
the unchanged existing component. No fake rendering of a production
component or fabricated screenshot was used. Every address is invented
under `example.com`.

Interactive checks also exercised Route to destination, Dismiss, refresh
after an action, and visible action/data errors. The separate built-worker
runtime check uses real host services and PostgreSQL with synthetic IMAP and
SMTP TCP servers; these screenshots do not claim to show that full host UI.

Reproduction helper, deliberately ignored and not distributed:
`.smoke-tests/issue-83-ui.mts` relative to the extensions checkout. Set
`ISSUE_83_CORE_CHECKOUT` to the matching core checkout, then run:

```sh
node --import ./plugins/email-tools/node_modules/tsx/dist/loader.mjs .smoke-tests/issue-83-ui.mts
```

The helper prints its ephemeral loopback URL. Choose `phase=before` or
`phase=after`, `theme=light` or `theme=dark`, and optionally `scenario=error`
or `scenario=action-error`. Stop only that fixture process after capture.

## R1 repair evidence, 2026-10-19

The original six images above are preserved. New captures use the same actual
components and synthetic fixture, in the native T3 incognito preview at
1280 by 1250 CSS pixels. The base remains
`11aca6b1b95b578b394107ed58a5c8cad794adb4`.

- `r1-before-light.png`, `r1-before-dark.png`: refreshed base sender-rules
  component, without a routing panel.
- `r1-repair-light.png`, `r1-repair-dark.png`: repaired current components,
  including Close as handled manually.
- `r1-manual-confirm-light.png`: actual confirmation controls and warning
  that an unknown handoff may already exist or still complete.
- `r1-manual-closed-dark.png`: successful real routing-service manual close,
  zero waiting count, retained terminal row and no routing controls.
- `r1-data-error-light.png`: current component's visible data-handler error.
- `r1-action-error-dark.png`: failed manual-close action remains visible with
  the waiting entry and confirmation controls intact.

Interactive checks exercised opening and cancelling the confirmation, a failed
confirmation, a successful confirmation and the refreshed terminal state.
Images were inspected across the whole page for contrast, spacing, alignment,
wrapping and visible errors. SDK hooks, host services and the message reader
have exactly the substitutions described above. This is component evidence,
not production authentication or approval-middleware verification.

## R2 repair evidence, 2026-10-19

All original and R1 assets are preserved. These nine new native T3 incognito
captures contain only invented mail and synthetic identifiers:

- `r2-before-light.png`, `r2-before-confirm-light.png`: the retained R1
  component before R2 UI repairs, including the equal-weight confirmation.
- `r2-after-dark.png`, `r2-after-light.png`: current component with durable
  follow-up counts, states, historical notes and the supported retry action.
- `r2-manual-confirm-dark.png`: contrasting host-token confirmation button.
- `r2-manual-closed-dark.png`: real service closure with actor/time, retained
  identity and no actionable pending wake for the handled row.
- `r2-followups-failed-dark.png`: a failed retry retains the handoff and
  pending states with a fixed safe diagnostic, not the provider exception.
- `r2-followups-repaired-light.png`: real service retry changes the same row
  to requested/logged and clears the follow-up count, without another create.
- `r2-config-error-light.png`: configured source-company mailbox with zero
  rows displays the actual safe sending-prerequisite configuration reason.

The ignored helper remains `.smoke-tests/issue-83-ui.mts`; R2 generated bundle
files live under `.smoke-tests/r2-ui/`. It uses the actual current
RulesSettingsPage and RoutingSettingsPage. React SDK hooks are synthetic HTTP
adapters to MailRouting and migrated in-memory PGlite. The message reader,
host issue/wake services and identities in this UI fixture are synthetic.
Runtime stdio/HTTP/real-core/real-PostgreSQL coverage is separate.

Before the style change, inspected the matching core's actual
`ui/src/pages/PluginSettings.tsx` settings-slot section and
`ui/src/plugins/slots.tsx` React mount: the shared section is `space-y-3` and
the mount adds no padding without a className. The R2 fixture reproduces that
section with both actual plugin components and the actual host light/dark
tokens. It does not mount the whole authenticated host application. No host
stylesheet was changed. Routing now uses the same 16 px inset and heading
metrics as Sender rules; browser measurements give x=106 and width=1068 for
both headings at width 1280. The confirmation uses primary/primary-foreground
and weight 600; Cancel retains background/foreground and weight 400.

Before captures use 1280 by 1250 CSS pixels. Current captures use width 1280,
heights 1250 or 1650 to include all controls. Whole-page images were inspected
for wrapping, spacing, contrast, alignment and visible failure states; browser
measurement found no horizontal overflow. Native actions exercised failed
retry, successful retry and manual close against the real service. Only this
turn's own incognito preview tab and exact synthetic listeners were used.
No Chrome executable command, normal profile, real mailbox or live setting
was accessed. No production authentication or approval verification is claimed.

## R3 repair evidence, 2026-10-19

All original, R1 and R2 assets are byte-for-byte preserved. Fourteen new native
T3 incognito captures use only synthetic mail, example.com addresses and
invented operator identifiers:

- `r3-before-dark.png`: exact pre-R3 RoutingSettingsPage source recovered from
  the retained R2 package source map. Its SHA-256 equals the pre-edit baseline.
  It uses current synthetic service data, so the disabled malformed-ID control
  in this comparison already reflects the repaired service. The old component's
  outer dark card and lack of acknowledgement remain visible.
- `r3-after-dark.png`, `r3-after-light.png`: current component, disabled unusable
  Message-ID route, and reachable follow-up acknowledgement.
- `r3-retry-failed-dark.png`: actual failed service retry, one visible diagnostic.
- `r3-waiting-response-dark.png`, `r3-in-progress-light.png`: actual returned
  notes stay visible after reconciliation ends waiting or in_progress. For the
  latter, the synthetic database holds a current claim; the actual service
  refuses takeover and returns in_progress without changing that claim.
- `r3-check-confirm-dark.png`, `r3-check-confirm-light.png`: separate explicit
  acknowledgement confirmation, with primary host tokens and plain impact text.
- `r3-check-error-dark.png`: a synthetic rejected action, retained confirmation
  and unchanged routed facts. The injected fixture error reuses the earlier
  fixture's generic "Entry remains waiting" wording; the displayed record is
  still routed, and no product-generated message makes that claim.
- `r3-checked-dark.png`: actual service acknowledgement, zero follow-up count,
  retained requested_unknown/unknown facts, operator/time and no retry button.
- `r3-removed-light.png`, `r3-removed-checked-light.png`: actual removed-config
  panel before and after acknowledgement. The fixed configuration reason and
  manual-close instruction each appear once. Acknowledgement remains available
  while route/retry is unavailable; no current mailbox is needed by the action.
- `r3-config-error-light.png`, `r3-data-error-light.png`: actual validator reason
  with no rows, and a visible synthetic data-handler error.

Reproduction helper: `.smoke-tests/issue-83-r3-ui.mts`. It uses the actual
current components and MailRouting.panel/resolve with migrated in-memory
PGlite. SDK hooks are HTTP adapters; message reading, destination host services
and identities are synthetic. The separate R3 runtime uses the actual built
worker, matching core host services and real PostgreSQL. Neither mounts
production authentication, approval middleware or live accounts.

Before viewport is 1280 by 2350. Current captures are 1280 by 1850, except
the two removed-config images at 1280 by 2000. Whole-page visual checks covered
wrapping, spacing, alignment, contrast and visible errors. The actual core
settings slot adds no padding or card surface. Both plugin headings measure
x=106 and width=1068; both outer component surfaces are transparent after the
shared routing-component fix. No host stylesheet was changed. No horizontal
overflow was observed. Native actions exercised retry failure, waiting and
in-progress notes, confirmation, cancellation, action failure and successful
acknowledgement, including removed configuration. Only the two owned incognito
tabs and exact synthetic listeners were closed. No normal browser profile,
Chrome executable command, private mail or live setting was used.

## R4 bridge error repair evidence, 2026-10-19

Four new native T3 incognito screenshots use the final actual components,
the matching core light/dark tokens, and 1280 by 1250 CSS pixels:

- `r4-scope-error-light.png`: a real service refusal to load mailbox scopes
  displays `[EROUTE_ADMIN_REQUIRED]` and its readable message.
- `r4-data-error-dark.png`: scopes load successfully, but the entries request
  is refused by the real service. Its message remains readable.
- `r4-action-error-light.png`, `r4-action-error-dark.png`: another synthetic
  operator routes the waiting entry after the page loads. Native clicks on
  Close as handled manually and Confirm manual close produce the actual
  service's `[EROUTE_TERMINAL] Only a waiting or claimed entry can be closed
  manually.` response. The confirmation and stale waiting display remain;
  these images do not claim that the row is still waiting in the database.

The ignored helper is `.smoke-tests/issue-83-r4-ui.mts`, run through
`.smoke-tests/r4-run.ps1` with its own process-local home/config/instance/log
and temporary directories set before host imports. It mounts the actual core
`ui/src/plugins/bridge.ts` hooks and context, actual `pluginsApi`, API client
and error wording. The hooks therefore receive and throw the actual plain
`{ code, message, details }` contract, rather than synthetic Error objects.
Only the toast context is stubbed in the browser. React comes from the plugin's
installed dependencies. No dependency, SDK or host source was changed.

Loopback HTTP emulates the core bridge routes, returns real MailRouting
panel/resolve output through JSON serialization, and wraps actual service
failures in HTTP 502 `{ code: "WORKER_ERROR", message }` responses. It emulates
host-stamped company/user/admin identity. Scope and entries errors deliberately
stamp a non-admin identity at the selected entrypoint. Message reading,
destination issue/wake services and identities are synthetic; storage is
migrated in-memory PGlite. Sender rules are unchanged synthetic read data.
Production authentication, approval middleware, plugin dispatch, live mail,
provider/model calls and live settings are not mounted or verified.

Correction to earlier error evidence: `data-error.png`, `action-error.png`,
`r1-data-error-light.png`, `r1-action-error-dark.png`,
`r3-check-error-dark.png` and `r3-data-error-light.png` used Error/string-based
fixture failures. They demonstrate fixture-only, pre-R4 component states and
are insufficient proof that real host bridge errors were readable. The
earlier component test's string errors had the same limitation. Earlier fixed
configuration reasons and returned follow-up diagnostics are service data,
not thrown bridge errors; those evidence claims are separate and unchanged.

All original/R1/R2/R3 images and helpers are retained. The four new images
are unedited native captures, inspected across the whole page for wrapping,
contrast, spacing, alignment and visible failures. No horizontal overflow or
`[object Object]` was observed. Native interaction metadata, HTTP results and
capture paths are retained in ignored `.smoke-tests/r4-browser-evidence.json`.


## R6 recorded-key and destination controls, 2026-10-19

Nine new, unedited native T3 incognito captures use the current actual
RoutingSettingsPage and RulesSettingsPage, matching core light/dark theme
tokens, and synthetic data only. Earlier assets and the R4 evidence correction
above remain intact.

- `r6-destination-placeholder-light.png`: disabled Property proposal, an actual
  selected empty-value placeholder, one enabled destination and disabled Route.
- `r6-destination-selected-light.png`: native mouse opening the select followed
  by ArrowDown and Enter chooses Corporate operations and enables Route.
- `r6-destination-routed-light.png`: native Route click returns the recorded
  issue, requested wake and logged source audit; the synthetic create count is 1.
- `r6-destination-placeholder-dark.png`: removed Property proposal with only
  Corporate operations left; the unavailable-choice explanation remains readable.
- `r6-destination-routed-dark.png`: native select opening, ArrowDown, Enter and
  Route successfully choose the only remaining destination, with one create.
- `r6-stale-selection-dark.png`: the operator first chooses Corporate operations;
  a synthetic config change disables it, then native Refresh shows the explicit
  placeholder instead of silently selecting the still-enabled Property destination.
  Native ArrowDown, Enter and Route subsequently record Property with one create.
- `r6-recorded-key-light.png`: source key changed from shared to Shared; selecting
  shared (recorded entries) shows unavailable, disabled Route/Dismiss, and enabled
  Close as handled manually.
- `r6-recorded-key-closed-dark.png`: native confirmation closes that stored entry,
  retaining the exact shared key, destination and operator facts, with zero creates.
  The theme class was changed to dark for this capture; its URL still says light.
- `r6-dismissed-light.png`: a normally configured entry dismisses successfully,
  refreshes to dismissed and leaves no action alert, with zero creates.

The first five captures are 1280 by 1000 CSS pixels. The final four are 1280 by
1250. Every image was inspected in full for wrapping, spacing, alignment,
contrast and visible outcomes. Measured states showed no horizontal overflow.

The owned helper is `~/.ai/q83-r6-247d11d7/ui.mts`, adapted from the retained
R4 helper without changing it. The fail-fast runner and Node guard set owned
home/config/instance/log/temp paths outside either checkout before imports.
The browser mounts actual core bridge context/hooks, pluginsApi, API client
and error wording; only the toast context is stubbed. Loopback HTTP emulates
host routes and authoritative company/user/admin stamping, then JSON-transports
real MailRouting panel/resolve output from migrated in-memory PGlite. Mail
reading, issue/wake services, account configuration and identities are synthetic.
Sender rules are synthetic read data. Native choices used real browser input,
not injected change events. Native actions and ledger/create facts are retained
in that scratch folder's browser-checks.json and browser-requests.json.

Production authentication, approval middleware, plugin dispatch, live accounts,
provider/model acceptance and live settings are not mounted or claimed. This
fixture is separate from the current extracted-worker/real PostgreSQL/synthetic
IMAP and SMTP runtime recorded in the R6 repair handoff. The UI fixture and its
one owned incognito tab were closed normally. No image editing occurred.
