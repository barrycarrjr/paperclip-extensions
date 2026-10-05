---
name: release-paperclip-extensions
description: Cut a new release of `paperclip-extensions` — patch-bumps every plugin (or a specified subset), updates each plugin's README `## Recent changes` log, commits with the right explicit-paths pattern, tags the next monotonic `v<n>`, pushes, and watches the GitHub Actions release workflow until it lands. Use this whenever the operator asks to "release the extensions", "ship plugin updates", "cut a new plugins release", "publish a paperclip-extensions release", "bump all plugins and release", "make a new plugin release", or anything that boils down to shipping a fresh build of the plugins so already-installed copies in Paperclip's Plugin Manager surface as "update available". Use it even when the operator phrases it casually ("can you do a new release", "push out the plugins again", "the install isn't seeing my fix because the version didn't bump") — the through-line is "I want a new `v<n>` tag with bumped per-plugin versions". Don't use it for: pure docs-only commits without a release; bumping a single plugin during active feature development (use a normal commit + the existing `dev-redeploy.sh` instead); or for cutting a release without any version bumps (the Plugin Manager check is per-plugin `version` — repo-level tags alone don't trigger update prompts).
---

# Release paperclip-extensions

This skill automates the cross-plugin release flow for the `paperclip-extensions` repo. The flow exists because Paperclip's Plugin Manager checks per-plugin `version` against the installed copy — repo-level monotonic tags (`v0.15.0`, `v0.16.0`, …) don't trigger update prompts on their own, so every plugin has to be bumped for already-installed copies to see the new build.

## When this triggers

Operator says any of:
- "release the extensions" / "release paperclip-extensions"
- "ship a new plugin release" / "ship plugin updates"
- "cut a new release" (in a paperclip-extensions context)
- "bump all plugins and release"
- "the plugins aren't showing as updatable" → fix is to bump versions and release
- "do another release on the extensions"

If the request is more specific ("only bump phone-tools", "minor instead of patch", "phone-tools changelog should mention X"), ask a clarifying question only if you can't infer the answer from the request, then proceed.

## Before doing anything

