import type { PluginContext, ToolRunContext } from "@paperclipai/plugin-sdk";
import { assertCompanyAccess } from "./companyAccess.js";

export interface ConfigProject {
  key?: string;
  displayName?: string;
  apiKeyRef?: string;
  projectId?: string;
  allowedCompanies?: string[];
}

export interface InstanceConfig {
  allowMutations?: boolean;
  projects?: ConfigProject[];
  defaultProject?: string;
}

const RC_V1 = "https://api.revenuecat.com/v1";
const RC_V2 = "https://api.revenuecat.com/v2";

interface CachedAuth {
  apiKey: string;
  resolvedRef: string;
  metricsCache: Map<string, { data: unknown; expiresAt: number }>;
}

const authCache = new Map<string, CachedAuth>();
const cacheKey = (companyId: string, projectKey: string) =>
  `${companyId}::${projectKey.toLowerCase()}`;

export interface ResolvedProject {
  project: ConfigProject;
  projectKey: string;
  apiKey: string;
  metricsCache: Map<string, { data: unknown; expiresAt: number }>;
}

export async function getRcProject(
  ctx: PluginContext,
  runCtx: ToolRunContext,
  toolName: string,
  projectKeyParam: string | undefined,
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
      `[EPROJECT_NOT_FOUND] RevenueCat project "${requestedKey}" is not configured on the plugin settings page.`,
    );
  }

  assertCompanyAccess(ctx, {
    tool: toolName,
    resourceLabel: `revenuecat-tools project "${project.key}"`,
    resourceKey: project.key ?? requestedKey,
    allowedCompanies: project.allowedCompanies,
    companyId: runCtx.companyId,
  });

  if (!project.apiKeyRef) {
    throw new Error(
      `[ECONFIG] RevenueCat project "${project.key}" has no apiKeyRef configured.`,
    );
  }

  const ck = cacheKey(runCtx.companyId, project.key ?? requestedKey);
  const cached = authCache.get(ck);
  if (cached && cached.resolvedRef === project.apiKeyRef) {
    return {
      project,
      projectKey: project.key ?? requestedKey,
      apiKey: cached.apiKey,
      metricsCache: cached.metricsCache,
    };
  }

  const apiKey = await ctx.secrets.resolve(project.apiKeyRef);
  if (!apiKey) {
    throw new Error(
      `[ECONFIG] RevenueCat project "${project.key}": secret "${project.apiKeyRef}" did not resolve.`,
    );
  }

  const metricsCache = new Map<string, { data: unknown; expiresAt: number }>();
  authCache.set(ck, { apiKey, resolvedRef: project.apiKeyRef, metricsCache });
  return {
    project,
    projectKey: project.key ?? requestedKey,
    apiKey,
    metricsCache,
  };
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  apiVersion?: "v1" | "v2";
}

export async function rcRequest<T = unknown>(
  resolved: ResolvedProject,
  pathPart: string,
  opts: RequestOptions = {},
): Promise<T> {
  const base = opts.apiVersion === "v2" ? RC_V2 : RC_V1;
  const url = new URL(base + pathPart);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolved.apiKey}`,
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
    throw new Error(`[ERC_NETWORK] ${(err as Error).message}`);
  }

  let body: unknown = null;
  if (res.status !== 204) {
    try {
      body = await res.json();
    } catch {
      // tolerate
    }
  }

  if (!res.ok) {
    const message =
      (body as { message?: string; error?: string } | null)?.message ??
      (body as { error?: string } | null)?.error ??
      `HTTP ${res.status}`;
    throw new Error(mapStatusToErrorCode(res.status, message));
  }

  return body as T;
}

function mapStatusToErrorCode(status: number, msg: string): string {
  if (status === 401) return `[ERC_AUTH] ${msg}`;
  if (status === 403) return `[ERC_FORBIDDEN] ${msg}`;
  if (status === 404) return `[ERC_NOT_FOUND] ${msg}`;
  if (status === 422) return `[ERC_INVALID] ${msg}`;
  if (status === 429) return `[ERC_RATE_LIMIT] ${msg}`;
  if (status >= 500) return `[ERC_UPSTREAM_${status}] ${msg}`;
  return `[ERC_${status}] ${msg}`;
}
