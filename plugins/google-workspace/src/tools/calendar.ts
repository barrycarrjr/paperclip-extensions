import {
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { calendar as calendarApi } from "@googleapis/calendar";
import {
  ensureMutationsAllowed,
  getGoogleAccount,
  type InstanceConfig,
  wrapGoogleError,
} from "../googleAuth.js";
import { CALENDAR_TOOLS } from "../schemas.js";
import { track } from "../telemetry.js";
import { getCached, putCached } from "../idempotency.js";

interface ScheduleSpec {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

const DEFAULT_LIST_DAYS = 7;

function defaultTimeWindow(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + DEFAULT_LIST_DAYS);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function findSchema(name: string) {
  const s = CALENDAR_TOOLS.find((t) => t.name === name);
  if (!s) throw new Error(`calendar schema missing: ${name}`);
  return s;
}

export function registerCalendarTools(ctx: PluginContext): void {
  // ---- gcal_list_calendars ----
  {
    const schema = findSchema("gcal_list_calendars");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as { account?: string };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_list_calendars", p.account);
          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await cal.calendarList.list({ maxResults: 250 });
          const items = (res.data.items ?? []).map((c) => ({
            id: c.id,
            summary: c.summary,
            primary: c.primary ?? false,
            accessRole: c.accessRole,
            timeZone: c.timeZone,
          }));
          await track(ctx, runCtx, "gcal_list_calendars", resolved.accountKey, {
            count: items.length,
          });
          return {
            content: `Found ${items.length} calendar(s).`,
            data: { calendars: items },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gcal_list_events ----
  {
    const schema = findSchema("gcal_list_events");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          calendarId?: string;
          timeMin?: string;
          timeMax?: string;
          q?: string;
          maxResults?: number;
          pageToken?: string;
        };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_list_events", p.account);
          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          const win = !p.timeMin || !p.timeMax ? defaultTimeWindow() : null;
          const res = await cal.events.list({
            calendarId: p.calendarId ?? "primary",
            timeMin: p.timeMin ?? win?.timeMin,
            timeMax: p.timeMax ?? win?.timeMax,
            q: p.q,
            maxResults: p.maxResults ?? 250,
            pageToken: p.pageToken,
            singleEvents: true,
            orderBy: "startTime",
          });
          const events = (res.data.items ?? []).map((e) => ({
            id: e.id,
            summary: e.summary,
            description: e.description,
            location: e.location,
            start: e.start,
            end: e.end,
            attendees: e.attendees,
            htmlLink: e.htmlLink,
            status: e.status,
            organizer: e.organizer,
          }));
          await track(ctx, runCtx, "gcal_list_events", resolved.accountKey, {
            count: events.length,
          });
          return {
            content: `Found ${events.length} event(s).`,
            data: { events, nextPageToken: res.data.nextPageToken ?? null },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gcal_get_event ----
  {
    const schema = findSchema("gcal_get_event");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          calendarId?: string;
          eventId?: string;
        };
        if (!p.eventId) return { error: "[EINVALID_INPUT] `eventId` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_get_event", p.account);
          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await cal.events.get({
            calendarId: p.calendarId ?? "primary",
            eventId: p.eventId,
          });
          await track(ctx, runCtx, "gcal_get_event", resolved.accountKey);
          return {
            content: `Event: ${res.data.summary ?? "(no title)"}.`,
            data: { event: res.data },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gcal_freebusy ----
  {
    const schema = findSchema("gcal_freebusy");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          timeMin?: string;
          timeMax?: string;
          calendarIds?: string[];
        };
        if (!p.timeMin) return { error: "[EINVALID_INPUT] `timeMin` is required" };
        if (!p.timeMax) return { error: "[EINVALID_INPUT] `timeMax` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_freebusy", p.account);
          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          const items = (p.calendarIds ?? ["primary"]).map((id) => ({ id }));
          const res = await cal.freebusy.query({
            requestBody: { timeMin: p.timeMin, timeMax: p.timeMax, items },
          });
          await track(ctx, runCtx, "gcal_freebusy", resolved.accountKey);
          return {
            content: `Free/busy fetched for ${items.length} calendar(s).`,
            data: { calendars: res.data.calendars ?? {} },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gcal_create_event (mutation) ----
  {
    const schema = findSchema("gcal_create_event");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          calendarId?: string;
          summary?: string;
          description?: string;
          location?: string;
          start?: ScheduleSpec;
          end?: ScheduleSpec;
          attendees?: Array<{ email: string; displayName?: string; optional?: boolean }>;
          reminders?: {
            useDefault?: boolean;
            overrides?: Array<{ method: string; minutes: number }>;
          };
          sendUpdates?: string;
          idempotencyKey?: string;
        };

        if (!p.summary) return { error: "[EINVALID_INPUT] `summary` is required" };
        if (!p.start || (!p.start.dateTime && !p.start.date)) {
          return { error: "[EINVALID_INPUT] `start.dateTime` or `start.date` is required" };
        }
        if (!p.end || (!p.end.dateTime && !p.end.date)) {
          return { error: "[EINVALID_INPUT] `end.dateTime` or `end.date` is required" };
        }

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gcal_create_event");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_create_event", p.account);
          const cached = getCached(runCtx.companyId, "gcal_create_event", p.idempotencyKey);
          if (cached) return cached;

          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await cal.events.insert({
            calendarId: p.calendarId ?? "primary",
            sendUpdates: (p.sendUpdates as "all" | "externalOnly" | "none" | undefined) ?? "none",
            requestBody: {
              summary: p.summary,
              description: p.description,
              location: p.location,
              start: p.start,
              end: p.end,
              attendees: p.attendees,
              reminders: p.reminders,
            },
          });
          await track(ctx, runCtx, "gcal_create_event", resolved.accountKey);
          const out: ToolResult = {
            content: `Event created: ${res.data.htmlLink ?? res.data.id ?? "(no link)"}.`,
            data: { event: res.data },
          };
          putCached(runCtx.companyId, "gcal_create_event", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gcal_update_event (mutation) ----
  {
    const schema = findSchema("gcal_update_event");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          calendarId?: string;
          eventId?: string;
          patch?: Record<string, unknown>;
          sendUpdates?: string;
          idempotencyKey?: string;
        };
        if (!p.eventId) return { error: "[EINVALID_INPUT] `eventId` is required" };
        if (!p.patch || typeof p.patch !== "object") {
          return { error: "[EINVALID_INPUT] `patch` is required" };
        }

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gcal_update_event");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_update_event", p.account);
          const cached = getCached(runCtx.companyId, "gcal_update_event", p.idempotencyKey);
          if (cached) return cached;

          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          const res = await cal.events.patch({
            calendarId: p.calendarId ?? "primary",
            eventId: p.eventId,
            sendUpdates: (p.sendUpdates as "all" | "externalOnly" | "none" | undefined) ?? "none",
            requestBody: p.patch,
          });
          await track(ctx, runCtx, "gcal_update_event", resolved.accountKey);
          const out: ToolResult = {
            content: `Event updated: ${res.data.htmlLink ?? res.data.id ?? "(no link)"}.`,
            data: { event: res.data },
          };
          putCached(runCtx.companyId, "gcal_update_event", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gcal_delete_event (mutation) ----
  {
    const schema = findSchema("gcal_delete_event");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as {
          account?: string;
          calendarId?: string;
          eventId?: string;
          sendUpdates?: string;
          idempotencyKey?: string;
        };
        if (!p.eventId) return { error: "[EINVALID_INPUT] `eventId` is required" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gcal_delete_event");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gcal_delete_event", p.account);
          const cached = getCached(runCtx.companyId, "gcal_delete_event", p.idempotencyKey);
          if (cached) return cached;

          const cal = calendarApi({ version: "v3", auth: resolved.oauth2Client });
          await cal.events.delete({
            calendarId: p.calendarId ?? "primary",
            eventId: p.eventId,
            sendUpdates: (p.sendUpdates as "all" | "externalOnly" | "none" | undefined) ?? "none",
          });
          await track(ctx, runCtx, "gcal_delete_event", resolved.accountKey);
          const out: ToolResult = {
            content: `Event ${p.eventId} deleted.`,
            data: { deleted: true, eventId: p.eventId },
          };
          putCached(runCtx.companyId, "gcal_delete_event", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }
}
