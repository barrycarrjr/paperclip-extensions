# Vendored Paperclip SDK

`plugin-sdk.tgz` and `shared.tgz` are Paperclip's own `@paperclipai/plugin-sdk` and
`@paperclipai/shared`, packed from a Paperclip checkout. The plugins that need them point at
them through `pnpm.overrides` in their `package.json`.

Do not replace these files by hand. Repack them with:

```
pnpm vendor:sdk --paperclip <path to a Paperclip checkout>
```

That builds and packs both packages, stamps each with a `-vendor.<fingerprint>` version taken
from its contents, updates the lock file of every plugin that uses them, and refreshes each
plugin's installed copy. Commit the two tarballs and those lock files together.

Why the tooling matters: pnpm keeps a plugin's installed copy of a `file:` tarball after the
tarball is repacked, even when the version and the lock file change. Each plugin's build
therefore runs `scripts/check-vendored-sdk.mjs` first, which compares the installed copy with
the tarball and, when they differ, removes that plugin's `node_modules` and installs again
from its lock file.
