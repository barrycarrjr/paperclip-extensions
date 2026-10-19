/**
 * Tool schema definitions shared between manifest.ts (static declaration) and
 * worker.ts (runtime registration). Pure data — no runtime imports.
 */

export interface ToolSchema {
  name: string;
  displayName: string;
  description: string;
  writes?: boolean;
  actionType?: "change_files";
  executionTimeoutMs?: number;
  parametersSchema: {
    type: "object";
    additionalProperties?: boolean;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const accountParam = {
  type: "string",
  description:
    "Google account key (matches the Identifier on the plugin's settings page). Optional if defaultAccount is configured.",
} as const;

const idempotencyKey = {
  type: "string",
  description: "Optional idempotency key. Mutation tools that succeed will short-circuit on retry with the same key (best-effort, in-memory).",
} as const;

const calendarIdParam = {
  type: "string",
  description: "Google Calendar ID. Defaults to 'primary'.",
} as const;

export const CALENDAR_TOOLS: ToolSchema[] = [
  {
    name: "gcal_list_calendars",
    displayName: "List calendars",
    description: "List all calendars the authorized account can see (own + subscribed).",
    parametersSchema: {
      type: "object",
      properties: { account: accountParam },
    },
  },
  {
    name: "gcal_list_events",
    displayName: "List calendar events",
    description: "List events on a calendar within a time window. Defaults to today through 7 days out.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        calendarId: calendarIdParam,
        timeMin: { type: "string", description: "ISO 8601 lower bound (inclusive)." },
        timeMax: { type: "string", description: "ISO 8601 upper bound (exclusive)." },
        q: { type: "string", description: "Free-text search across event fields." },
        maxResults: { type: "number", description: "Max events (1-2500). Defaults to 250." },
        pageToken: { type: "string" },
      },
    },
  },
  {
    name: "gcal_get_event",
    displayName: "Get calendar event",
    description: "Fetch a single calendar event by ID.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        calendarId: calendarIdParam,
        eventId: { type: "string" },
      },
      required: ["eventId"],
    },
  },
  {
    name: "gcal_create_event",
    displayName: "Create calendar event",
    description:
      "Create a new event. Mutation — requires allowMutations=true on the plugin settings page.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        calendarId: calendarIdParam,
        summary: { type: "string" },
        description: { type: "string" },
        location: { type: "string" },
        start: {
          type: "object",
          description: "Either {dateTime, timeZone?} for timed events or {date} for all-day events.",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
        },
        end: {
          type: "object",
          properties: {
            dateTime: { type: "string" },
            date: { type: "string" },
            timeZone: { type: "string" },
          },
        },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              displayName: { type: "string" },
              optional: { type: "boolean" },
            },
            required: ["email"],
          },
        },
        reminders: {
          type: "object",
          properties: {
            useDefault: { type: "boolean" },
            overrides: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  method: { type: "string", description: "'email' or 'popup'." },
                  minutes: { type: "number" },
                },
              },
            },
          },
        },
        sendUpdates: { type: "string", description: "'all', 'externalOnly', or 'none' (default)." },
        idempotencyKey,
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "gcal_update_event",
    displayName: "Update calendar event",
    description:
      "Partially update an existing event (events.patch). Only fields in `patch` are changed. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        calendarId: calendarIdParam,
        eventId: { type: "string" },
        patch: {
          type: "object",
          description:
            "Partial event resource (summary, description, location, start, end, attendees, etc.).",
        },
        sendUpdates: { type: "string" },
        idempotencyKey,
      },
      required: ["eventId", "patch"],
    },
  },
  {
    name: "gcal_delete_event",
    displayName: "Delete calendar event",
    description:
      "Delete a calendar event. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        calendarId: calendarIdParam,
        eventId: { type: "string" },
        sendUpdates: { type: "string" },
        idempotencyKey,
      },
      required: ["eventId"],
    },
  },
  {
    name: "gcal_freebusy",
    displayName: "Free/busy lookup",
    description: "Returns busy intervals on the named calendars within [timeMin, timeMax).",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        calendarIds: { type: "array", items: { type: "string" } },
      },
      required: ["timeMin", "timeMax"],
    },
  },
];

