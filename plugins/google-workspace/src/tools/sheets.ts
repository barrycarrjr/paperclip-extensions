import {
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { sheets as sheetsApi } from "@googleapis/sheets";
import { drive as driveApi } from "@googleapis/drive";
import {
  ensureMutationsAllowed,
  getGoogleAccount,
  type InstanceConfig,
  type ResolvedAccount,
  wrapGoogleError,
} from "../googleAuth.js";
import { SHEETS_TOOLS } from "../schemas.js";
import { track } from "../telemetry.js";
import { getCached, putCached } from "../idempotency.js";

function findSchema(name: string) {
  const s = SHEETS_TOOLS.find((t) => t.name === name);
  if (!s) throw new Error(`sheets schema missing: ${name}`);
  return s;
}

function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function moveFileToFolder(
  resolved: ResolvedAccount,
  fileId: string,
  parentFolderId: string,
): Promise<void> {
  const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });
  const meta = await drive.files.get({ fileId, fields: "parents" });
  const previousParents = (meta.data.parents ?? []).join(",");
  await drive.files.update({
    fileId,
    addParents: parentFolderId,
    removeParents: previousParents,
    fields: "id, parents",
  });
}

export function registerSheetsTools(ctx: PluginContext): void {
  // ---- gsheet_get_metadata ----
  {
    const schema = findSchema("gsheet_get_metadata");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as { account?: string; spreadsheetId?: string };
        if (!p.spreadsheetId) return { error: "[EINVALID_INPUT] `spreadsheetId` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gsheet_get_metadata", p.account);
          const sheets = sheetsApi({ version: "v4", auth: resolved.oauth2Client });
          const res = await sheets.spreadsheets.get({
            spreadsheetId: p.spreadsheetId,
            includeGridData: false,
          });
          const sheetSummaries = (res.data.sheets ?? []).map((s) => ({
            sheetId: s.properties?.sheetId,
            title: s.properties?.title,
            index: s.properties?.index,
            gridProperties: s.properties?.gridProperties,
          }));
          await track(ctx, runCtx, "gsheet_get_metadata", resolved.accountKey);
          return {
            content: `Spreadsheet: ${res.data.properties?.title ?? "(untitled)"} with ${sheetSummaries.length} tab(s).`,
            data: {
              spreadsheetId: res.data.spreadsheetId,
              title: res.data.properties?.title,
              spreadsheetUrl: res.data.spreadsheetUrl,
              sheets: sheetSummaries,
            },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gsheet_read ----
  {
    const schema = findSchema("gsheet_read");
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
          spreadsheetId?: string;
          range?: string;
          valueRenderOption?: string;
        };
        if (!p.spreadsheetId) return { error: "[EINVALID_INPUT] `spreadsheetId` is required" };
        if (!p.range) return { error: "[EINVALID_INPUT] `range` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gsheet_read", p.account);
          const sheets = sheetsApi({ version: "v4", auth: resolved.oauth2Client });
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId: p.spreadsheetId,
            range: p.range,
            valueRenderOption: (p.valueRenderOption as
              | "FORMATTED_VALUE"
              | "UNFORMATTED_VALUE"
              | "FORMULA"
              | undefined) ?? "FORMATTED_VALUE",
          });
          const values = res.data.values ?? [];
          await track(ctx, runCtx, "gsheet_read", resolved.accountKey, {
            rows: values.length,
          });
          return {
            content: `Read ${values.length} row(s) from ${p.range}.`,
            data: {
              range: res.data.range,
              majorDimension: res.data.majorDimension,
              values,
            },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gsheet_append (mutation) ----
  {
    const schema = findSchema("gsheet_append");
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
          spreadsheetId?: string;
          range?: string;
          values?: unknown[][];
          valueInputOption?: string;
          idempotencyKey?: string;
        };
        if (!p.spreadsheetId) return { error: "[EINVALID_INPUT] `spreadsheetId` is required" };
        if (!p.range) return { error: "[EINVALID_INPUT] `range` is required" };
        if (!Array.isArray(p.values)) return { error: "[EINVALID_INPUT] `values` must be a 2D array" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gsheet_append");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gsheet_append", p.account);
          const cached = getCached(runCtx.companyId, "gsheet_append", p.idempotencyKey);
          if (cached) return cached;

          const sheets = sheetsApi({ version: "v4", auth: resolved.oauth2Client });
          const res = await sheets.spreadsheets.values.append({
            spreadsheetId: p.spreadsheetId,
            range: p.range,
            valueInputOption: (p.valueInputOption as "RAW" | "USER_ENTERED" | undefined) ?? "USER_ENTERED",
            requestBody: { values: p.values as (string | number | boolean)[][] },
          });
          await track(ctx, runCtx, "gsheet_append", resolved.accountKey, {
            rows: p.values.length,
          });
          const out: ToolResult = {
            content: `Appended ${p.values.length} row(s) to ${res.data.updates?.updatedRange ?? p.range}.`,
            data: { updates: res.data.updates },
          };
          putCached(runCtx.companyId, "gsheet_append", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gsheet_update (mutation) ----
  {
    const schema = findSchema("gsheet_update");
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
          spreadsheetId?: string;
          range?: string;
          values?: unknown[][];
          valueInputOption?: string;
          idempotencyKey?: string;
        };
        if (!p.spreadsheetId) return { error: "[EINVALID_INPUT] `spreadsheetId` is required" };
        if (!p.range) return { error: "[EINVALID_INPUT] `range` is required" };
        if (!Array.isArray(p.values)) return { error: "[EINVALID_INPUT] `values` must be a 2D array" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gsheet_update");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gsheet_update", p.account);
          const cached = getCached(runCtx.companyId, "gsheet_update", p.idempotencyKey);
          if (cached) return cached;

          const sheets = sheetsApi({ version: "v4", auth: resolved.oauth2Client });
          const res = await sheets.spreadsheets.values.update({
            spreadsheetId: p.spreadsheetId,
            range: p.range,
            valueInputOption: (p.valueInputOption as "RAW" | "USER_ENTERED" | undefined) ?? "USER_ENTERED",
            requestBody: { values: p.values as (string | number | boolean)[][] },
          });
          await track(ctx, runCtx, "gsheet_update", resolved.accountKey, {
            rows: p.values.length,
          });
          const out: ToolResult = {
            content: `Updated ${res.data.updatedCells ?? 0} cell(s) at ${res.data.updatedRange ?? p.range}.`,
            data: {
              updatedRange: res.data.updatedRange,
              updatedRows: res.data.updatedRows,
              updatedColumns: res.data.updatedColumns,
              updatedCells: res.data.updatedCells,
            },
          };
          putCached(runCtx.companyId, "gsheet_update", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gsheet_create (mutation) ----
  {
    const schema = findSchema("gsheet_create");
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
          title?: string;
          sheets?: Array<{ title: string; headers?: string[] }>;
          parentFolderId?: string;
          idempotencyKey?: string;
        };
        if (!p.title) return { error: "[EINVALID_INPUT] `title` is required" };

        const config = (await ctx.config.get()) as InstanceConfig;
        try {
          ensureMutationsAllowed(ctx, config, "gsheet_create");
        } catch (err) {
          return { error: (err as Error).message };
        }

        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gsheet_create", p.account);
          const cached = getCached(runCtx.companyId, "gsheet_create", p.idempotencyKey);
          if (cached) return cached;

          const sheets = sheetsApi({ version: "v4", auth: resolved.oauth2Client });
          const sheetsRequest =
            p.sheets && p.sheets.length > 0
              ? p.sheets.map((s) => ({ properties: { title: s.title } }))
              : undefined;

          const res = await sheets.spreadsheets.create({
            requestBody: {
              properties: { title: p.title },
              sheets: sheetsRequest,
            },
          });

          const spreadsheetId = res.data.spreadsheetId!;

          // Write headers if provided.
          if (p.sheets) {
            const writes = p.sheets
              .filter((s) => s.headers && s.headers.length > 0)
              .map((s) =>
                sheets.spreadsheets.values.update({
                  spreadsheetId,
                  range: `${s.title}!A1`,
                  valueInputOption: "RAW",
                  requestBody: { values: [s.headers!] },
                }),
              );
            if (writes.length > 0) await Promise.all(writes);
          }

          if (p.parentFolderId) {
            try {
              await moveFileToFolder(resolved, spreadsheetId, p.parentFolderId);
            } catch (moveErr) {
              ctx.logger.warn(
                `gsheet_create: spreadsheet created (${spreadsheetId}) but moving to folder failed: ${(moveErr as Error).message}`,
              );
            }
          }

          await track(ctx, runCtx, "gsheet_create", resolved.accountKey);
          const out: ToolResult = {
            content: `Spreadsheet created: ${res.data.spreadsheetUrl ?? spreadsheetId}.`,
            data: {
              spreadsheetId,
              spreadsheetUrl: res.data.spreadsheetUrl,
            },
          };
          putCached(runCtx.companyId, "gsheet_create", p.idempotencyKey, out);
          return out;
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }

  // ---- gsheet_find_by_name ----
  {
    const schema = findSchema("gsheet_find_by_name");
    ctx.tools.register(
      schema.name,
      {
        displayName: schema.displayName,
        description: schema.description,
        parametersSchema: schema.parametersSchema,
      },
      async (params, runCtx: ToolRunContext): Promise<ToolResult> => {
        const p = (params ?? {}) as { account?: string; name?: string };
        if (!p.name) return { error: "[EINVALID_INPUT] `name` is required" };
        try {
          const resolved = await getGoogleAccount(ctx, runCtx, "gsheet_find_by_name", p.account);
          const drive = driveApi({ version: "v3", auth: resolved.oauth2Client });
          const q =
            `mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false ` +
            `and name contains '${escapeDriveQueryString(p.name)}'`;
          const res = await drive.files.list({
            q,
            pageSize: 25,
            fields: "files(id, name, modifiedTime, webViewLink)",
            orderBy: "modifiedTime desc",
          });
          const files = res.data.files ?? [];
          await track(ctx, runCtx, "gsheet_find_by_name", resolved.accountKey, {
            count: files.length,
          });
          return {
            content: `Found ${files.length} spreadsheet(s) matching "${p.name}".`,
            data: { spreadsheets: files },
          };
        } catch (err) {
          return { error: wrapGoogleError(err) };
        }
      },
    );
  }
}
