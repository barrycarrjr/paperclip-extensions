import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "github-tools";
const PLUGIN_VERSION = "0.1.0";

const accountItemSchema = {
  type: "object",
  required: ["key", "tokenRef", "allowedCompanies"],
  propertyOrder: [
    "key",
    "displayName",
    "tokenRef",
    "defaultOwner",
    "defaultRepo",
    "allowedRepos",
    "allowedCompanies",
  ],
  properties: {
    key: {
      type: "string",
      title: "Identifier",
      description:
        "Short stable ID agents pass when calling GitHub tools (e.g. 'main', 'org'). Lowercase, no spaces. Once skills or heartbeats reference it, don't change it. Must be unique across accounts.",
    },
    displayName: {
      type: "string",
      title: "Display name",
      description:
        "Human-readable label shown in this settings form (e.g. 'Personal GitHub', 'Acme Org'). Free-form.",
    },
    tokenRef: {
      type: "string",
      format: "secret-ref",
      title: "Personal Access Token",
      description:
        "Paste the UUID of the secret holding this account's GitHub Personal Access Token. Create the secret first on the company's Secrets page; never paste the raw token here. Fine-grained PATs preferred — set the resource owner, scope to specific repos, and grant: Issues (read+write), Pull requests (read+write), Contents (read), Metadata (read). Classic PATs with the `repo` scope also work but are broader than necessary. Get one at github.com/settings/tokens.",
    },
    defaultOwner: {
      type: "string",
      title: "Default owner (optional)",
      description:
        "GitHub user/org used when an agent omits `owner` in a tool call. Useful when this account only manages one organisation's repos.",
    },
    defaultRepo: {
      type: "string",
      title: "Default repo (optional)",
      description:
        "Repo name (without owner) used when an agent omits `repo`. Pair with `defaultOwner` so a one-repo account doesn't have to specify either.",
    },
    allowedRepos: {
      type: "array",
      items: { type: "string" },
      title: "Allowed repos (owner/repo)",
      description:
        "If non-empty, every tool call must address a repo in this list — `<owner>/<repo>` exact match (case-insensitive). Empty/missing = unrestricted within the PAT's reachable repos. Useful when one PAT can see many repos but only one or two should be visible to agents.",
    },
    allowedCompanies: {
      type: "array",
      items: { type: "string", format: "company-id" },
      title: "Allowed companies",
      description:
        "Companies whose agents may call GitHub tools against this account. Tick 'Portfolio-wide' to allow every company; otherwise tick the specific companies. Empty = unusable. This is independent of `allowedRepos` — both must pass for a tool call to succeed.",
    },
  },
} as const;

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "GitHub Tools",
  description:
    "GitHub repository operations — issues, comments, repos, pull requests, releases, search. Multi-account, per-account allowedCompanies + allowedRepos, mutations gated.",
  author: "Barry Carr & Tony Allard",
  categories: ["automation", "connector"],
  capabilities: [
    "agent.tools.register",
    "instance.settings.register",
    "secrets.read-ref",
    "http.outbound",
    "telemetry.track",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    propertyOrder: ["allowMutations", "defaultAccount", "accounts"],
    properties: {
      allowMutations: {
        type: "boolean",
        title: "Allow create/update/close/release/PR write",
        description:
          "Master switch for github_create_issue, _add_comment, _close_issue, _create_release, _create_pull, _merge_pull. Set false (default) to keep the plugin in read-only mode — mutation tools return [EDISABLED] without hitting GitHub. Read tools are unaffected.",
        default: false,
      },
      defaultAccount: {
        type: "string",
        title: "Default account key",
        description:
          "Identifier of the account used when an agent omits `account`. Strict: if the calling company isn't in the default account's Allowed companies, the call fails with [ECOMPANY_NOT_ALLOWED] (no automatic fallback). Leave blank to require an explicit `account` on every call.",
      },
      accounts: {
        type: "array",
        title: "GitHub accounts",
        description:
          "One entry per GitHub PAT this plugin can use. Most operators have one personal PAT; you may add a separate one for an org if you don't want to mix scopes.",
        items: accountItemSchema,
      },
    },
  },
  tools: [
    {
      name: "github_list_repos",
      displayName: "List GitHub repos",
      description:
        "List repos for an owner (user or org). Filtered to allowedRepos if set on the account.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          owner: {
            type: "string",
            description: "Org or user. Optional — falls back to defaultOwner.",
          },
          type: {
            type: "string",
            enum: ["all", "public", "private", "owner", "member"],
            default: "all",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "pushed", "full_name"],
            default: "updated",
          },
          perPage: { type: "number", description: "Page size, default 30, max 100." },
        },
      },
    },
    {
      name: "github_get_issue",
      displayName: "Get GitHub issue",
      description: "Retrieve a single issue.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Account identifier. Optional." },
          owner: { type: "string", description: "Repo owner. Optional — falls back to defaultOwner." },
          repo: { type: "string", description: "Repo name. Optional — falls back to defaultRepo." },
          issueNumber: { type: "number" },
        },
        required: ["issueNumber"],
      },
    },
    {
      name: "github_list_issues",
      displayName: "List GitHub issues",
      description: "List issues with filters (state / labels / assignee / since).",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Comma-list of label names; ALL must match.",
          },
          assignee: { type: "string", description: "Username, '*' for any, 'none' for none." },
          since: { type: "string", description: "ISO 8601 lower bound on updated_at." },
          sort: { type: "string", enum: ["created", "updated", "comments"], default: "created" },
          direction: { type: "string", enum: ["asc", "desc"], default: "desc" },
          perPage: { type: "number" },
          page: { type: "number" },
        },
      },
    },
    {
      name: "github_create_issue",
      displayName: "Create GitHub issue",
      description:
        "Create an issue. Idempotent on `idempotencyKey` (auto-creates and applies a `paperclip:idempotency-<key>` label so subsequent calls dedupe). Mutation, gated.",
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
          idempotencyKey: {
            type: "string",
            description:
              "Optional dedup key. The plugin auto-creates the label `paperclip:idempotency-<key>` if missing, then searches for an open issue with that label before creating a new one.",
          },
        },
        required: ["title"],
      },
    },
    {
      name: "github_add_comment",
      displayName: "Add GitHub issue comment",
      description: "Comment on an issue or pull request. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "number", description: "Works for issues OR PRs (PRs are issues)." },
          body: { type: "string" },
        },
        required: ["issueNumber", "body"],
      },
    },
    {
      name: "github_list_comments",
      displayName: "List GitHub issue comments",
      description: "List comments on an issue.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "number" },
          since: { type: "string", description: "ISO 8601 lower bound." },
          perPage: { type: "number" },
        },
        required: ["issueNumber"],
      },
    },
    {
      name: "github_close_issue",
      displayName: "Close GitHub issue",
      description: "Close an issue. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          issueNumber: { type: "number" },
          stateReason: {
            type: "string",
            enum: ["completed", "not_planned"],
            default: "completed",
          },
        },
        required: ["issueNumber"],
      },
    },
    {
      name: "github_search_issues",
      displayName: "Search GitHub issues",
      description:
        "Search issues + PRs across the account using GitHub search syntax (e.g. 'repo:owner/name is:open label:bug').",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          q: {
            type: "string",
            description: "GitHub search query.",
          },
          sort: {
            type: "string",
            enum: ["comments", "reactions", "interactions", "created", "updated"],
          },
          order: { type: "string", enum: ["asc", "desc"], default: "desc" },
          perPage: { type: "number" },
        },
        required: ["q"],
      },
    },
    {
      name: "github_list_pulls",
      displayName: "List GitHub pull requests",
      description: "List pull requests on a repo.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          state: { type: "string", enum: ["open", "closed", "all"], default: "open" },
          head: { type: "string", description: "Filter by head branch (e.g. 'username:branch')." },
          base: { type: "string", description: "Filter by base branch (e.g. 'main')." },
          sort: {
            type: "string",
            enum: ["created", "updated", "popularity", "long-running"],
            default: "created",
          },
          perPage: { type: "number" },
          page: { type: "number" },
        },
      },
    },
    {
      name: "github_get_pull",
      displayName: "Get GitHub pull request",
      description: "Retrieve a single pull request, including merge state.",
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
    {
      name: "github_create_pull",
      displayName: "Create GitHub pull request",
      description:
        "Create a pull request. Mutation, gated. The plugin doesn't push branches — push first via git, then call this.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          head: {
            type: "string",
            description:
              "Source branch. Format `branch` for same-repo, `user:branch` for cross-repo PRs.",
          },
          base: { type: "string", description: "Target branch (e.g. 'main')." },
          body: { type: "string" },
          draft: { type: "boolean", default: false },
        },
        required: ["title", "head", "base"],
      },
    },
    {
      name: "github_merge_pull",
      displayName: "Merge GitHub pull request",
      description:
        "Merge a pull request. Mutation, gated. Default method 'squash' for clean history. PR must be mergeable per branch protection rules.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          pullNumber: { type: "number" },
          method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            default: "squash",
          },
          commitTitle: { type: "string", description: "Override the merge commit title." },
          commitMessage: { type: "string", description: "Override the merge commit body." },
          sha: {
            type: "string",
            description:
              "Optional SHA the head must match. Pass to defend against a race where someone pushed after you reviewed.",
          },
        },
        required: ["pullNumber"],
      },
    },
    {
      name: "github_get_release",
      displayName: "Get GitHub release",
      description:
        "Retrieve a release by ID, tag, or 'latest: true'. Provide exactly one of releaseId / tag / latest.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          releaseId: { type: "number" },
          tag: { type: "string", description: "Tag name (e.g. 'v1.2.3')." },
          latest: { type: "boolean", description: "Set true to fetch the latest release." },
        },
      },
    },
    {
      name: "github_create_release",
      displayName: "Create GitHub release",
      description: "Create a release. Mutation, gated.",
      parametersSchema: {
        type: "object",
        properties: {
          account: { type: "string" },
          owner: { type: "string" },
          repo: { type: "string" },
          tagName: { type: "string", description: "e.g. 'v1.2.3'." },
          name: { type: "string", description: "Release title." },
          body: { type: "string", description: "Release notes (markdown)." },
          draft: { type: "boolean", default: false },
          prerelease: { type: "boolean", default: false },
          targetCommitish: {
            type: "string",
            description:
              "SHA, branch, or tag the release points at. Defaults to the repo's default branch.",
          },
        },
        required: ["tagName"],
      },
    },
  ],
};

export default manifest;