export const TASKS_TOOLS: ToolSchema[] = [
  {
    name: "gtasks_list_lists",
    displayName: "List task lists",
    description: "List all Google Tasks lists for the authorized account.",
    parametersSchema: {
      type: "object",
      properties: { account: accountParam },
    },
  },
  {
    name: "gtasks_list_tasks",
    displayName: "List tasks in a list",
    description:
      "List tasks within a task list. By default returns incomplete tasks; pass showCompleted to include completed ones (note: completed tasks lose their `due` field in the API response).",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        listId: { type: "string" },
        showCompleted: { type: "boolean" },
        showHidden: { type: "boolean" },
        dueMin: { type: "string", description: "ISO 8601." },
        dueMax: { type: "string", description: "ISO 8601." },
        maxResults: { type: "number", description: "1-100. Defaults to 100." },
        pageToken: { type: "string" },
      },
      required: ["listId"],
    },
  },
  {
    name: "gtasks_create_task",
    displayName: "Create task",
    description: "Create a new task in a list. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        listId: { type: "string" },
        title: { type: "string" },
        notes: { type: "string" },
        due: { type: "string", description: "ISO 8601 due date (Tasks API ignores time-of-day)." },
        parent: { type: "string", description: "Parent task ID for subtasks." },
        previous: { type: "string", description: "Previous sibling task ID for ordering." },
        idempotencyKey,
      },
      required: ["listId", "title"],
    },
  },
  {
    name: "gtasks_update_task",
    displayName: "Update task",
    description: "Partially update a task. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        listId: { type: "string" },
        taskId: { type: "string" },
        patch: {
          type: "object",
          description: "Partial task resource (title, notes, due, status).",
        },
        idempotencyKey,
      },
      required: ["listId", "taskId", "patch"],
    },
  },
  {
    name: "gtasks_complete_task",
    displayName: "Complete task",
    description: "Mark a task as completed. Convenience wrapper around update with status='completed'. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        listId: { type: "string" },
        taskId: { type: "string" },
        idempotencyKey,
      },
      required: ["listId", "taskId"],
    },
  },
  {
    name: "gtasks_delete_task",
    displayName: "Delete task",
    description: "Delete a task. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        listId: { type: "string" },
        taskId: { type: "string" },
        idempotencyKey,
      },
      required: ["listId", "taskId"],
    },
  },
];

export const SHEETS_TOOLS: ToolSchema[] = [
  {
    name: "gsheet_get_metadata",
    displayName: "Get spreadsheet metadata",
    description: "Returns the spreadsheet title and the list of contained sheets (id, title, gridProperties).",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        spreadsheetId: { type: "string" },
      },
      required: ["spreadsheetId"],
    },
  },
  {
    name: "gsheet_read",
    displayName: "Read sheet range",
    description: "Read a range from a spreadsheet. Returns a 2D array of values.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        spreadsheetId: { type: "string" },
        range: { type: "string", description: "A1 notation, e.g. 'Sheet1!A1:D100' or 'Sheet1'." },
        valueRenderOption: {
          type: "string",
          description: "FORMATTED_VALUE (default), UNFORMATTED_VALUE, or FORMULA.",
        },
      },
      required: ["spreadsheetId", "range"],
    },
  },
  {
    name: "gsheet_append",
    displayName: "Append rows to sheet",
    description: "Append rows to a sheet's range. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: {
          type: "array",
          items: { type: "array" },
          description: "2D array of cell values.",
        },
        valueInputOption: {
          type: "string",
          description: "USER_ENTERED (default; formulas are parsed) or RAW.",
        },
        idempotencyKey,
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "gsheet_update",
    displayName: "Update sheet range",
    description: "Overwrite values at a specific range. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        spreadsheetId: { type: "string" },
        range: { type: "string" },
        values: { type: "array", items: { type: "array" } },
        valueInputOption: { type: "string" },
        idempotencyKey,
      },
      required: ["spreadsheetId", "range", "values"],
    },
  },
  {
    name: "gsheet_create",
    displayName: "Create spreadsheet",
    description:
      "Create a new spreadsheet. If parentFolderId is set, moves the new file there via Drive API. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        title: { type: "string" },
        sheets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              headers: { type: "array", items: { type: "string" } },
            },
          },
        },
        parentFolderId: { type: "string" },
        idempotencyKey,
      },
      required: ["title"],
    },
  },
  {
    name: "gsheet_find_by_name",
    displayName: "Find spreadsheet by name",
    description:
      "Drive search shortcut — find spreadsheets matching a name. Returns up to 25 matches with id, name, modifiedTime.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        name: { type: "string", description: "Exact or partial name (uses Drive 'name contains')." },
      },
      required: ["name"],
    },
  },
];

