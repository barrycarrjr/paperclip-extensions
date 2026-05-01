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
  getOctokit,
  idempotencyLabel,
  resolveRepo,
  wrapGithubError,
} from "./githubClient.js";
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
    const resolved = await getOctokit(ctx, runCtx, toolName, accountKey);
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
    await ctx.telemetry.track(`github-tools.${tool}`, {
      account: accountKey,
      companyId: runCtx.companyId,
      runId: runCtx.runId,
      ...extra,
    });
  } catch {
    // no-op
  }
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    ctx.logger.info("github-tools plugin setup");

    const rawConfig = (await ctx.config.get()) as InstanceConfig;
    const allowMutations = !!rawConfig.allowMutations;
    const accounts: ConfigAccount[] = rawConfig.accounts ?? [];

    if (accounts.length === 0) {
      ctx.logger.warn(
        "github-tools: no accounts configured. Add them on /instance/settings/plugins/github-tools.",
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
          const repos =
            a.allowedRepos && a.allowedRepos.length > 0
              ? `${a.allowedRepos.length} repo(s)`
              : "any repo";
          return `${k} [${access}, ${repos}]`;
        })
        .join(", ");
      ctx.logger.info(
        `github-tools: ready (mutations ${allowMutations ? "ENABLED" : "disabled"}). Accounts — ${summary}`,
      );

      const orphans = accounts.filter(
        (a) => !a.allowedCompanies || a.allowedCompanies.length === 0,
      );
      if (orphans.length > 0) {
        ctx.logger.warn(
          `github-tools: ${orphans.length} account(s) have no allowedCompanies and will reject every call.`,
        );
      }
    }

    function gateMutation(tool: string): { error: string } | null {
      if (allowMutations) return null;
      return {
        error: `[EDISABLED] ${tool} is disabled. Enable 'Allow create/update/close/release/PR write' on /instance/settings/plugins/github-tools.`,
      };
    }

    // ─── Read tools ──────────────────────────────────────────────────────

    ctx.tools.register(
      "github_list_repos",
      {
        displayName: "List GitHub repos",
        description: "List repos for an owner.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            type: { type: "string" },
            sort: { type: "string" },
            perPage: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          type?: "all" | "public" | "private" | "owner" | "member";
          sort?: "created" | "updated" | "pushed" | "full_name";
          perPage?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "github_list_repos", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const owner = p.owner ?? r.resolved.account.defaultOwner;
          if (!owner) return { error: "[EINVALID_INPUT] No `owner` and no `defaultOwner` on the account." };

          // Try as user, fall back to org. The user-facing API is `repos.listForUser`
          // for users and `repos.listForOrg` for orgs. We don't know which without
          // hitting `users.getByUsername` first; use Search instead for a uniform path.
          const result = await r.resolved.client.search.repos({
            q: `user:${owner}`,
            sort: (p.sort as "updated" | undefined) ?? "updated",
            per_page: clampPerPage(p.perPage),
          });

          let repos = result.data.items.map((rp) => ({
            id: rp.id,
            name: rp.name,
            fullName: rp.full_name,
            private: rp.private,
            description: rp.description,
            updatedAt: rp.updated_at,
            stars: rp.stargazers_count,
          }));

          // Filter to allowedRepos if set
          const allow = r.resolved.account.allowedRepos;
          if (allow && allow.length > 0) {
            const set = new Set(allow.map((a) => a.toLowerCase()));
            repos = repos.filter((rp) => set.has(rp.fullName.toLowerCase()));
          }

          await track(ctx, runCtx, "github_list_repos", r.resolved.accountKey, {
            owner,
            count: repos.length,
          });
          return {
            content: `Listed ${repos.length} repo(s) for ${owner}.`,
            data: { repos, totalCount: result.data.total_count },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_get_issue",
      {
        displayName: "Get GitHub issue",
        description: "Retrieve a single issue.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            issueNumber: { type: "number" },
          },
          required: ["issueNumber"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          issueNumber?: number;
        };
        if (!p.issueNumber) return { error: "[EINVALID_INPUT] `issueNumber` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_get_issue", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.issues.get({
            owner,
            repo,
            issue_number: p.issueNumber,
          });
          await track(ctx, runCtx, "github_get_issue", r.resolved.accountKey, {
            owner,
            repo,
            issueNumber: p.issueNumber,
          });
          return {
            content: `Retrieved ${owner}/${repo}#${p.issueNumber}.`,
            data: slimIssue(result.data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_list_issues",
      {
        displayName: "List GitHub issues",
        description: "List issues with filters.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            assignee: { type: "string" },
            since: { type: "string" },
            sort: { type: "string" },
            direction: { type: "string" },
            perPage: { type: "number" },
            page: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          state?: "open" | "closed" | "all";
          labels?: string[];
          assignee?: string;
          since?: string;
          sort?: "created" | "updated" | "comments";
          direction?: "asc" | "desc";
          perPage?: number;
          page?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "github_list_issues", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.issues.listForRepo({
            owner,
            repo,
            state: p.state ?? "open",
            labels: p.labels?.join(","),
            assignee: p.assignee,
            since: p.since,
            sort: p.sort ?? "created",
            direction: p.direction ?? "desc",
            per_page: clampPerPage(p.perPage),
            page: p.page,
          });
          // Filter out PRs (issues.listForRepo returns both)
          const issues = result.data.filter((i) => !i.pull_request).map(slimIssue);
          await track(ctx, runCtx, "github_list_issues", r.resolved.accountKey, {
            owner,
            repo,
            count: issues.length,
          });
          return {
            content: `Listed ${issues.length} issue(s) on ${owner}/${repo}.`,
            data: { issues },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_search_issues",
      {
        displayName: "Search GitHub issues",
        description: "Search issues + PRs across the account.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            q: { type: "string" },
            sort: { type: "string" },
            order: { type: "string" },
            perPage: { type: "number" },
          },
          required: ["q"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          q?: string;
          sort?: "comments" | "reactions" | "interactions" | "created" | "updated";
          order?: "asc" | "desc";
          perPage?: number;
        };
        if (!p.q) return { error: "[EINVALID_INPUT] `q` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_search_issues", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const result = await r.resolved.client.search.issuesAndPullRequests({
            q: p.q,
            sort: p.sort,
            order: p.order ?? "desc",
            per_page: clampPerPage(p.perPage),
          });
          // Filter to allowedRepos if set
          let items = result.data.items;
          const allow = r.resolved.account.allowedRepos;
          if (allow && allow.length > 0) {
            const set = new Set(allow.map((a) => a.toLowerCase()));
            items = items.filter((it) => {
              const url = it.repository_url ?? "";
              const match = url.match(/repos\/([^/]+\/[^/]+)$/);
              return match ? set.has(match[1].toLowerCase()) : false;
            });
          }
          await track(ctx, runCtx, "github_search_issues", r.resolved.accountKey, {
            count: items.length,
          });
          return {
            content: `Found ${items.length} match(es).`,
            data: {
              items: items.map((i) => ({
                id: i.id,
                number: i.number,
                title: i.title,
                state: i.state,
                labels: i.labels.map((l) =>
                  typeof l === "string" ? l : l.name,
                ),
                url: i.html_url,
                isPullRequest: !!i.pull_request,
              })),
              totalCount: result.data.total_count,
            },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_list_comments",
      {
        displayName: "List GitHub issue comments",
        description: "List comments on an issue.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            issueNumber: { type: "number" },
            since: { type: "string" },
            perPage: { type: "number" },
          },
          required: ["issueNumber"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          issueNumber?: number;
          since?: string;
          perPage?: number;
        };
        if (!p.issueNumber) return { error: "[EINVALID_INPUT] `issueNumber` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_list_comments", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.issues.listComments({
            owner,
            repo,
            issue_number: p.issueNumber,
            since: p.since,
            per_page: clampPerPage(p.perPage),
          });
          await track(ctx, runCtx, "github_list_comments", r.resolved.accountKey, {
            owner,
            repo,
            issueNumber: p.issueNumber,
            count: result.data.length,
          });
          return {
            content: `Listed ${result.data.length} comment(s) on ${owner}/${repo}#${p.issueNumber}.`,
            data: {
              comments: result.data.map((c) => ({
                id: c.id,
                author: c.user?.login ?? null,
                createdAt: c.created_at,
                body: c.body ?? "",
              })),
            },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_list_pulls",
      {
        displayName: "List GitHub pull requests",
        description: "List PRs on a repo.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            state: { type: "string" },
            head: { type: "string" },
            base: { type: "string" },
            sort: { type: "string" },
            perPage: { type: "number" },
            page: { type: "number" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          state?: "open" | "closed" | "all";
          head?: string;
          base?: string;
          sort?: "created" | "updated" | "popularity" | "long-running";
          perPage?: number;
          page?: number;
        };
        const r = await resolveOrError(ctx, runCtx, "github_list_pulls", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.pulls.list({
            owner,
            repo,
            state: p.state ?? "open",
            head: p.head,
            base: p.base,
            sort: p.sort ?? "created",
            per_page: clampPerPage(p.perPage),
            page: p.page,
          });
          await track(ctx, runCtx, "github_list_pulls", r.resolved.accountKey, {
            owner,
            repo,
            count: result.data.length,
          });
          return {
            content: `Listed ${result.data.length} PR(s) on ${owner}/${repo}.`,
            data: { pulls: result.data.map(slimPull) },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_get_pull",
      {
        displayName: "Get GitHub pull request",
        description: "Retrieve one PR with merge state.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            pullNumber: { type: "number" },
          },
          required: ["pullNumber"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          pullNumber?: number;
        };
        if (!p.pullNumber) return { error: "[EINVALID_INPUT] `pullNumber` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_get_pull", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.pulls.get({
            owner,
            repo,
            pull_number: p.pullNumber,
          });
          await track(ctx, runCtx, "github_get_pull", r.resolved.accountKey, {
            owner,
            repo,
            pullNumber: p.pullNumber,
          });
          return {
            content: `Retrieved ${owner}/${repo}#${p.pullNumber} (${result.data.state}).`,
            data: slimPull(result.data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_get_release",
      {
        displayName: "Get GitHub release",
        description: "Retrieve a release by ID, tag, or latest.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            releaseId: { type: "number" },
            tag: { type: "string" },
            latest: { type: "boolean" },
          },
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          releaseId?: number;
          tag?: string;
          latest?: boolean;
        };
        const provided = [p.releaseId !== undefined, p.tag !== undefined, !!p.latest].filter(Boolean).length;
        if (provided !== 1) {
          return {
            error:
              "[EINVALID_INPUT] Provide exactly one of `releaseId`, `tag`, or `latest: true`.",
          };
        }

        const r = await resolveOrError(ctx, runCtx, "github_get_release", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          let data;
          if (p.latest) {
            const result = await r.resolved.client.repos.getLatestRelease({ owner, repo });
            data = result.data;
          } else if (p.releaseId !== undefined) {
            const result = await r.resolved.client.repos.getRelease({
              owner,
              repo,
              release_id: p.releaseId,
            });
            data = result.data;
          } else {
            const result = await r.resolved.client.repos.getReleaseByTag({
              owner,
              repo,
              tag: p.tag!,
            });
            data = result.data;
          }
          await track(ctx, runCtx, "github_get_release", r.resolved.accountKey, {
            owner,
            repo,
          });
          return {
            content: `Retrieved release ${data.tag_name} on ${owner}/${repo}.`,
            data: slimRelease(data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    // ─── Mutations (gated) ───────────────────────────────────────────────

    ctx.tools.register(
      "github_create_issue",
      {
        displayName: "Create GitHub issue",
        description: "Create an issue. Idempotent on idempotencyKey.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            assignees: { type: "array", items: { type: "string" } },
            milestone: { type: "number" },
            idempotencyKey: { type: "string" },
          },
          required: ["title"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("github_create_issue");
        if (gate) return gate;

        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          title?: string;
          body?: string;
          labels?: string[];
          assignees?: string[];
          milestone?: number;
          idempotencyKey?: string;
        };
        if (!p.title) return { error: "[EINVALID_INPUT] `title` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_create_issue", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          let allLabels = [...(p.labels ?? [])];

          // Idempotency
          if (p.idempotencyKey) {
            const idemLabel = idempotencyLabel(p.idempotencyKey);
            // Search for an existing open issue with this label
            const search = await r.resolved.client.search.issuesAndPullRequests({
              q: `repo:${owner}/${repo} is:issue is:open label:"${idemLabel}"`,
              per_page: 1,
            });
            const hit = search.data.items[0];
            if (hit) {
              await track(ctx, runCtx, "github_create_issue", r.resolved.accountKey, {
                deduped: true,
                issueNumber: hit.number,
              });
              return {
                content: `Idempotent: returning existing #${hit.number} on ${owner}/${repo}.`,
                data: { number: hit.number, url: hit.html_url, deduped: true },
              };
            }
            // Ensure the label exists (create if missing). 422 = already exists; ignore.
            try {
              await r.resolved.client.issues.createLabel({
                owner,
                repo,
                name: idemLabel,
                color: "ededed",
                description: "Auto-created by paperclip github-tools for idempotent issue creation.",
              });
            } catch (err) {
              if (!(err instanceof Error) || !err.message.match(/already_exists|already exists/i)) {
                // Non-idempotent failure; rethrow
                if ((err as { status?: number }).status !== 422) throw err;
              }
            }
            allLabels.push(idemLabel);
          }

          const result = await r.resolved.client.issues.create({
            owner,
            repo,
            title: p.title,
            body: p.body,
            labels: allLabels,
            assignees: p.assignees,
            milestone: p.milestone,
          });
          await track(ctx, runCtx, "github_create_issue", r.resolved.accountKey, {
            owner,
            repo,
            issueNumber: result.data.number,
            deduped: false,
          });
          return {
            content: `Created ${owner}/${repo}#${result.data.number}.`,
            data: slimIssue(result.data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_add_comment",
      {
        displayName: "Add GitHub issue comment",
        description: "Comment on an issue or PR.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            issueNumber: { type: "number" },
            body: { type: "string" },
          },
          required: ["issueNumber", "body"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("github_add_comment");
        if (gate) return gate;

        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          issueNumber?: number;
          body?: string;
        };
        if (!p.issueNumber) return { error: "[EINVALID_INPUT] `issueNumber` is required" };
        if (!p.body) return { error: "[EINVALID_INPUT] `body` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_add_comment", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.issues.createComment({
            owner,
            repo,
            issue_number: p.issueNumber,
            body: p.body,
          });
          await track(ctx, runCtx, "github_add_comment", r.resolved.accountKey, {
            owner,
            repo,
            issueNumber: p.issueNumber,
          });
          return {
            content: `Commented on ${owner}/${repo}#${p.issueNumber}.`,
            data: { id: result.data.id, url: result.data.html_url },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_close_issue",
      {
        displayName: "Close GitHub issue",
        description: "Close an issue.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            issueNumber: { type: "number" },
            stateReason: { type: "string", enum: ["completed", "not_planned"] },
          },
          required: ["issueNumber"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("github_close_issue");
        if (gate) return gate;

        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          issueNumber?: number;
          stateReason?: "completed" | "not_planned";
        };
        if (!p.issueNumber) return { error: "[EINVALID_INPUT] `issueNumber` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_close_issue", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.issues.update({
            owner,
            repo,
            issue_number: p.issueNumber,
            state: "closed",
            state_reason: p.stateReason ?? "completed",
          });
          await track(ctx, runCtx, "github_close_issue", r.resolved.accountKey, {
            owner,
            repo,
            issueNumber: p.issueNumber,
            reason: p.stateReason ?? "completed",
          });
          return {
            content: `Closed ${owner}/${repo}#${p.issueNumber}.`,
            data: slimIssue(result.data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_create_pull",
      {
        displayName: "Create GitHub pull request",
        description: "Create a PR. Branches must already be pushed.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            title: { type: "string" },
            head: { type: "string" },
            base: { type: "string" },
            body: { type: "string" },
            draft: { type: "boolean", default: false },
          },
          required: ["title", "head", "base"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("github_create_pull");
        if (gate) return gate;

        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          title?: string;
          head?: string;
          base?: string;
          body?: string;
          draft?: boolean;
        };
        if (!p.title) return { error: "[EINVALID_INPUT] `title` is required" };
        if (!p.head) return { error: "[EINVALID_INPUT] `head` is required" };
        if (!p.base) return { error: "[EINVALID_INPUT] `base` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_create_pull", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.pulls.create({
            owner,
            repo,
            title: p.title,
            head: p.head,
            base: p.base,
            body: p.body,
            draft: !!p.draft,
          });
          await track(ctx, runCtx, "github_create_pull", r.resolved.accountKey, {
            owner,
            repo,
            pullNumber: result.data.number,
          });
          return {
            content: `Opened PR ${owner}/${repo}#${result.data.number}.`,
            data: slimPull(result.data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_merge_pull",
      {
        displayName: "Merge GitHub pull request",
        description: "Merge a PR. Method defaults to 'squash'.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            pullNumber: { type: "number" },
            method: { type: "string", enum: ["merge", "squash", "rebase"], default: "squash" },
            commitTitle: { type: "string" },
            commitMessage: { type: "string" },
            sha: { type: "string" },
          },
          required: ["pullNumber"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("github_merge_pull");
        if (gate) return gate;

        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          pullNumber?: number;
          method?: "merge" | "squash" | "rebase";
          commitTitle?: string;
          commitMessage?: string;
          sha?: string;
        };
        if (!p.pullNumber) return { error: "[EINVALID_INPUT] `pullNumber` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_merge_pull", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.pulls.merge({
            owner,
            repo,
            pull_number: p.pullNumber,
            merge_method: p.method ?? "squash",
            commit_title: p.commitTitle,
            commit_message: p.commitMessage,
            sha: p.sha,
          });
          await track(ctx, runCtx, "github_merge_pull", r.resolved.accountKey, {
            owner,
            repo,
            pullNumber: p.pullNumber,
            method: p.method ?? "squash",
          });
          return {
            content: `Merged ${owner}/${repo}#${p.pullNumber} via ${p.method ?? "squash"}.`,
            data: { merged: !!result.data.merged, sha: result.data.sha },
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );

    ctx.tools.register(
      "github_create_release",
      {
        displayName: "Create GitHub release",
        description: "Create a release.",
        parametersSchema: {
          type: "object",
          properties: {
            account: { type: "string" },
            owner: { type: "string" },
            repo: { type: "string" },
            tagName: { type: "string" },
            name: { type: "string" },
            body: { type: "string" },
            draft: { type: "boolean", default: false },
            prerelease: { type: "boolean", default: false },
            targetCommitish: { type: "string" },
          },
          required: ["tagName"],
        },
      },
      async (params, runCtx): Promise<ToolResult> => {
        const gate = gateMutation("github_create_release");
        if (gate) return gate;

        const p = params as {
          account?: string;
          owner?: string;
          repo?: string;
          tagName?: string;
          name?: string;
          body?: string;
          draft?: boolean;
          prerelease?: boolean;
          targetCommitish?: string;
        };
        if (!p.tagName) return { error: "[EINVALID_INPUT] `tagName` is required" };

        const r = await resolveOrError(ctx, runCtx, "github_create_release", p.account);
        if (!r.ok) return { error: r.error };
        try {
          const { owner, repo } = resolveRepo(r.resolved, p.owner, p.repo);
          const result = await r.resolved.client.repos.createRelease({
            owner,
            repo,
            tag_name: p.tagName,
            name: p.name,
            body: p.body,
            draft: !!p.draft,
            prerelease: !!p.prerelease,
            target_commitish: p.targetCommitish,
          });
          await track(ctx, runCtx, "github_create_release", r.resolved.accountKey, {
            owner,
            repo,
            tag: p.tagName,
          });
          return {
            content: `Created release ${p.tagName} on ${owner}/${repo}.`,
            data: slimRelease(result.data),
          };
        } catch (err) {
          return { error: wrapGithubError(err) };
        }
      },
    );
  },

  async onHealth() {
    return { status: "ok", message: "github-tools ready" };
  },
});

function clampPerPage(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(100, Math.floor(value)));
}

function slimIssue(i: Record<string, unknown>): Record<string, unknown> {
  return {
    id: i.id,
    number: i.number,
    title: i.title,
    state: i.state,
    stateReason: i.state_reason ?? null,
    labels: ((i.labels as Array<string | { name?: string }>) ?? []).map((l) =>
      typeof l === "string" ? l : l.name,
    ),
    assignees: ((i.assignees as Array<{ login?: string }>) ?? []).map((a) => a.login),
    author: (i.user as { login?: string } | null)?.login ?? null,
    url: i.html_url,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    closedAt: i.closed_at,
    body: i.body ?? null,
  };
}

function slimPull(p: Record<string, unknown>): Record<string, unknown> {
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft,
    merged: p.merged,
    mergeable: p.mergeable,
    head: (p.head as { ref?: string; sha?: string } | undefined)?.ref ?? null,
    headSha: (p.head as { sha?: string } | undefined)?.sha ?? null,
    base: (p.base as { ref?: string } | undefined)?.ref ?? null,
    author: (p.user as { login?: string } | null)?.login ?? null,
    url: p.html_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at,
  };
}

function slimRelease(r: Record<string, unknown>): Record<string, unknown> {
  return {
    id: r.id,
    tagName: r.tag_name,
    name: r.name,
    body: r.body,
    draft: r.draft,
    prerelease: r.prerelease,
    createdAt: r.created_at,
    publishedAt: r.published_at,
    url: r.html_url,
  };
}

export default plugin;
runWorker(plugin, import.meta.url);

void isCompanyAllowed;
