import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigProject {
  key?: string;
  displayName?: string;
  readTokenRef?: string;
  writeTokenRef?: string;
  environment?: string;
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowMutations?: boolean;
  projects?: ConfigProject[];
  defaultProject?: string;
}

const ROLLBAR_BASE = "https://api.rollbar.com/api/1";

interface CachedAuth {
  readToken: string;
  writeToken: string | null;
  resolvedReadRef: string;
  resolvedWriteRef: string | null;
  metricsCache: Map<string, { data: unknown; expiresAt: number }>;
}

const authCache = new Map<string, CachedAuth>();
const cacheKey = (companyId: string, projectKey: string) =>
  `${companyId}::${projectKey.toLowerCase()}`;

export interface ResolvedProject {
  project: ConfigProject;
  projectKey: string;
  readToken: string;
  writeToken: string | null;
  metricsCache: Map<string, { data: unknown; expiresAt: number }>;
}

export async function getRollbarProject(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  projectKeyParam: string | undefined,
  needWriteToken = false,
): Promise<ResolvedProject> {
  const config = (await ctx.config.get()) as InstanceConfig;
  const projects = config.projects ?? [];

  const requestedKey = (projectKeyParam ?? config.defaultProject ?? "").trim();
  if (!requestedKey) {
    throw new Error(
      "[EPROJECT_REQUIRED] No `project` parameter provided and no `defaultProject` configured on the plugin settings page.",
    );
  }

  const project = projects.find(
    (p) => (p.key ?? "").toLowerCase() === requestedKey.toLowerCase(),
  );
  if (!project) {
    throw new Error(
      `[EPROJECT_NOT_FOUND] Rollbar project "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `rollbar-tools project "${project.key}"`,
    resourceKey: project.key ?? requestedKey,
    allowedCompanies: project.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if (!project.readTokenRef) {
    throw new Error(
      `[ECONFIG] Rollbar project "${project.key}" has no readTokenRef configured.`,
    );
  }
  if (needWriteToken && !project.writeTokenRef) {
    throw new Error(
      `[EDISABLED] Rollbar project "${project.key}" has no writeTokenRef. Add a write-scope token before enabling mutations.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, project.key ?? requestedKey);
  const cached = authCache.get(ck);
  if (
    cached &&
    cached.resolvedReadRef === project.readTokenRef &&
    cached.resolvedWriteRef === (project.writeTokenRef ?? null)
  ) {
    return {
      project,
      projectKey: project.key ?? requestedKey,
      readToken: cached.readToken,
      writeToken: cached.writeToken,
      metricsCache: cached.metricsCache,
    };
  }

  const readToken = await ctx.secrets.resolve(project.readTokenRef);
  if (!readToken) {
    throw new Error(
      `[ECONFIG] Rollbar project "${project.key}": read secret "${project.readTokenRef}" did not resolve.`,
    );
  }

  let writeToken: string | null = null;
  if (project.writeTokenRef) {
    writeToken = (await ctx.secrets.resolve(project.writeTokenRef)) ?? null;
    if (!writeToken) {
      throw new Error(
        `[ECONFIG] Rollbar project "${project.key}": write secret "${project.writeTokenRef}" did not resolve.`,
      );
    }
  }

  const metricsCache = new Map<string, { data: unknown; expiresAt: number }>();
  authCache.set(ck, {
    readToken,
    writeToken,
    resolvedReadRef: project.readTokenRef,
    resolvedWriteRef: project.writeTokenRef ?? null,
    metricsCache,
  });
  return {
    project,
    projectKey: project.key ?? requestedKey,
    readToken,
    writeToken,
    metricsCache,
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  useWriteToken?: boolean;
}

export async function rollbarRequest<T = unknown>(
  resolved: ResolvedProject,
  pathPart: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(ROLLBAR_BASE + pathPart);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const token = opts.useWriteToken ? resolved.writeToken : resolved.readToken;
  if (!token) {
    throw new Error(
      `[ECONFIG] Rollbar project "${resolved.projectKey}" has no ${opts.useWriteToken ? "write" : "read"} token resolved.`,
    );
  }

  const headers: Record<string, string> = {
    "X-Rollbar-Access-Token": token,
    Accept: "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    throw new Error(`[EROLLBAR_NETWORK] ${(err as Error).message}`);
  }

  let body: unknown = null;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      // tolerate empty / malformed JSON
    }
  }

  if (!res.ok) {
    const message =
      (body as { message?: string; err?: number } | null)?.message ??
      `HTTP ${res.status}`;
    throw new Error(mapStatusToErrorCode(res.status, message));
  }

  // Rollbar wraps responses as { err: 0, result: ... } when successful, but
  // the HTTP status is also 200 — extract result if present.
  const wrapped = body as { err?: number; result?: T; message?: string } | null;
  if (wrapped && typeof wrapped === "object" && "result" in wrapped) {
    if (wrapped.err && wrapped.err !== 0) {
      throw new Error(`[EROLLBAR_API] ${wrapped.message ?? "rollbar returned err=" + wrapped.err}`);
    }
    return (wrapped.result ?? null) as T;
  }
  return body as T;
}

function mapStatusToErrorCode(status: number, msg: string): string {
  if (status === 401) return `[EROLLBAR_AUTH] ${msg}`;
  if (status === 403) return `[EROLLBAR_PERM] ${msg}`;
  if (status === 404) return `[EROLLBAR_NOT_FOUND] ${msg}`;
  if (status === 422) return `[EROLLBAR_INVALID] ${msg}`;
  if (status === 429) return `[EROLLBAR_RATE_LIMIT] ${msg}`;
  if (status >= 500) return `[EROLLBAR_UPSTREAM_${status}] ${msg}`;
  return `[EROLLBAR_${status}] ${msg}`;
}
