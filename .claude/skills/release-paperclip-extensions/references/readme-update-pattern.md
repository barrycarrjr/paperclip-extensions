# README update pattern (manual-edit fallback)

Use this only when the standard `node scripts/bump-all-patch.mjs` path doesn't fit — typically because scope is narrower than "all plugins" or because one or more plugins have custom changelog strings instead of the default note.

## What to add

A new bullet at the top of the plugin's `## Recent changes` section:

```markdown
- **v<new-version>** — <changelog text>
```

Default `<changelog text>`:

> Patch bump alongside the cross-plugin release. No functional changes; ensures the Plugin Manager surfaces the update so installed copies stay current with the registry.

For plugins shipping a real fix in this release, write a one-sentence description of what changed (what the operator would care about, not implementation detail). Example:

> Patch bump. Includes the post-v0.3.0 voice-id qualification fix — bare OpenAI voice IDs (`alloy`/`echo`/`shimmer`/`onyx`/etc.) sent by the Assistant Builder wizard are now auto-qualified to `openai:<id>` server-side before they reach Vapi, fixing an `[EVAPI_400] voice.provider must be one of …` rejection.

## Where to put it

### Case A — README already has a `## Recent changes` section

Prepend the new bullet so the newest version is at the top. The existing entries stay untouched.

```markdown
## Recent changes

- **v0.3.2** — <new entry here>
- **v0.3.1** — Previous patch bump…
- **v0.3.0** — Major feature release…
```

### Case B — README has no `## Recent changes` section yet

Insert a new section above the first existing `## ` heading. Don't put it above the H1 title or above any opening paragraphs / blockquotes (the Setup-tab pointer goes between the intro paragraph and Recent changes, not after).

Anchor structure (target):

```markdown
# Plugin Title

Intro paragraph.

> **Install + setup walkthrough** lives in-app: …  ← if this exists, leave it above Recent changes

## Recent changes              ← NEW SECTION INSERTED HERE

- **v<new-version>** — <changelog text>

## <whatever-was-the-first-section-before>
```

The `bump-all-patch.mjs` script handles this insertion logic for you when run unmodified — see `scripts/bump-all-patch.mjs` for the algorithm.

## Verification before commit

After editing all in-scope READMEs, scan with:

```bash
git -C ~/paperclip-extensions diff plugins/*/README.md | grep "^+## Recent changes\|^+- \*\*v"
```

Expected output: one `## Recent changes` line per plugin where the section was just created, plus one `- **v<new>** — …` bullet per plugin that got bumped. If a plugin in scope is missing from this output, the README didn't get updated — fix it before committing.
