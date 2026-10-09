import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPrivateItems, privateItemsFromPolicies, privateListPath } from "./privateList.js";

test("appends only new items, keeps existing lines and the file's privacy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ip-list-"));
  const file = join(dir, "patterns.txt");
  const before = "# list\n1234567\nOak St\nre:(?<!\\d)9999(?!\\d)\nallow:^ok$\n";
  await writeFile(file, before);
  await chmod(file, 0o600);
  const added = await addPrivateItems(file, "Fake", ["1234567", "7654321", "12 Oak St", "900 Elm Ave", "7654321", "abc"], "2026-01-01");
  assert.equal(added, 2, "1234567 listed, '12 Oak St' covered by 'Oak St', duplicate and too-short items skipped");
  const after = await readFile(file, "utf8");
  assert.ok(after.startsWith(before), "existing lines untouched");
  assert.match(after, /# Added by insurance-portals from Fake, 2026-01-01\n7654321\n900 Elm Ave\n$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await addPrivateItems(file, "Fake", ["7654321", "900 Elm Ave"], "2026-01-02"), 0, "nothing new, nothing written");
  assert.equal(await readFile(file, "utf8"), after);
});

test("the list is used only if it exists, and can be turned off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ip-list-"));
  const file = join(dir, "patterns.txt");
  assert.equal(privateListPath(file), null, "missing file: nothing created");
  await writeFile(file, "");
  assert.equal(privateListPath(file), file);
  assert.equal(privateListPath("off"), null);
});

test("each downloaded document's policy number and address are listed", () => {
  assert.deepEqual(privateItemsFromPolicies(["12 Oak St - Policy 1234567", "12 Oak St - Policy 1234567", "Policy H37-291-123456-40", ""]).sort(), [
    "12 Oak St",
    "1234567",
    "H37-291-123456-40",
  ]);
});
