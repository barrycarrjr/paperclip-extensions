import { test } from "node:test";
import assert from "node:assert/strict";
import { profileDirFor } from "./profiles.js";

test("profiles live under ~/.paperclip by default, one per carrier", () => {
  assert.equal(profileDirFor({}, "foremost", "/Users/x"), "/Users/x/.paperclip/insurance-portals/profiles/foremost");
  assert.equal(profileDirFor({ rememberSignIn: false }, "foremost", "/Users/x"), null);
});

test("a profiles folder inside a synced folder is refused", () => {
  for (const bad of [
    "/Users/x/Library/CloudStorage/GoogleDrive-a@b.com/My Drive/profiles",
    "/Users/x/Google Drive/profiles",
    "/Users/x/Dropbox/profiles",
    "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/profiles",
  ]) {
    assert.throws(() => profileDirFor({ profilesFolder: bad }, "selective", "/Users/x"), /EPROFILE_FOLDER/, bad);
  }
  assert.equal(profileDirFor({ profilesFolder: "/Users/x/private/pp" }, "selective", "/Users/x"), "/Users/x/private/pp/selective");
});
