/**
 * Tool schema definitions shared between manifest.ts (static declaration) and
 * worker.ts (runtime registration). Pure data — no runtime imports.
 */

export interface ToolSchema {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: {
    type: "object";
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

export const ALL_TOOLS: ToolSchema[] = [
  ...AUTH_TOOLS,
  ...CALENDAR_TOOLS,
  ...TASKS_TOOLS,
  ...SHEETS_TOOLS,
  ...DRIVE_TOOLS,
];