export const DRIVE_TOOLS: ToolSchema[] = [
  {
    name: "gdrive_list_folder",
    displayName: "List folder contents",
    description: "List files inside a Drive folder.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        folderId: { type: "string" },
        query: { type: "string", description: "Additional Drive query syntax to AND with the parent filter." },
        pageSize: { type: "number" },
        pageToken: { type: "string" },
      },
      required: ["folderId"],
    },
  },
  {
    name: "gdrive_search",
    displayName: "Search Drive",
    description: "Pass-through Drive search using Google's query syntax.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        query: { type: "string" },
        pageSize: { type: "number" },
        pageToken: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "gdrive_get_file_metadata",
    displayName: "Get file metadata",
    description: "Returns Drive metadata for a single file.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        fileId: { type: "string" },
      },
      required: ["fileId"],
    },
  },
  {
    name: "gdrive_create_folder",
    displayName: "Create folder",
    description: "Create a new Drive folder. Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        name: { type: "string" },
        parentFolderId: { type: "string" },
        idempotencyKey,
      },
      required: ["name"],
    },
  },
  {
    name: "gdrive_upload_file",
    displayName: "Upload file",
    description:
      "Upload a file to Drive. Two input modes: inline `content` (base64-encoded, for small files) or `localPath` (worker reads + streams). Mutation — requires allowMutations.",
    parametersSchema: {
      type: "object",
      properties: {
        account: accountParam,
        name: { type: "string" },
        parentFolderId: { type: "string" },
        mimeType: {
          type: "string",
          description: "Defaults to derived-from-extension or application/octet-stream.",
        },
        content: { type: "string", description: "Base64-encoded file content. Use this OR localPath." },
        localPath: { type: "string", description: "Absolute path on the worker host. Use this OR content." },
        idempotencyKey,
      },
      required: ["name"],
    },
  },
];

export const AUTH_TOOLS: ToolSchema[] = [
  {
    name: "google_test_auth",
    displayName: "Test Google authentication",
    description:
      "Verify a configured Google account can authenticate (calls oauth2.userinfo.get). Useful for plugin setup verification.",
    parametersSchema: {
      type: "object",
      properties: { account: accountParam },
    },
  },
];

const exactId = { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$", description: "Exact Google file ID, never a URL, local path or copied document." };
const tabId = { type: "string", pattern: "^[A-Za-z0-9_.-]{1,200}$", description: "Exact tab ID returned by gdoc_read, such as t.0. Required when the document has multiple tabs." };
const revisionId = { type: "string", minLength: 1, maxLength: 500, description: "Exact revisionId from gdoc_read. A changed document is refused; no automatic retry." };
const textParam = { type: "string", minLength: 1, maxLength: 20000, description: "Plain text. Google inherits nearby formatting. Newlines create paragraphs; Markdown is not parsed." };
const page = {
  offset: { type: "integer", minimum: 0, description: "UTF-16 offset in returned text, not a Google document index. Later pages require the previous snapshot token or revision/version." },
  maxChars: { type: "integer", minimum: 2, maximum: 20000, default: 10000 },
};
export const DOCS_TOOLS: ToolSchema[] = [
  {
    name: "gdoc_read", displayName: "Read Google Doc", writes: false, executionTimeoutMs: 30000,
    description: "Read one existing Google Doc by its exact Drive file ID. Returns tab choices or paginated body text, structured headings and paragraph indices. Includes table text; flags unsupported elements and suggestions. Never creates a copy.",
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: accountParam, documentId: exactId, tabId, requiredRevisionId: revisionId,
      requiredReadToken: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact readToken from the previous page with the same selected tabId. Pins full visible text, paragraph data and metadata before pagination, excluding temporary image URLs. Also usable without editor revision IDs." }, ...page }, required: ["documentId"] },
  },
  {
    name: "gdoc_insert_text", displayName: "Insert Google Doc text", actionType: "change_files", executionTimeoutMs: 30000,
    description: "Insert plain text at an existing paragraph's UTF-16 Google index. Requires mutation switch, current revision and explicit tab for multi-tab docs. Suggestions and unsafe indices are refused.",
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: accountParam, documentId: exactId, tabId, requiredRevisionId: revisionId, text: textParam, index: { type: "integer", minimum: 1 } }, required: ["documentId", "requiredRevisionId", "text", "index"] },
  },
  {
    name: "gdoc_append_text", displayName: "Append Google Doc text", actionType: "change_files", executionTimeoutMs: 30000,
    description: "Append plain text before the selected tab body's final newline, preserving the exact document ID. Requires mutation switch and current revision. Suggestions are refused.",
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: accountParam, documentId: exactId, tabId, requiredRevisionId: revisionId, text: textParam }, required: ["documentId", "requiredRevisionId", "text"] },
  },
  {
    name: "gdoc_replace_text", displayName: "Replace Google Doc text range", actionType: "change_files", executionTimeoutMs: 30000,
    description: "Replace one exact plain-text range within a paragraph, excluding its final newline. Both indices are Google UTF-16 indices from gdoc_read, not page offsets. Requires expectedText match and current revision. No whole-document rewrite or unrestricted batch requests.",
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: accountParam, documentId: exactId, tabId, requiredRevisionId: revisionId, text: textParam, expectedText: { type: "string", minLength: 1, maxLength: 20000 }, startIndex: { type: "integer", minimum: 1 }, endIndex: { type: "integer", minimum: 2, description: "Exclusive end index." } }, required: ["documentId", "requiredRevisionId", "text", "expectedText", "startIndex", "endIndex"] },
  },
];

