import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "todo-list";
const PLUGIN_VERSION = "0.2.0";

const SETUP_INSTRUCTIONS = `# Setup, To-dos

A private scratchpad list. Nothing external to wire up, no API keys, no OAuth.
Reckon on **about 1 minute**.

## 1. Set Allowed companies to Portfolio-wide

In **Configuration, Allowed companies**, tick **Portfolio-wide** (\`['*']\`).

This one is worth understanding, because it does not mean what it usually does.
Your to-dos are **not** stored per company. They belong to you, and the list is
the same whichever company you are looking at. The allow-list only decides where
the plugin is switched **on**.

So if you allow-list only two companies, your list quietly disappears from the
sidebar while you are in a third one, even though the items are still yours and
still there. Portfolio-wide avoids that. Pick a narrower list only if you
deliberately want the list hidden in some companies.

## 2. (Optional) Hide the sidebar entry or the capture box

**Show in sidebar** is on by default. Turn it off to keep the page reachable at
\`/:companyPrefix/todos\` with no nav link.

**Show quick capture box** is also on by default. This is the one-line input
that sits under the sidebar entry so you can jot something down without leaving
whatever page you are on. Turn it off if you would rather have just the link.

---

## What this is not

- **Not shared.** Nobody else can see your list, including other members of the
  same company and including instance admins. Rows are matched on your user id.
- **Not an issue.** Writing a to-do wakes no agent, sends no notification, and
  puts nothing in anyone's inbox. When something turns out to be real work, hit
  **Promote to issue** on the row and it becomes a proper issue with you as the
  author. The to-do stays put so you can still tick it off.
- **Not a team tool.** Clippy can add, read, tick off and delete items for you,
  and it always acts on the list of whoever is talking to it. Agents running on
  their own cannot touch any list, because there is no person behind an agent
  run to own the items.

---

## Smoke test

1. Type a line into the sidebar box and press Enter. It should clear and stay
   focused, without navigating away.
2. Click **To-dos** in the sidebar. The item should be there.
3. Tick it. It should drop into the collapsed **Done** section.
4. Untick it. It should return to exactly where it was in the list.
5. Switch to a different company. The same list should be showing.
`;

const manifest: PaperclipPluginManifestV1 & { setupInstructions?: string } = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "To-dos",
  description:
    "A private personal to-do list. One line of text, a tick box, an optional due date. Items belong to the operator who wrote them rather than to a company, so the same list follows you everywhere and nobody else can see it. Quick capture from the sidebar without leaving the page you are on, and a one-click promote into a real issue when something turns out to be actual work.",
  author: "Barry Carr & Tony Allard",
  categories: ["ui"],
  setupInstructions: SETUP_INSTRUCTIONS,
  capabilities: [
    "instance.settings.register",
    "ui.sidebar.register",
    "ui.page.register",
    "api.routes.register",
    "database.namespace.read",
    "database.namespace.write",
    "database.namespace.migrate",
    "issues.create",
    "agent.tools.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui/",
  },
  database: {
    namespaceSlug: "todolist",
    migrationsDir: "migrations",
  },
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    propertyOrder: ["allowedCompanies", "showInSidebar", "showCaptureBox"],
    properties: {
      allowedCompanies: {
        type: "array",
        title: "Allowed companies",
        description:
          "Which companies have To-dos switched on. This does NOT partition your list: your to-dos belong to you, not to a company, and the same list shows everywhere. Allow-listing only some companies means the list disappears from the sidebar in the others, so 'Portfolio-wide' ['*'] is the recommended setting. Empty = unusable (fail-safe deny).",
        items: { type: "string", format: "company-id" },
      },
      showInSidebar: {
        type: "boolean",
        default: true,
        title: "Show in sidebar",
        description:
          "Whether the To-dos entry appears in the sidebar. Off = the page is still reachable at /:companyPrefix/todos but there is no nav link.",
      },
      showCaptureBox: {
        type: "boolean",
        default: true,
        title: "Show quick capture box",
        description:
          "Whether the one-line 'Add a to-do' input appears under the sidebar entry. This is the fastest way to jot something down without leaving the page you are on. Off = the sidebar shows only the nav link.",
      },
    },
    required: ["allowedCompanies"],
  },
  apiRoutes: [
    {
      routeKey: "todos.list",
      method: "GET",
      path: "/todos",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "todos.create",
      method: "POST",
      path: "/todos",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "todos.update",
      method: "PATCH",
      path: "/todos/:todoId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "todos.delete",
      method: "DELETE",
      path: "/todos/:todoId",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "todos.clear-done",
      method: "POST",
      path: "/todos/clear-done",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
    {
      routeKey: "todos.promote",
      method: "POST",
      path: "/todos/:todoId/promote-to-issue",
      auth: "board",
      capability: "api.routes.register",
      companyResolution: { from: "query", key: "companyId" },
    },
  ],
  // Every tool works out whose list it is from the calling user, which the host
  // supplies. None of them takes an owner as a parameter, so the model cannot
  // name a person and reach somebody else's items.
  tools: [
    {
      name: "todo_add",
      displayName: "Add a to-do",
      description:
        "Add an item to the operator's private personal to-do list. Use this for quick personal reminders like 'call the accountant' or 'renew the insurance'. This is NOT the issue tracker: do not use it for team work, anything that needs assigning, or anything another person should see. The list belongs to whoever is talking to you and nobody else can read it.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            description: "The to-do text, one short line. Required.",
          },
          dueAt: {
            type: "string",
            description:
              "Optional due date as an ISO 8601 timestamp. Resolve relative dates like 'Friday' to an actual date before calling. Omit when no date was mentioned; do not invent one.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "todo_list",
      displayName: "List to-dos",
      description:
        "Read back the operator's private personal to-do list, in their chosen order. Returns only the caller's own items. Use before completing or removing something so you can quote the exact text back to them.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          includeDone: {
            type: "boolean",
            description:
              "Include items already ticked off. Defaults to false, which returns only outstanding ones.",
          },
        },
      },
    },
    {
      name: "todo_complete",
      displayName: "Tick off a to-do",
      description:
        "Mark one of the operator's to-dos as done, or put it back to not-done. Identify it with `match`, a distinctive fragment of its text. If the fragment matches more than one item the call fails and lists the candidates: show them to the operator and ask which they meant rather than guessing.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          match: {
            type: "string",
            description:
              "A distinctive fragment of the item's text, for example 'accountant'. Required.",
          },
          done: {
            type: "boolean",
            description:
              "True to tick it off (the default), false to put it back on the list.",
          },
        },
        required: ["match"],
      },
    },
    {
      name: "todo_remove",
      displayName: "Delete a to-do",
      description:
        "Permanently delete one of the operator's to-dos. Prefer todo_complete when they have finished it; use this only when they want it gone entirely, for example something added by mistake. Same matching rules as todo_complete, and an ambiguous fragment deletes nothing.",
      parametersSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          match: {
            type: "string",
            description: "A distinctive fragment of the item's text. Required.",
          },
        },
        required: ["match"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "todo-list-sidebar",
        displayName: "To-dos",
        exportName: "TodoSidebarItem",
      },
      {
        type: "page",
        id: "todo-list-page",
        displayName: "To-dos",
        exportName: "TodoPage",
        routePath: "todos",
      },
    ],
  },
};

export default manifest;