1. **Locate the repo.** Default location is `~/paperclip-extensions` (on Barry's Windows box this resolves to `C:\Users\barry\paperclip-extensions`). If the operator works from a different checkout, ask.
2. **Check working tree state.** `git -C ~/paperclip-extensions status --short`. If there are uncommitted changes that are NOT part of the release intent (e.g. unrelated WIP, another agent's edits), surface them and ask the operator before continuing — this skill commits with explicit paths but it shouldn't be run on top of a dirty tree if the operator hasn't sanctioned it.
3. **Check the latest tag.** `git -C ~/paperclip-extensions tag -l 'v*' | sort -V | tail -1`. The next monotonic tag is the minor + 1 (e.g. `v0.15.0` → `v0.16.0`). Repo-level monotonic, NOT per-plugin.
4. **Confirm GitHub auth works.** `gh auth status` should be green; the watch step needs `gh run watch`.

## Default scope

- All plugins under `paperclip-extensions/plugins/` (currently 15 of them; varies as new plugins land).
- Patch-level version bump (`X.Y.Z` → `X.Y.Z+1`).
- Default note for each plugin's README `## Recent changes` entry: "Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry."
- Specific plugins that have real changes shipping in this release should get a custom changelog line — e.g. "phone-tools 0.3.1 includes the post-v0.3.0 voice-id qualification fix". Either ask the operator or look at recent unreleased commits on that plugin to draft the line.

## Procedure

### 1. Run the bump script

The repo ships a one-shot bump script at `paperclip-extensions/scripts/bump-all-patch.mjs`. Use it when scope is "all plugins, patch, default note":

```bash
cd ~/paperclip-extensions && node scripts/bump-all-patch.mjs
```

It edits `package.json` + `src/manifest.ts` for every plugin and prepends an entry to each README's `## Recent changes` section (creating that section if it doesn't exist).

The script is **not idempotent** — re-running it bumps patch by 1 again. Run once per release.

If scope is narrower or has custom changelog strings, edit the file set by hand instead of running the script. For each in-scope plugin:
- Edit `plugins/<plugin>/package.json` `"version"`.
- Edit `plugins/<plugin>/src/manifest.ts` `const PLUGIN_VERSION = "..."` to match.
- Prepend a new bullet to the `## Recent changes` section in `plugins/<plugin>/README.md`. If no such section exists, insert it above the first existing `## ` heading — see `references/readme-update-pattern.md` for the exact text and anchor logic.

Either path: re-read `git status --short` after to verify the change set matches the intended scope.

### 2. Commit

Use Barry's explicit-paths pattern so the commit doesn't sweep in unrelated working-tree changes. The script's output may have left the bump driver in `scripts/bump-all-patch.mjs` — include it explicitly if it's new or changed; otherwise leave `scripts/` out:

```bash
cd ~/paperclip-extensions && git add plugins scripts/bump-all-patch.mjs 2>/dev/null
# or, if bump-all-patch.mjs is unchanged in this run:
# git -C ~/paperclip-extensions add plugins
git -C ~/paperclip-extensions commit -m "$(cat <<'EOF'
chore(plugins): patch-bump all <N> plugins for v<next> release

Bumps every plugin's package.json + manifest PLUGIN_VERSION by one patch
level so the Plugin Manager surfaces them all as 'update available' for
already-installed copies. Also prepends a Recent-changes entry to each
README per the lifecycle rule (AGENTS.md §4.2).

<plugin-with-real-fix>: <human-readable description of the real change>.
The other <N-1> are alignment bumps with no functional changes.
EOF
)"
```

Replace `<N>`, `<next>`, and the named-fix line with the actual values for this release. If no plugin has a real fix in scope, drop that paragraph.

### 3. Push, tag, push tag

```bash
git -C ~/paperclip-extensions push origin master
git -C ~/paperclip-extensions tag v<next>     # e.g. v0.16.0
git -C ~/paperclip-extensions push origin v<next>
```

### 4. Watch the release workflow

The tag push fires `.github/workflows/release.yml`. Pick up the run ID and watch:

```bash
RUN_ID=$(cd ~/paperclip-extensions && gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
cd ~/paperclip-extensions && gh run watch "$RUN_ID" --exit-status
gh run view "$RUN_ID" --json status,conclusion,url
```

Run `gh run watch` in the background (`run_in_background: true`) so other work can continue. Use a timeout of ~15 minutes — the workflow normally finishes in under 90 seconds.

### 5. Verify and report

After the workflow concludes:

```bash
gh release view v<next> --json assets --jq '.assets[] | "\(.name) (\(.size) bytes)"'
```

Expected output: one `<plugin-id>-<new-version>.pcplugin` per in-scope plugin, plus `index.json`. If a plugin is missing or sized 0, surface it and stop — something failed in the build step.

Report back to the operator with:
- A small table: plugin name | old version | new version | new `.pcplugin` filename
- Release URL (`https://github.com/barrycarrjr/paperclip-extensions/releases/tag/v<next>`)
- The fact that the operator's installed copies should now show "update available" in the Plugin Manager — they may need to refresh the Plugins page

## Constraints — never break these

- **Never push `--force`.** If history needs rewriting, stop and ask.
- **Never `git commit --amend`.** New commits only.
- **Never skip hooks.** No `--no-verify`, no `--no-gpg-sign`. If a hook fails, debug it and ship the next attempt.
- **Repo-level monotonic tags only.** `v0.16.0`, `v0.17.0`, … Not `phone-tools-v0.3.1` or any per-plugin tag — the workflow only matches `v*` and the convention is monotonic.
- **No local packing.** `dist-pcplugins/` is gitignored. The CI workflow packs and uploads. Don't `pnpm pack:all` and call it a release.
- **Don't include unrelated working-tree changes** in the commit. Use explicit-paths `git add plugins ...`, not `git add -A`.
- **Don't post resolved secret values** anywhere — file paths, comments, logs, commit messages all OK; values never.

## Cross-references

- Repo-level guidance: `paperclip-extensions/AGENTS.md` — lifecycle rules including the README-maintenance rule (§4.2) and the release flow (§4.3).
- Memory: `feedback_plugin_readme_maintenance.md` — the rule's origin and rationale.
- Memory: `reference_paperclip_extensions_release.md` — the original release-flow notes (this skill is the executable form).
- Memory: `feedback_no_branches_work_on_master.md` — work happens directly on master.

## Edge cases and gotchas

- **A plugin's real fix didn't make it into the previous release.** Common case (e.g. phone-tools voice-id qualification fix shipped after v0.3.0 was released, surfaced via this release as v0.3.1). Capture it in that plugin's specific changelog line — don't lump it into the alignment-bump default note.
- **The Plugin Manager doesn't surface updates after the release lands.** Most often the plugin's `version` didn't actually change because `bump-all-patch.mjs` was never run or only ran for a subset. Re-check `plugins/<plugin>/package.json` `"version"` matches the new release tag's archive name. If it does and Paperclip still doesn't show the update, tell the operator to refresh `/instance/settings/plugins/<plugin>` — sometimes the registry-poll cache is stale.
- **A plugin's `dist/` build broke.** CI fails on `pnpm run build:all`. The workflow log shows which plugin. Fix on master, re-tag with a fresh monotonic `v<next+1>` (don't reuse the failing tag — repo-level monotonic).
- **The operator only wants ONE plugin bumped.** Bump only that plugin, but the release workflow re-packs every plugin into the release at whatever versions are in their `package.json` at the tagged commit. So unaffected plugins ship as `<id>-<unchanged-version>.pcplugin` again — that's fine, they just won't surface as updatable.
- **A new plugin landed since the last release.** It'll be packed automatically by `pnpm run build:all` at its current version. No special handling needed unless the operator wants to bump it as part of this release.
- **Auto-commit hook fired before this skill staged.** Check `git log --oneline origin/master..HEAD` first. If there's already a "chore(plugins): bump all" commit you didn't make, don't bump on top — verify it has what you need and skip to step 3.

## Default invocation

If the operator says any of the trigger phrases without specifics, default to:
- All plugins, patch bump, default note.
- One plugin (whichever the operator most recently mentioned working on, if applicable) gets a real changelog line — verify against recent commits on that plugin.
- Tag = latest `v*` tag's minor + 1.
- Then proceed without further prompts. The operator can interrupt mid-flow if they want to change scope.
