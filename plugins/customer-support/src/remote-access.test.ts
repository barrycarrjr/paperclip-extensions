import assert from "node:assert/strict";
import test from "node:test";
import { resolveRemoteAccess } from "./remote-access.js";
import { IntakeError, type Config } from "./routing.js";

const alpha = "11111111-1111-4111-8111-111111111111";
const beta = "22222222-2222-4222-8222-222222222222";
const secretRef = "33333333-3333-4333-8333-333333333333";
const config: Config = { remoteAccessProfiles: [{
  id: "alpha-workstations",
  companyId: alpha,
  credentialUser: "EXAMPLE\\support-agent",
  passwordRef: secretRef,
  targets: [{ address: "workstation.example.local", transport: "Wmi", allowProcessExecutionPolicyBypass: true }],
}] };

test("remote credentials resolve only for the exact company and target", () => {
  const resolved = resolveRemoteAccess(config, alpha, "WORKSTATION.EXAMPLE.LOCAL");
  assert.equal(resolved.passwordRef, secretRef);
  assert.equal(resolved.transport, "Wmi");
  assert.throws(() => resolveRemoteAccess(config, beta, "workstation.example.local"), IntakeError);
  assert.throws(() => resolveRemoteAccess(config, alpha, "other.example.local"), IntakeError);
});

test("duplicate bindings and invalid secret references fail closed", () => {
  const profile = config.remoteAccessProfiles![0]!;
  assert.throws(() => resolveRemoteAccess({ remoteAccessProfiles: [profile, profile] }, alpha, "workstation.example.local"), IntakeError);
  assert.throws(() => resolveRemoteAccess({ remoteAccessProfiles: [{ ...profile, passwordRef: "plain-password" }] }, alpha, "workstation.example.local"), IntakeError);
});

test("one company access group covers its DNS domain and office IP range", () => {
  const profile = { ...config.remoteAccessProfiles![0]!, targets: [], scopes: [
    { kind: "dns_suffix" as const, value: "office.example.local", transport: "Wmi" as const },
    { kind: "ipv4_cidr" as const, value: "192.0.2.0/24", transport: "Wmi" as const },
  ] };
  const grouped: Config = { remoteAccessProfiles: [profile] };
  assert.equal(resolveRemoteAccess(grouped, alpha, "pc01.office.example.local").target, "pc01.office.example.local");
  assert.equal(resolveRemoteAccess(grouped, alpha, "192.0.2.41").target, "192.0.2.41");
  assert.throws(() => resolveRemoteAccess(grouped, beta, "pc01.office.example.local"), IntakeError);
  assert.throws(() => resolveRemoteAccess(grouped, alpha, "pc01.eviloffice.example.local"), IntakeError);
  assert.throws(() => resolveRemoteAccess(grouped, alpha, "198.51.100.41"), IntakeError);
});

test("an exact computer overrides a broad group and overlapping groups fail closed", () => {
  const group = { ...config.remoteAccessProfiles![0]!, targets: [], scopes: [
    { kind: "dns_suffix" as const, value: "office.example.local", transport: "Auto" as const },
  ] };
  const exact = { ...config.remoteAccessProfiles![0]!, id: "exact", targets: [
    { address: "pc01.office.example.local", transport: "Wmi" as const },
  ] };
  assert.equal(resolveRemoteAccess({ remoteAccessProfiles: [group, exact] }, alpha, "pc01.office.example.local").transport, "Wmi");
  assert.throws(() => resolveRemoteAccess({ remoteAccessProfiles: [group, group] }, alpha, "pc01.office.example.local"), IntakeError);
});
