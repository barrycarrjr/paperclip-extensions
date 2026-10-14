import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import manifest from "./manifest.js";
import { allocateGoogleSecretNames, googleSecretNames } from "./setupNames.js";
import { accountFromGoogleSetup, mergeGoogleAccount, snapshotGoogleSetupInput } from "./setupConfig.js";

test("UI and CLI secret names are portable, including numeric and hyphenated account keys", () => {
  assert.deepEqual(googleSecretNames(" acme-print "), {
    clientId: "google_acme_print_client_id", clientSecret: "google_acme_print_client_secret", refreshToken: "google_acme_print_refresh_token",
  });
  for (const key of ["personal", "acme-print", "123", "a--b"]) {
    for (const name of Object.values(googleSecretNames(key))) assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  }
  for (const key of ["", "../unsafe", "Account", "has space", "line\nbreak"])
    assert.throws(() => googleSecretNames(key), /Account identifier/);
});

test("delayed consent uses an immutable full input snapshot for credentials, owner and account persistence", async () => {
  const form = {
    accountKey: "personal", displayName: "Original name", clientId: "original-client", clientSecret: "original-secret",
    ownerCompanyId: "original-owner", allowedCompanies: ["original-company"],
    scopes: ["https://www.googleapis.com/auth/calendar"], setAsDefault: true,
  };
  const attempt = snapshotGoogleSetupInput(form);
  let resume!: () => void;
  const blocked = new Promise<void>(resolve => { resume = resolve; });
  const delayedStart = (async () => {
    await blocked;
    return { clientId: attempt.clientId, clientSecret: attempt.clientSecret, scopes: attempt.scopes };
  })();
  form.accountKey = "changed"; form.displayName = "Changed name";
  form.clientId = "changed-client"; form.clientSecret = "changed-secret";
  form.ownerCompanyId = "changed-owner"; form.allowedCompanies[0] = "changed-company";
  form.scopes[0] = "https://www.googleapis.com/auth/drive"; form.setAsDefault = false;
  resume();
  const authInputs = await delayedStart;
  assert.deepEqual(authInputs, { clientId: "original-client", clientSecret: "original-secret", scopes: ["https://www.googleapis.com/auth/calendar"] });
  const account = accountFromGoogleSetup(attempt, {clientIdRef:"fresh-client",clientSecretRef:"fresh-secret",refreshTokenRef:"fresh-token"}, "synthetic@example.test");
  assert.equal(account.key, "personal");
  assert.equal(account.displayName, "Original name");
  assert.equal(attempt.ownerCompanyId, "original-owner");
  assert.equal(attempt.clientId, authInputs.clientId);
  assert.equal(attempt.clientSecret, authInputs.clientSecret);
  assert.deepEqual(account.scopes, authInputs.scopes);
  assert.deepEqual(account.allowedCompanies, ["original-company"]);
  assert.equal(mergeGoogleAccount({}, account, attempt.setAsDefault).defaultAccount, "personal");
  assert.throws(() => (attempt.allowedCompanies as string[]).push("changed"), TypeError);
});

test("reconnection allocates fresh secrets without rotating or colliding with shared names", () => {
  const standard = googleSecretNames("acme-print");
  assert.deepEqual(allocateGoogleSecretNames("acme-print", [], "abc123"), standard);
  const fresh = allocateGoogleSecretNames("acme-print", [standard.clientSecret], "abc123");
  assert.deepEqual(fresh, {
    clientId: "google_acme_print_client_id_abc123", clientSecret: "google_acme_print_client_secret_abc123", refreshToken: "google_acme_print_refresh_token_abc123",
  });
  for (const name of Object.values(fresh)) assert.match(name, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.throws(() => allocateGoogleSecretNames("acme-print", [...Object.values(standard), fresh.clientId], "abc123"), /already exist/);
  assert.throws(() => googleSecretNames("a".repeat(163), "0".repeat(16)), /too long/);
  assert.throws(() => googleSecretNames("personal", "-bad"), /Secret suffix/);
});

test("account setup preserves advanced instance and account fields on reauthorization", () => {
  const untouched = { key: "other", allowedCompanies: ["other-company"], refreshTokenRef: "other-token" };
  const current = {
    allowMutations: true, defaultAccount: "other", futureSetting: { enabled: true },
    accounts: [{ key: "personal", clientIdRef: "old", backupVerificationProfiles: [{ key: "archive", enabled: true }], scopes: ["old"], allowedCompanies: ["old-company"] }, untouched],
  };
  const replacement = { key: "personal", clientIdRef: "new-client", clientSecretRef: "new-secret", refreshTokenRef: "new-token", scopes: undefined, allowedCompanies: ["new-company"] };
  const result = mergeGoogleAccount(current, replacement, false);
  assert.equal(result.allowMutations, true);
  assert.equal(result.defaultAccount, "other");
  assert.deepEqual(result.futureSetting, { enabled: true });
  assert.equal(result.accounts!.length, 2);
  assert.equal(result.accounts![0], untouched);
  assert.deepEqual(result.accounts![1], { ...current.accounts[0], ...replacement });
  assert.deepEqual(current.accounts[0].allowedCompanies, ["old-company"]);
  assert.equal(mergeGoogleAccount({}, replacement, true).allowMutations, false);
  assert.equal(mergeGoogleAccount({}, replacement, true).defaultAccount, "personal");
});

test("wizard, manifest, README and CLI agree on Desktop app, routes, secret names and dropdowns", async () => {
  const [readme, ui, cli, worker, packageJson] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("./ui/index.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/grant-google-access.ts", import.meta.url), "utf8"),
    readFile(new URL("./worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.equal(manifest.version, "0.3.29");
  assert.equal(JSON.parse(packageJson).version, manifest.version);
  assert.equal(manifest.ui!.slots![0].routePath, "setup-account");
  const configSchema = manifest.instanceConfigSchema as { properties: { allowMutations: { default: boolean } } };
  assert.equal(configSchema.properties.allowMutations.default, false);
  for (const docs of [readme, manifest.setupInstructions!]) {
    assert.ok(docs.includes("/<company>/setup-account"));
    assert.ok(docs.includes("/<company>/company/settings/secrets"));
    assert.ok(docs.includes("Desktop app"));
    assert.ok(docs.includes("Pick from your secrets"));
    assert.ok(docs.includes("google_<key>_client_id"));
    assert.ok(docs.includes("google_<key>_client_secret"));
    assert.ok(docs.includes("google_<key>_refresh_token"));
    assert.ok(!docs.includes("/<company>/plugins/google-workspace/setup-account"));
  }
  assert.ok(ui.includes('usePluginAction("oauth_start_loopback_flow")'));
  assert.ok(ui.includes('usePluginAction("oauth_submit_callback")'));
  assert.ok(ui.includes("allocateGoogleSecretNames(input.accountKey"));
  assert.ok(ui.includes("names.clientId") && ui.includes("names.clientSecret") && ui.includes("names.refreshToken"));
  assert.ok(ui.includes("mergeGoogleAccount(existing, newAccount, input.setAsDefault)"));
  assert.ok(cli.includes("googleSecretNames(accountKey)"));
  assert.ok(cli.includes("/<company>/company/settings/secrets"));
  assert.ok(cli.includes("Pick from your secrets"));
  assert.ok(!cli.includes("/instance/settings/companies/<company>/secrets"));
  assert.ok(!cli.includes('"google-${accountKey}-'));
  assert.ok(worker.includes("async onShutdown() { stopOAuth?.(); }"));
});
