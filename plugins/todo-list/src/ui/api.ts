/**
 * Browser-side client for the plugin's own API routes.
 *
 * Note that nothing here sends a user id. The server takes the owner from the
 * authenticated session, so there is no client-supplied identity to spoof. The
 * companyId in the query string exists only because the host requires every
 * board-auth plugin route to resolve a company; it does not select which list
 * you get, and your to-dos are the same in every company.
 */

import type { TodoApi } from "../todos.js";

const PLUGIN_ID = "todo-list";

/**
 * The row shape the browser sees. Defined once, in ../todos.ts, so the worker's
 * response and the page's expectations cannot drift apart.
 */
export type Todo = TodoApi;

function apiUrl(path: string, companyId: string, extra?: Record<string, string>): string {
  const url = new URL(`/api/plugins/${PLUGIN_ID}/api${path}`, window.location.origin);
  url.searchParams.set("companyId", companyId);
  for (const [key, value] of Object.entries(extra ?? {})) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

async function apiCall<T>(url: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type when there is a body. Express's req.is("application/json")
  // returns false for an empty body, which combined with a present content-type
  // header trips the host's "Plugin API routes accept JSON only" 415 check on
  // bodyless DELETE and POST requests.
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init?.body !== undefined && init?.body !== null) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { ...headers, ...((init?.headers as Record<string, string>) ?? {}) },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return payload as T;
}

export const todosApi = {
  list(companyId: string, opts: { includeDone?: boolean } = {}): Promise<{ todos: Todo[] }> {
    const extra = opts.includeDone === false ? { includeDone: "false" } : undefined;
    return apiCall(apiUrl("/todos", companyId, extra));
  },

  create(
    companyId: string,
    input: { title: string; dueAt?: string | null },
  ): Promise<{ todo: Todo }> {
    return apiCall(apiUrl("/todos", companyId), {
      method: "POST",
      body: JSON.stringify(input),
    });
  },

  update(
    companyId: string,
    todoId: string,
    patch: { title?: string; done?: boolean; dueAt?: string | null; sortOrder?: number },
  ): Promise<{ todo: Todo }> {
    return apiCall(apiUrl(`/todos/${todoId}`, companyId), {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  },

  remove(companyId: string, todoId: string): Promise<{ ok: true }> {
    return apiCall(apiUrl(`/todos/${todoId}`, companyId), { method: "DELETE" });
  },

  clearDone(companyId: string): Promise<{ deleted: number }> {
    return apiCall(apiUrl("/todos/clear-done", companyId), { method: "POST" });
  },

  promote(
    companyId: string,
    todoId: string,
  ): Promise<{ issueId: string; alreadyPromoted: boolean; warning: string | null }> {
    return apiCall(apiUrl(`/todos/${todoId}/promote-to-issue`, companyId), { method: "POST" });
  },
};