export const DRIVE_CONTENT_TOOLS: ToolSchema[] = [
  {
    name: "gdrive_read_file", displayName: "Read Drive file content", writes: false, executionTimeoutMs: 30000,
    description: "Read an existing file by exact ID, default 32 KiB, configurable up to 1 MiB. Blobs use media download; native files use an allowed export. Returns paginated UTF-8 text or bounded whole-file base64. Folders and shortcut targets are not followed. Use gdoc_read for structured headings and gsheet_read for sheet tabs.",
    parametersSchema: { type: "object", additionalProperties: false, properties: {
      account: accountParam, fileId: exactId, ...page,
      encoding: { type: "string", enum: ["text", "base64"], description: "Defaults to text for textual MIME types, otherwise base64. Text must be valid UTF-8." },
      exportMimeType: { type: "string", enum: ["text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "application/pdf", "image/png", "image/svg+xml"], description: "Native files only. Docs: plain/markdown/PDF; Slides: plain/PDF; Sheets: CSV/TSV (first sheet only) or PDF; Drawings: PNG/SVG/PDF. Docs and Slides default to plain text; other native files require explicit choice." },
      maxBytes: { type: "integer", minimum: 1, maximum: 1048576, default: 32768, description: "Streamed byte cap. Explicitly raising this can return up to about 1.4 MiB of base64 JSON." },
      requiredVersion: { type: "string", pattern: "^[0-9]{1,30}$", description: "Version from the previous page. Required for offset greater than zero." },
    }, required: ["fileId"] },
  },
  {
    name: "gdrive_rename_file", displayName: "Rename Drive file", actionType: "change_files", executionTimeoutMs: 30000,
    description: "Rename one exact Drive file ID. Only its name is patched; parents, contents and permissions are not requested for update. Requires mutation switch.",
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: accountParam, fileId: exactId, name: { type: "string", minLength: 1, maxLength: 255 } }, required: ["fileId", "name"] },
  },
  {
    name: "gdrive_move_file", displayName: "Move Drive file", actionType: "change_files", executionTimeoutMs: 30000,
    description: "Move one exact file ID from expectedParentId into an existing destinationFolderId with one atomic PATCH. Refuses unknown/multiple/mismatched parents and folder trees. Never deletes or trashes. Moving can change inherited folder access. Requires mutation switch.",
    parametersSchema: { type: "object", additionalProperties: false, properties: { account: accountParam, fileId: exactId, expectedParentId: exactId, destinationFolderId: exactId }, required: ["fileId", "expectedParentId", "destinationFolderId"] },
  },
];

export const ALL_TOOLS: ToolSchema[] = [
  ...AUTH_TOOLS,
  ...CALENDAR_TOOLS,
  ...TASKS_TOOLS,
  ...SHEETS_TOOLS,
  ...DRIVE_TOOLS,
  ...DOCS_TOOLS,
  ...DRIVE_CONTENT_TOOLS,
];
