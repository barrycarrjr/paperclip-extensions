import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFolder, findDriveForDesktop } from "./localFolder.js";

test("saves under the root, skips identical, never overwrites or deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ip-local-"));
  const folder = await LocalFolder.open(root);
  const dir = await folder.ensureFolder("My Drive/Insurance/Foremost");
  assert.ok(dir.endsWith(join("Insurance", "Foremost")));

  const a = Buffer.from("%PDF-1.4 A");
  const b = Buffer.from("%PDF-1.4 B");
  const first = await folder.savePdf(dir, "Foremost - Declarations - 2026-10-08", a);
  assert.equal(first.status, "saved");
  assert.equal(first.name, "Foremost - Declarations - 2026-10-08.pdf");

  const again = await folder.savePdf(dir, "Foremost - Declarations - 2026-10-08", a);
  assert.equal(again.status, "already_saved");

  const different = await folder.savePdf(dir, "Foremost - Declarations - 2026-10-08", b);
  assert.equal(different.status, "saved");
  assert.equal(different.name, "Foremost - Declarations - 2026-10-08 (2).pdf");

  // The original is untouched and both files are still there.
  assert.equal((await readFile(join(dir, first.name))).toString(), "%PDF-1.4 A");
  assert.deepEqual((await readdir(dir)).sort(), [first.name, different.name].sort());

  // A file the operator put there by hand with the same name is not replaced.
  await writeFile(join(dir, "Foremost - ID Card - 2026-10-08.pdf"), "operator's own file");
  const id = await folder.savePdf(dir, "Foremost - ID Card - 2026-10-08", a);
  assert.equal(id.name, "Foremost - ID Card - 2026-10-08 (2).pdf");
  assert.equal((await readFile(join(dir, "Foremost - ID Card - 2026-10-08.pdf"))).toString(), "operator's own file");
});

test("cannot write outside the root, by path or by a symlinked folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "ip-local-"));
  const outside = await mkdtemp(join(tmpdir(), "ip-outside-"));
  await symlink(outside, join(root, "escape"));
  const folder = await LocalFolder.open(root);
  await assert.rejects(folder.ensureFolder("Insurance/../../etc"), /EINVALID_DESTINATION/);
  await assert.rejects(folder.ensureFolder("escape/Insurance"), /EINVALID_DESTINATION/);
  assert.deepEqual(await readdir(outside), [], "nothing was created outside");
});

test("missing root is a clear error", async () => {
  await assert.rejects(LocalFolder.open(join(tmpdir(), "does-not-exist-ip-xyz")), /ELOCAL_ROOT/);
});

test("finds the Drive for desktop folder only when exactly one account is signed in", async () => {
  const home = await mkdtemp(join(tmpdir(), "ip-home-"));
  assert.equal(findDriveForDesktop(home), null);
  const one = join(home, "Library", "CloudStorage", "GoogleDrive-a@example.com", "My Drive");
  await mkdir(one, { recursive: true });
  await mkdir(join(home, "Library", "CloudStorage", "Dropbox"), { recursive: true });
  assert.equal(findDriveForDesktop(home), one);
  await mkdir(join(home, "Library", "CloudStorage", "GoogleDrive-b@example.com", "My Drive"), { recursive: true });
  assert.equal(findDriveForDesktop(home), null, "two accounts: never guess");
});
