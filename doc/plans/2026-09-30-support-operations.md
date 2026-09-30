# Support operations milestones

## Goal

Expand Support Desk into a reusable coordinator for staff IT and operational requests. Every company saves its own contacts, assets, procedures, accounts, brand identity and routing. The plugin must not ship deployment-specific names, directories, domains, recipients or credentials.

## Milestone 1 — Company directory and routing

Implemented in source:

- Typed company records for vendors, responsible people/teams, equipment/warranties, brands, owner routing and specialist connection references.
- Confirmed operator writes; optimistic versions; atomic revision snapshots; company/type-checked relationships and agent IDs.
- Search and owner resolution in Clippy, plus policy/checkout-authorized read access for assigned ticket agents.
- A Support page editor, revision inspection, owner lookup and truthful plugin installation status.
- Existing company knowledge tools supply reviewed staff SOPs. New records do not authorize commands, automatically send messages, or configure specialist accounts.

Acceptance: two-company isolation, foreign-reference rejection, stale/concurrent-edit prevention, explicit consent, bounded searches, route precedence/ambiguity and no claim of live connection success from metadata. An installed UI pilot remains necessary after build verification.

## Milestone 2 — Common staff tasks

Job-folder section implemented: saved local file-server root/naming profiles, bounded literal customer/date search, review flags, exact confirmed creation through the existing action engine, profile/access rechecks, and a Windows temporary-folder rehearsal. Live company file-server validation is pending. No documents were read and no company folders were created during development.

Workstation diagnostic section implemented: device/driver/storage provider observations, battery capacity with unsupported estimates marked unknown, bounded crash metadata and AI command/PATH availability. Windows tests use synthetic provider results and local metadata. MCP authentication, affected-user configuration, cloud sync and restoration are separate checks; tool availability proves none of them.

Skill comparison section implemented: reviewed company source/backup profiles, bounded Markdown hashes retained on the remote host, local copy counts, redirected-root rejection and partial-result reporting. Cloud upload verification and a restore rehearsal still require the provider/restore integration; local matching copies never claim either.

Daily summary section implemented: saved opt-in Slack channel/timezone/schedule, aggregate preview and receipt inspection in Clippy, previous-calendar-day counts, unique company/day claims, policy/workspace rechecks and no replay after interrupted/unknown delivery. Tests exercise actual migration SQL, company isolation, concurrent sends and daylight-saving boundaries. No real Slack summary was posted during development.

- Approved file-root profiles and naming templates, literal customer/date folder search, previewed folder/subfolder creation, and stale/misfiled-job reports. No automatic deletion or moves. Confirm actual roots and naming rules through company settings.
- Hardware diagnostics: device/driver failures, battery health and bounded crash evidence; warranty linkage and official-source part compatibility research.
- AI workstation diagnostics: PATH/environment, installed tools, skills, MCP connections, task execution and backup/sync freshness. Report unavailable checks and distinguish historical backup from restored/sync-verified data.
- Daily support summaries with saved channel, schedule and permitted data. Review sender/recipient configuration and durable delivery behavior.

## Milestone 3 — Specialist adapters

Observation bridge section implemented: authenticated, expiring, company/conversation/profile-bound requests to the existing Help Scout and 3CX plugins. Provider-side exact opt-in and Help Scout mailbox ownership checks precede reads; PBX scope stays with its existing engine. Actual metadata, unavailable components and receipt times are exposed in Clippy. Native Help Scout intake/replies, network administration, phone configuration and other adapter sections below remain pending.

Equipment history section implemented: company equipment-linked immutable fault/consumable/completed-service evidence, repeat-ID protection, 90-day recurring code counts, and contact-aware vendor service-call drafts. Tests confirm consent, isolation and that preparing a service request neither sends nor records service completion. Manufacturer controllers and physical repair remain with qualified specialists; records are not machine telemetry.

Production handoff section implemented: saved preflight software/procedures, exact file/version handoffs, immutable operator-confirmed report findings and unavailable checks, plus built-in vendor software reporting routes/instructions. Opening/preparing a report never claims submission; a real provider reference is required for a manual submission record. No customer files are uploaded or analyzed during development. Automated production-software connectors require a supported vendor integration.

- Help desk: connect existing Help Scout tools to Support Desk intake/replies; brand-aware mailbox routing, tags, assignment and signatures. Mailbox/account changes require separate reviewed actions.
- Network: a company-authorized UniFi connector/MCP; controller/AP/client/firmware observations, with approved scoped changes and disruption/verification/recovery details.
- Phones: reuse 3CX and phone-assistant tools; diagnose extensions, voicemail, routing, desk/softphones, SBCs and hosting dependencies. Explicitly distinguish those components.
- Storefronts: saved public site/status checks and approved admin connections for order investigation. Read-only defaults and saved admin rules. Public vendor software bugs use built-in reporting/public support, with receipts/references retained.
- Production: equipment fault history, consumables and service history, official vendor guidance and reviewed service-call preparation. Windows printing/IPP checks are not press/finishing-equipment diagnostics. Physical interventions route to qualified responsible people.
- Preflight: delegate to configured production software; translate its actual findings for staff/customer messages. Do not duplicate an existing engine without evidence it is needed.

## Governance and rollout

Ordinary staff requests and automatically triaged tickets require an authorized operator's exact change approval. Existing human emergency delegation stays bounded by user, conversation, case, target and time; it grants no new permissions. New adapters must enforce equivalent authorization, receipts, audit and uncertainty handling. Logs alone do not make every action reversible.

Keep the foundation PR scoped and report unimplemented adapters explicitly. Each milestone gets focused integration tests, typecheck/build, privacy review and a separate commit. Deploy/reinstall a tested build before claiming live availability; release tags and production changes require their own authorized workflow.
