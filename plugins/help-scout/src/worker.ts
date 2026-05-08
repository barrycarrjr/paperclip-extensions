import {
  definePlugin,
  runWorker,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  type ConfigAccount,
  type InstanceConfig,
  type ResolvedAccount,
  getHelpScoutAccount,
  helpScoutRequest,
  listMailboxesForAccount,
  normalizeTag,
  resolveMailboxId,
} from "./helpScoutClient.js";
import { isCompanyAllowed } from "./companyAccess.js";

type ResolveResult =
  | { ok: true; resolved: ResolvedAccount }
  | { ok: false; error: string };

async function resolveOrError(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  accountKey: string | undefined,
): Promise<ResolveResult> {
  try {
    const resolved = await getHelpScoutAccount(ctx, runCtx, toolName, accountKey);
    return { ok: true, resolved };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

async function track(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  tool: string,
  accountKey: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await ctx.telemetry.track(`help-scout.${tool}`, {
      account: accountKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // never break tool calls on telemetry failure
  }
}

const REPORT_CACHE_TTL_MS = 60 * 1000;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("help-scout plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const accounts: ConfigAccount[] = rawConfig.accounts ?? [];

    if (accounts.length === 0) {
      ctx.logger.warn(
        "help-scout: no accounts configured. Add them on /instance/settings/plugins/help-scout.",
      );
    } else {
      const summary = accounts
        .map((a) => {
          const k = a.key ?? "(no-key)";
          const allowed = a.allowedCompanies;
          const access =
            !allowed || allowed.length === 0
              ? "no companies — UNUSABLE"
              : allowed.includes("*")
                ? "portfolio-wide"
                : `${allowed.length} company(s)`;
          return `${k} [${access}]`;
        })
        .join(", ");
      ctx.logger.info(
        `help-scout: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Accounts — ${summary}`,
      );

      const orphans = accounts.filter(
        (a) => !a.allowedCompanies || a.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `help-scout: ${orphans.length} account(s) have no allowedCompanies and will reject every call.`,
        );
      }
    }

    // ─── Read tools ──────────────────────────────────────────────────────

    ctx.tools.register(
      "helpscout_list_mailboxes",
      {
        displayName: "List Help Scout mailboxes",
        description: "List all mailboxes on the account.",
        parametersSchema: {
          type: "object",
          properties: { account: { type: "string" } },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string };
        const r = await resolveOrError(ctx, runCtx, "helpscout_list_mailboxes", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const resp = await helpScoutRequest<{ _embedded?: { mailboxes?: unknown[] } }>(
            r.resolved,
            "/mailboxes",
            { query: { size: 50 } },
          );
          let mailboxes = (resp.body?._embedded?.mailboxes ?? []) as Array<{
            id: number;
            name: string;
            email: string;
          }>;
          // Filter to allowedMailboxes if set
          const allow = r.resolved.account.allowedMailboxes;
          if (allow && allow.length > 0) {
            mailboxes = mailboxes.filter((m) => allow.includes(String(m.id)));
          }
          await track(ctx, runCtx, "helpscout_list_mailboxes", r.resolved.accountKey, {
            count: mailboxes.length,
          });
          return {
            content: `Found ${mailboxes.length} mailbox(es) on ${r.resolved.accountKey}.`,
            data: {
              mailboxes: mailboxes.map((m) => ({
                id: String(m.id),
                name: m.name,
                email: m.email,
              })),
            },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_find_conversation",
      {
        displayName: "Find Help Scout conversations",
        description: "Search conversations by mailbox / status / query / tag / assignee / since.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            mailboxId: { type: "string" },
            query: { type: "string" },
            status: { type: "string" },
            tag: { type: "string" },
            assignedTo: { type: "string" },
            since: { type: "string" },
            limit: { type: "number" },
            page: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          mailboxId?: string;
          query?: string;
          status?: string;
          tag?: string;
          assignedTo?: string;
          since?: string;
          limit?: number;
          page?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "helpscout_find_conversation", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const mailboxId = resolveMailboxId(r.resolved, p.mailboxId, false);
          const query: Record<string, string | number | undefined> = {
            size: clampLimit(p.limit, 25, 50),
            page: p.page,
          };
          if (mailboxId) query.mailbox = mailboxId;
          if (p.query) query.query = p.query;
          if (p.status === "open") query.status = "active,pending";
          else if (p.status && p.status !== "all") query.status = p.status;
          if (p.tag) query.tag = normalizeTag(p.tag);
          if (p.assignedTo) query.assigned_to = p.assignedTo;
          if (p.since) query.modifiedSince = p.since;

          const resp = await helpScoutRequest<{
            _embedded?: { conversations?: unknown[] };
            page?: { totalElements?: number; number?: number; totalPages?: number };
          }>(r.resolved, "/conversations", { query });

          const conversations = (resp.body?._embedded?.conversations ?? []) as Array<
            Record<string, unknown>
          >;
          await track(ctx, runCtx, "helpscout_find_conversation", r.resolved.accountKey, {
            count: conversations.length,
          });
          return {
            content: `Found ${conversations.length} conversation(s).`,
            data: {
              conversations: conversations.map(slimConversation),
              totalCount: resp.body?.page?.totalElements ?? conversations.length,
              page: resp.body?.page?.number ?? 1,
              totalPages: resp.body?.page?.totalPages ?? 1,
            },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_get_conversation",
      {
        displayName: "Get Help Scout conversation",
        description: "Retrieve a single conversation by ID, optionally embedding threads.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            embed: { type: "string", enum: ["threads"] },
          },
          required: ["conversationId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          conversationId?: string;
          embed?: "threads";
        };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_get_conversation", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const query: Record<string, string> = {};
          if (p.embed === "threads") query.embed = "threads";
          const resp = await helpScoutRequest<Record<string, unknown>>(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}`,
            { query },
          );
          await track(ctx, runCtx, "helpscout_get_conversation", r.resolved.accountKey, {
            conversationId: p.conversationId,
            embed: p.embed ?? null,
          });
          return {
            content: `Retrieved conversation ${p.conversationId}.`,
            data: resp.body,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_find_customer",
      {
        displayName: "Find Help Scout customers",
        description: "Search customers by email / query / name.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            email: { type: "string" },
            query: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            limit: { type: "number" },
            page: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          email?: string;
          query?: string;
          firstName?: string;
          lastName?: string;
          limit?: number;
          page?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "helpscout_find_customer", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const query: Record<string, string | number | undefined> = {
            size: clampLimit(p.limit, 25, 50),
            page: p.page,
          };
          if (p.email) query.email = p.email;
          if (p.query) query.query = p.query;
          if (p.firstName) query.firstName = p.firstName;
          if (p.lastName) query.lastName = p.lastName;

          const resp = await helpScoutRequest<{
            _embedded?: { customers?: unknown[] };
            page?: { totalElements?: number };
          }>(r.resolved, "/customers", { query });

          const customers = (resp.body?._embedded?.customers ?? []) as Array<
            Record<string, unknown>
          >;
          await track(ctx, runCtx, "helpscout_find_customer", r.resolved.accountKey, {
            count: customers.length,
          });
          return {
            content: `Found ${customers.length} customer(s).`,
            data: {
              customers,
              totalCount: resp.body?.page?.totalElements ?? customers.length,
            },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_find_user",
      {
        displayName: "Find Help Scout user",
        description: "Search Help Scout users (operators / agents).",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            email: { type: "string" },
            query: { type: "string" },
            limit: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; email?: string; query?: string; limit?: number };
        const r = await resolveOrError(ctx, runCtx, "helpscout_find_user", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const query: Record<string, string | number | undefined> = {
            size: clampLimit(p.limit, 25, 50),
          };
          if (p.email) query.email = p.email;
          // Help Scout's /users supports `query` as a global search filter.
          if (p.query) query.query = p.query;

          const resp = await helpScoutRequest<{ _embedded?: { users?: unknown[] } }>(
            r.resolved,
            "/users",
            { query },
          );
          const users = (resp.body?._embedded?.users ?? []) as Array<Record<string, unknown>>;
          await track(ctx, runCtx, "helpscout_find_user", r.resolved.accountKey, {
            count: users.length,
          });
          return {
            content: `Found ${users.length} user(s).`,
            data: { users },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Reports (cached) ────────────────────────────────────────────────

    const reportCacheKey = (mailboxId: string | undefined, start: string, end: string) =>
      `${mailboxId ?? "all"}::${start}::${end}`;

    async function getReport(
      resolved: ResolvedAccount,
      mailboxId: string | undefined,
      start: string,
      end: string,
    ): Promise<unknown> {
      const ck = reportCacheKey(mailboxId, start, end);
      const now = Date.now();
      const cached = resolved.reportCache.get(ck);
      if (cached && cached.expiresAt > now) return cached.data;

      const query: Record<string, string | undefined> = { start, end };
      if (mailboxId) query.mailboxes = mailboxId;
      const resp = await helpScoutRequest<unknown>(resolved, "/reports/conversations", {
        query,
      });
      resolved.reportCache.set(ck, { data: resp.body, expiresAt: now + REPORT_CACHE_TTL_MS });
      return resp.body;
    }

    ctx.tools.register(
      "helpscout_get_day_report",
      {
        displayName: "Get Help Scout day report",
        description: "Day report for a single date.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            mailboxId: { type: "string" },
            date: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; mailboxId?: string; date?: string };
        const r = await resolveOrError(ctx, runCtx, "helpscout_get_day_report", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const mailboxId = resolveMailboxId(r.resolved, p.mailboxId, false);
          const date = (p.date ?? defaultYesterdayIso()).slice(0, 10);
          const start = `${date}T00:00:00Z`;
          const end = `${date}T23:59:59Z`;
          const data = await getReport(r.resolved, mailboxId, start, end);
          await track(ctx, runCtx, "helpscout_get_day_report", r.resolved.accountKey, {
            date,
            mailboxId: mailboxId ?? null,
          });
          return {
            content: `Day report for ${date}${mailboxId ? ` mailbox ${mailboxId}` : ""}.`,
            data,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_get_week_report",
      {
        displayName: "Get Help Scout week report",
        description: "Week report (7 days).",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            mailboxId: { type: "string" },
            start: { type: "string" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as { account?: string; mailboxId?: string; start?: string };
        const r = await resolveOrError(ctx, runCtx, "helpscout_get_week_report", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const mailboxId = resolveMailboxId(r.resolved, p.mailboxId, false);
          const startDate = (p.start ?? defaultLastMondayIso()).slice(0, 10);
          const endDate = addDaysIso(startDate, 6);
          const start = `${startDate}T00:00:00Z`;
          const end = `${endDate}T23:59:59Z`;
          const data = await getReport(r.resolved, mailboxId, start, end);
          await track(ctx, runCtx, "helpscout_get_week_report", r.resolved.accountKey, {
            start: startDate,
            end: endDate,
            mailboxId: mailboxId ?? null,
          });
          return {
            content: `Week report ${startDate} → ${endDate}.`,
            data,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_get_custom_report",
      {
        displayName: "Get Help Scout custom report",
        description: "Custom-range report between start and end. Optional grouping.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            mailboxId: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            group: { type: "string", enum: ["tag", "user", "mailbox"] },
          },
          required: ["start", "end"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          mailboxId?: string;
          start?: string;
          end?: string;
          group?: "tag" | "user" | "mailbox";
        };
        if (!p.start || !p.end) return { error: "[EINVALID_INPUT] `start` and `end` are required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_get_custom_report", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const mailboxId = resolveMailboxId(r.resolved, p.mailboxId, false);
          const start = p.start.length === 10 ? `${p.start}T00:00:00Z` : p.start;
          const end = p.end.length === 10 ? `${p.end}T23:59:59Z` : p.end;
          // Help Scout has separate report endpoints per dimension; we route
          // based on `group`.
          let pathPart = "/reports/conversations";
          if (p.group === "tag") pathPart = "/reports/conversations/tags";
          else if (p.group === "user") pathPart = "/reports/user/conversation-history";
          else if (p.group === "mailbox") pathPart = "/reports/conversations";

          const query: Record<string, string | undefined> = { start, end };
          if (mailboxId) query.mailboxes = mailboxId;

          const resp = await helpScoutRequest<unknown>(r.resolved, pathPart, { query });
          await track(ctx, runCtx, "helpscout_get_custom_report", r.resolved.accountKey, {
            group: p.group ?? null,
            mailboxId: mailboxId ?? null,
          });
          return {
            content: `Custom report ${p.start} → ${p.end}${p.group ? ` grouped by ${p.group}` : ""}.`,
            data: resp.body,
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Mutations (gated) ───────────────────────────────────────────────

    function gateMutation(tool: string): { error: string } | null {
      if (allowMutations) return null;
      return {
        error: `[EDISABLED] ${tool} is disabled. Enable 'Allow create/reply/note/status/tag changes' on /instance/settings/plugins/help-scout.`,
      };
    }

    ctx.tools.register(
      "helpscout_create_conversation",
      {
        displayName: "Create Help Scout conversation",
        description: "Create a new conversation. Idempotent on idempotencyKey.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            mailboxId: { type: "string" },
            subject: { type: "string" },
            customer: {
              type: "object",
              properties: {
                email: { type: "string" },
                firstName: { type: "string" },
                lastName: { type: "string" },
              },
              required: ["email"],
            },
            type: { type: "string", enum: ["email", "chat", "phone"], default: "email" },
            status: { type: "string", enum: ["active", "pending", "closed"], default: "active" },
            assignTo: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            threads: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["customer", "reply", "note"] },
                  body: { type: "string" },
                  customerEmail: { type: "string" },
                },
                required: ["type", "body"],
              },
            },
            idempotencyKey: { type: "string" },
          },
          required: ["subject", "customer", "threads"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_create_conversation");
        if (gate) return gate;

        const p = params as {
          account?: string;
          mailboxId?: string;
          subject?: string;
          customer?: { email?: string; firstName?: string; lastName?: string };
          type?: "email" | "chat" | "phone";
          status?: "active" | "pending" | "closed";
          assignTo?: string;
          tags?: string[];
          threads?: Array<{ type: "customer" | "reply" | "note"; body: string; customerEmail?: string }>;
          idempotencyKey?: string;
        };

        if (!p.subject) return { error: "[EINVALID_INPUT] `subject` is required" };
        if (!p.customer?.email) return { error: "[EINVALID_INPUT] `customer.email` is required" };
        if (!p.threads || p.threads.length === 0)
          return { error: "[EINVALID_INPUT] At least one entry in `threads` is required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_create_conversation", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const mailboxId = resolveMailboxId(r.resolved, p.mailboxId, true);

          // Idempotency: search for existing conversation tagged with this key
          if (p.idempotencyKey) {
            const idemTag = `paperclip-idem-${normalizeTag(p.idempotencyKey)}`;
            const search = await helpScoutRequest<{ _embedded?: { conversations?: Array<{ id: number }> } }>(
              r.resolved,
              "/conversations",
              { query: { mailbox: mailboxId, tag: idemTag, size: 1 } },
            );
            const existing = search.body?._embedded?.conversations?.[0];
            if (existing) {
              await track(ctx, runCtx, "helpscout_create_conversation", r.resolved.accountKey, {
                deduped: true,
                conversationId: String(existing.id),
              });
              return {
                content: `Idempotent: returning existing conversation ${existing.id}.`,
                data: { id: String(existing.id), deduped: true },
              };
            }
          }

          const tags = (p.tags ?? []).map(normalizeTag);
          if (p.idempotencyKey) tags.push(`paperclip-idem-${normalizeTag(p.idempotencyKey)}`);

          const body = {
            subject: p.subject,
            mailboxId: Number(mailboxId),
            type: p.type ?? "email",
            status: p.status ?? "active",
            customer: {
              email: p.customer.email,
              firstName: p.customer.firstName,
              lastName: p.customer.lastName,
            },
            threads: p.threads.map((t) => ({
              type: t.type,
              text: t.body,
              customer: t.customerEmail ? { email: t.customerEmail } : undefined,
            })),
            assignTo: p.assignTo ? Number(p.assignTo) : undefined,
            tags: tags.length > 0 ? tags : undefined,
            imported: false,
          };

          const resp = await helpScoutRequest<Record<string, unknown>>(
            r.resolved,
            "/conversations",
            { method: "POST", body, expectStatus: [201] },
          );
          // Help Scout returns 201 with no body, just a Location header — but
          // most client wrappers populate body; surface what we have.
          await track(ctx, runCtx, "helpscout_create_conversation", r.resolved.accountKey, {
            mailboxId: String(mailboxId),
            tags: tags.length,
          });
          return {
            content: `Created conversation in mailbox ${mailboxId}.`,
            data: resp.body ?? { ok: true },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_send_reply",
      {
        displayName: "Send Help Scout reply",
        description: "Reply to an existing conversation.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            body: { type: "string" },
            customerEmail: { type: "string" },
            cc: { type: "array", items: { type: "string" } },
            bcc: { type: "array", items: { type: "string" } },
            imported: { type: "boolean", default: false },
          },
          required: ["conversationId", "body"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_send_reply");
        if (gate) return gate;

        const p = params as {
          account?: string;
          conversationId?: string;
          body?: string;
          customerEmail?: string;
          cc?: string[];
          bcc?: string[];
          imported?: boolean;
        };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };
        if (!p.body) return { error: "[EINVALID_INPUT] `body` is required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_send_reply", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const body: Record<string, unknown> = {
            text: p.body,
            cc: p.cc,
            bcc: p.bcc,
            imported: !!p.imported,
          };
          if (p.customerEmail) body.customer = { email: p.customerEmail };

          const resp = await helpScoutRequest<Record<string, unknown>>(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}/reply`,
            { method: "POST", body, expectStatus: [201] },
          );
          await track(ctx, runCtx, "helpscout_send_reply", r.resolved.accountKey, {
            conversationId: p.conversationId,
            imported: !!p.imported,
          });
          return {
            content: `Replied to conversation ${p.conversationId}.`,
            data: resp.body ?? { ok: true },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_add_note",
      {
        displayName: "Add Help Scout note",
        description: "Add an internal note to a conversation.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            body: { type: "string" },
            userId: { type: "string" },
          },
          required: ["conversationId", "body"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_add_note");
        if (gate) return gate;

        const p = params as {
          account?: string;
          conversationId?: string;
          body?: string;
          userId?: string;
        };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };
        if (!p.body) return { error: "[EINVALID_INPUT] `body` is required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_add_note", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const body: Record<string, unknown> = { text: p.body };
          if (p.userId) body.user = Number(p.userId);

          const resp = await helpScoutRequest<Record<string, unknown>>(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}/notes`,
            { method: "POST", body, expectStatus: [201] },
          );
          await track(ctx, runCtx, "helpscout_add_note", r.resolved.accountKey, {
            conversationId: p.conversationId,
          });
          return {
            content: `Added note to conversation ${p.conversationId}.`,
            data: resp.body ?? { ok: true },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_change_status",
      {
        displayName: "Change Help Scout conversation status",
        description: "Change conversation status (active / pending / closed / spam).",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            status: { type: "string", enum: ["active", "pending", "closed", "spam"] },
          },
          required: ["conversationId", "status"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_change_status");
        if (gate) return gate;

        const p = params as { account?: string; conversationId?: string; status?: string };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };
        if (!p.status) return { error: "[EINVALID_INPUT] `status` is required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_change_status", p.account);
        if (!r.ok) return { error: r.error };

        try {
          // Help Scout uses PATCH with op: "replace" for status updates.
          await helpScoutRequest(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}`,
            {
              method: "PATCH",
              body: { op: "replace", path: "/status", value: p.status },
              expectStatus: [204],
            },
          );
          await track(ctx, runCtx, "helpscout_change_status", r.resolved.accountKey, {
            conversationId: p.conversationId,
            status: p.status,
          });
          return {
            content: `Conversation ${p.conversationId} → ${p.status}.`,
            data: { id: p.conversationId, status: p.status },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_assign_conversation",
      {
        displayName: "Assign Help Scout conversation",
        description: "Assign or unassign a conversation.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            userId: { type: ["string", "null"] },
          },
          required: ["conversationId", "userId"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_assign_conversation");
        if (gate) return gate;

        const p = params as {
          account?: string;
          conversationId?: string;
          userId?: string | null;
        };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };
        if (p.userId === undefined) return { error: "[EINVALID_INPUT] `userId` is required (use null to unassign)" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_assign_conversation", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const value = p.userId === null ? null : Number(p.userId);
          await helpScoutRequest(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}`,
            {
              method: "PATCH",
              body: { op: "replace", path: "/assignTo", value },
              expectStatus: [204],
            },
          );
          await track(ctx, runCtx, "helpscout_assign_conversation", r.resolved.accountKey, {
            conversationId: p.conversationId,
            userId: p.userId ?? null,
          });
          return {
            content: p.userId === null
              ? `Unassigned conversation ${p.conversationId}.`
              : `Assigned conversation ${p.conversationId} to user ${p.userId}.`,
            data: { id: p.conversationId, userId: p.userId ?? null },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    /**
     * Add labels by reading the conversation's existing tags, unioning with
     * the new ones, and PUTting the full set. Help Scout's PUT /tags replaces
     * the whole set, so we must read-then-write.
     */
    ctx.tools.register(
      "helpscout_add_label",
      {
        displayName: "Add Help Scout label/tag",
        description: "Add tags to a conversation (union with existing).",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["conversationId", "labels"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_add_label");
        if (gate) return gate;

        const p = params as { account?: string; conversationId?: string; labels?: string[] };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };
        if (!p.labels || p.labels.length === 0)
          return { error: "[EINVALID_INPUT] `labels` must be a non-empty array" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_add_label", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const conv = await helpScoutRequest<{ tags?: Array<{ tag?: string }> }>(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}`,
          );
          const existing = (conv.body?.tags ?? []).map((t) => normalizeTag(t.tag ?? ""));
          const incoming = p.labels.map(normalizeTag);
          const union = Array.from(new Set([...existing, ...incoming])).filter(Boolean);

          await helpScoutRequest(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}/tags`,
            {
              method: "PUT",
              body: { tags: union },
              expectStatus: [204],
            },
          );
          await track(ctx, runCtx, "helpscout_add_label", r.resolved.accountKey, {
            conversationId: p.conversationId,
            added: incoming.length,
          });
          return {
            content: `Tagged conversation ${p.conversationId} with ${incoming.join(", ")}.`,
            data: { id: p.conversationId, tags: union },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_remove_label",
      {
        displayName: "Remove Help Scout label/tag",
        description: "Remove tags from a conversation.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            conversationId: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
          },
          required: ["conversationId", "labels"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_remove_label");
        if (gate) return gate;

        const p = params as { account?: string; conversationId?: string; labels?: string[] };
        if (!p.conversationId) return { error: "[EINVALID_INPUT] `conversationId` is required" };
        if (!p.labels || p.labels.length === 0)
          return { error: "[EINVALID_INPUT] `labels` must be a non-empty array" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_remove_label", p.account);
        if (!r.ok) return { error: r.error };

        try {
          const conv = await helpScoutRequest<{ tags?: Array<{ tag?: string }> }>(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}`,
          );
          const existing = (conv.body?.tags ?? []).map((t) => normalizeTag(t.tag ?? ""));
          const remove = new Set(p.labels.map(normalizeTag));
          const remaining = existing.filter((t) => t && !remove.has(t));

          await helpScoutRequest(
            r.resolved,
            `/conversations/${encodeURIComponent(p.conversationId)}/tags`,
            {
              method: "PUT",
              body: { tags: remaining },
              expectStatus: [204],
            },
          );
          await track(ctx, runCtx, "helpscout_remove_label", r.resolved.accountKey, {
            conversationId: p.conversationId,
            removed: existing.length - remaining.length,
          });
          return {
            content: `Removed labels from conversation ${p.conversationId}.`,
            data: { id: p.conversationId, tags: remaining },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_create_customer",
      {
        displayName: "Create Help Scout customer",
        description: "Create a customer (idempotent on email).",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            email: { type: "string" },
            firstName: { type: "string" },
            lastName: { type: "string" },
            properties: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            idempotencyKey: { type: "string" },
          },
          required: ["email"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_create_customer");
        if (gate) return gate;

        const p = params as {
          account?: string;
          email?: string;
          firstName?: string;
          lastName?: string;
          properties?: Record<string, string>;
          idempotencyKey?: string;
        };
        if (!p.email) return { error: "[EINVALID_INPUT] `email` is required" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_create_customer", p.account);
        if (!r.ok) return { error: r.error };

        try {
          // Idempotency by email — search first
          const search = await helpScoutRequest<{ _embedded?: { customers?: Array<{ id: number }> } }>(
            r.resolved,
            "/customers",
            { query: { email: p.email, size: 1 } },
          );
          const existing = search.body?._embedded?.customers?.[0];
          if (existing) {
            await track(ctx, runCtx, "helpscout_create_customer", r.resolved.accountKey, {
              deduped: true,
              customerId: String(existing.id),
            });
            return {
              content: `Customer with email ${p.email} already exists (id ${existing.id}).`,
              data: { id: String(existing.id), deduped: true },
            };
          }

          const body: Record<string, unknown> = {
            firstName: p.firstName,
            lastName: p.lastName,
            emails: [{ type: "work", value: p.email }],
          };
          if (p.properties) body.properties = p.properties;
          if (p.idempotencyKey) {
            body.properties = { ...(body.properties as object), paperclip_idem_key: p.idempotencyKey };
          }

          const resp = await helpScoutRequest<Record<string, unknown>>(
            r.resolved,
            "/customers",
            { method: "POST", body, expectStatus: [201] },
          );
          await track(ctx, runCtx, "helpscout_create_customer", r.resolved.accountKey, {
            deduped: false,
          });
          return {
            content: `Created customer ${p.email}.`,
            data: resp.body ?? { ok: true },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    ctx.tools.register(
      "helpscout_update_customer_properties",
      {
        displayName: "Update Help Scout customer properties",
        description: "Update customer custom properties.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            customerId: { type: "string" },
            properties: {
              type: "object",
              additionalProperties: { type: "string" },
            },
          },
          required: ["customerId", "properties"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("helpscout_update_customer_properties");
        if (gate) return gate;

        const p = params as {
          account?: string;
          customerId?: string;
          properties?: Record<string, string>;
        };
        if (!p.customerId) return { error: "[EINVALID_INPUT] `customerId` is required" };
        if (!p.properties || Object.keys(p.properties).length === 0)
          return { error: "[EINVALID_INPUT] `properties` must be a non-empty object" };

        const r = await resolveOrError(ctx, runCtx, "helpscout_update_customer_properties", p.account);
        if (!r.ok) return { error: r.error };

        try {
          // PATCH each property individually using JSON Patch op:replace.
          const ops = Object.entries(p.properties).map(([slug, value]) => ({
            op: "replace",
            path: `/properties/${slug}`,
            value,
          }));
          await helpScoutRequest(
            r.resolved,
            `/customers/${encodeURIComponent(p.customerId)}`,
            { method: "PATCH", body: ops, expectStatus: [204] },
          );
          await track(ctx, runCtx, "helpscout_update_customer_properties", r.resolved.accountKey, {
            customerId: p.customerId,
            count: ops.length,
          });
          return {
            content: `Updated ${ops.length} property/properties on customer ${p.customerId}.`,
            data: { id: p.customerId, updated: Object.keys(p.properties) },
          };
        } catch (err) {
          return { error: (err as Error).message };
        }
      },
    );

    // ─── Form-driven actions (called by JsonSchemaForm via x-paperclip-optionsFrom) ──

    /**
     * `list-mailboxes` — populates the dynamic dropdown for `defaultMailbox`
     * and the multi-select for `allowedMailboxes` on the plugin config form.
     *
     * Iterates every configured account, exchanges credentials for an access
     * token, calls /v2/mailboxes for each, and returns combined options. If
     * an account fails (bad creds, network), it's skipped — the operator
     * sees a partial list rather than a hard error blocking the form.
     *
     * Two-pass UX note: the user must SAVE the account row (with valid
     * client ID + secret refs) before this action can list its mailboxes.
     * On a fresh row pre-save, the action returns whatever's already
     * configured plus a hint in the response.
     */
    ctx.actions.register("list-mailboxes", async () => {
      const config = (await ctx.config.get()) as InstanceConfig;
      const accounts = config.accounts ?? [];
      const options: Array<{ value: string; label: string }> = [];
      const errors: Array<{ accountKey: string; message: string }> = [];

      for (const account of accounts) {
        const accountKey = account.key ?? "(no-key)";
        if (!account.clientIdRef || !account.clientSecretRef) {
          errors.push({
            accountKey,
            message: "missing clientIdRef or clientSecretRef — fill in and save first",
          });
          continue;
        }
        try {
          const mailboxes = await listMailboxesForAccount(ctx, account);
          for (const m of mailboxes) {
            // Label format: "<name> (<email>) — <accountKey>" so a dropdown
            // is unambiguous when there are multiple accounts.
            const accountSuffix = accounts.length > 1 ? ` — ${accountKey}` : "";
            options.push({
              value: m.id,
              label: `${m.name} (${m.email})${accountSuffix}`,
            });
          }
        } catch (err) {
          errors.push({ accountKey, message: (err as Error).message });
        }
      }

      return {
        options,
        accountsConfigured: accounts.length,
        errors,
      };
    });
  },

  async onHealth() {
    return { status: "ok", message: "help-scout ready" };
  },
});

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(value)));
}

function defaultYesterdayIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function defaultLastMondayIso(): string {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, …
  const offset = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - offset - 7);
  return d.toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

interface SlimConversation {
  id: string;
  number: number | null;
  subject: string | null;
  status: string | null;
  mailboxId: string | null;
  customer: { email: string | null; name: string | null } | null;
  assignedTo: string | null;
  tags: string[];
  modifiedAt: string | null;
}

function slimConversation(c: Record<string, unknown>): SlimConversation {
  const customer = (c.primaryCustomer ?? c.customer) as
    | { email?: string; firstName?: string; lastName?: string }
    | undefined;
  const tags = ((c.tags as Array<{ tag?: string }> | undefined) ?? [])
    .map((t) => normalizeTag(t.tag ?? ""))
    .filter(Boolean);
  return {
    id: String(c.id ?? ""),
    number: typeof c.number === "number" ? c.number : null,
    subject: (c.subject as string) ?? null,
    status: (c.status as string) ?? null,
    mailboxId: c.mailboxId !== undefined ? String(c.mailboxId) : null,
    customer: customer
      ? {
          email: customer.email ?? null,
          name:
            [customer.firstName, customer.lastName].filter(Boolean).join(" ") || null,
        }
      : null,
    assignedTo: (c as { assignee?: { id?: number } }).assignee?.id !== undefined
      ? String((c as { assignee?: { id?: number } }).assignee?.id)
      : null,
    tags,
    modifiedAt: (c.userUpdatedAt as string) ?? (c.modifiedAt as string) ?? null,
  };
}

export default plugin;
runWorker(plugin, import.meta.url);

// keep the symbol available for downstream consumers
void isCompanyAllowed;
