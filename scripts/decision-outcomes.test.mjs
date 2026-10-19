import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, cpSync, symlinkSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  skill: "skills/decision-outcomes/SKILL.md",
  routine: "routines/decision-outcome-review/ROUTINE.md",
  bundle: "bundles/decision-outcomes/BUNDLE.md",
};

function parse(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  assert.ok(match, "template has complete frontmatter");
  return { header: yaml.load(match[1], { schema: yaml.JSON_SCHEMA }), block: match[1], body: match[2] };
}

const templates = Object.fromEntries(Object.entries(files).map(([kind, sourcePath]) => {
  const raw = readFileSync(path.join(repo, sourcePath), "utf8");
  return [kind, { ...parse(raw), raw, sourcePath }];
}));

test("template identities and declared substitutions fit the deployed routine contract", () => {
  for (const template of Object.values(templates)) {
    assert.equal(template.header.name, path.basename(path.dirname(template.sourcePath)));
    assert.equal(typeof template.header.description, "string");
    assert.ok(template.header.description.length > 0);
    assert.ok(template.body.trim().length > 0);
  }
  const { header } = templates.routine;
  assert.equal(typeof header.routineTitle, "string");
  assert.ok(header.routineTitle.length > 0 && header.routineTitle.length <= 200);
  assert.equal(typeof header.routineDescription, "string");
  assert.equal(header.priority, "medium");
  const names = new Set();
  for (const variable of header.variables) {
    assert.match(variable.name, /^[A-Za-z][A-Za-z0-9_]*$/);
    assert.ok(!names.has(variable.name), "variable names are unique");
    names.add(variable.name);
    assert.equal(typeof variable.label, "string");
    assert.ok(variable.label.length <= 120);
    assert.equal(variable.type, "text");
    assert.equal(variable.required, true);
    assert.ok(!Object.hasOwn(variable, "defaultValue"), "operator must choose values");
  }
  assert.deepEqual([...names].sort(), ["recordsLocation", "reviewTimezone"]);
  // Titles, descriptions and labels are user-visible substitution surfaces too.
  const strings = (value) => typeof value === "string" ? [value]
    : value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  const used = new Set();
  for (const value of strings(header)) {
    for (const match of value.matchAll(/{{([^{}]+)}}/g)) {
      const name = match[1].trim();
      assert.ok(names.has(name), `undeclared substitution ${name}`);
      used.add(name);
    }
  }
  assert.deepEqual([...used].sort(), [...names].sort());
});

test("on-demand defaults leave agent choice and activation to the operator", () => {
  const { header } = templates.routine;
  assert.deepEqual(header.triggers.map((trigger) => trigger.kind), ["api"]);
  assert.ok(header.triggers[0].label.length <= 120);
  for (const key of ["defaultAssigneeRole", "assigneeAgentId", "status", "schedule", "cronExpression", "timezone"]) {
    assert.ok(!Object.hasOwn(header, key), `no unsupported or activation default: ${key}`);
  }
  assert.equal(header.concurrencyPolicy, "coalesce_if_active");
  assert.equal(header.catchUpPolicy, "skip_missed");
  assert.deepEqual(header.requiresSkills, [templates.skill.header.name]);
  assert.ok(!Object.hasOwn(header, "requiresPlugins"));
});

test("bundle resolves exactly one existing skill and routine, with no new agent or plugin", () => {
  const { header } = templates.bundle;
  assert.deepEqual(header.includes, {
    skills: [templates.skill.header.name],
    routines: [templates.routine.header.name],
  });
  assert.ok(!Object.hasOwn(header, "requiresPlugins"));
  assert.ok(!Object.hasOwn(header, "optionalPlugins"));
});

test("published record examples have flat, collision-free headers and resolvable record links", () => {
  const examples = [...templates.skill.body.matchAll(/```markdown\r?\n([\s\S]*?)\r?\n```/g)]
    .map((match) => parse(match[1] + "\n"));
  assert.equal(examples.length, 2);
  const records = new Map();
  const reserved = new Set(["agent", "paperclip_id", "paperclipid", "drive_file_id", "drivefileid", "drive_id", "driveid"]);
  const isoDate = (value) => {
    assert.match(value, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(new Date(value).toISOString().slice(0, 10), value);
  };
  for (const { header, block } of examples) {
    const keys = new Set();
    for (const line of block.split(/\r?\n/)) {
      const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.+)$/.exec(line);
      assert.ok(match, "each header line is one flat scalar field");
      const key = match[1].toLowerCase();
      assert.ok(!keys.has(key), "case-insensitive keys are unique");
      assert.ok(!reserved.has(key), `record metadata does not reuse ${key}`);
      keys.add(key);
      assert.equal(typeof header[match[1]], "string", "no lists, objects or coerced scalars");
    }
    assert.ok(header.name.length > 0 && header.name.length <= 200);
    assert.equal(header.kind, "project");
    assert.equal(header.status, "active");
    isoDate(header.updated);
    assert.ok(["decision", "outcome"].includes(header.record_type));
    assert.ok(!records.has(header.record_id), "record IDs are unique");
    records.set(header.record_id, header);
  }
  const decision = examples.find(({ header }) => header.record_type === "decision");
  const outcome = examples.find(({ header }) => header.record_type === "outcome");
  for (const field of ["decided_on", "review_by"]) isoDate(decision.header[field]);
  for (const field of ["observed_on", "review_period"]) isoDate(outcome.header[field]);
  assert.equal(outcome.header.decision_record, decision.header.record_id);
  assert.equal(outcome.header.review_period, decision.header.review_by);
  assert.equal(outcome.header.topic, decision.header.topic);
  assert.ok(["worked", "partly_worked", "did_not_work", "too_early", "unknown"].includes(outcome.header.verdict));
  assert.ok(!Object.hasOwn(outcome.header, "next_review"), "example invents no next review");
  const links = [...outcome.body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.deepEqual(links, [`${decision.header.record_id}.md`]);
  assert.equal(records.get(path.basename(links[0], ".md")), decision.header);
});

test("the real release packer discovers and hashes the pack in a synthetic workspace", (t) => {
  const checkoutOutputExisted = existsSync(path.join(repo, "dist-pcplugins"));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "decision-outcomes-catalog-"));
  writeFileSync(path.join(scratch, ".owned-decision-outcomes-test"), "synthetic catalog only\n");
  mkdirSync(path.join(scratch, "scripts"));
  cpSync(path.join(repo, "scripts", "pack-all.mjs"), path.join(scratch, "scripts", "pack-all.mjs"));
  // Resolve only this checkout's already-installed root dependencies.
  const dependencies = path.join(scratch, "node_modules");
  symlinkSync(path.join(repo, "node_modules"), dependencies, process.platform === "win32" ? "junction" : "dir");
  t.after(() => {
    assert.equal(readFileSync(path.join(scratch, ".owned-decision-outcomes-test"), "utf8"), "synthetic catalog only\n");
    assert.ok(lstatSync(dependencies).isSymbolicLink(), "cleanup removes only the created dependency link");
    assert.equal(realpathSync(dependencies), realpathSync(path.join(repo, "node_modules")));
    unlinkSync(dependencies);
  });
  const plugin = path.join(scratch, "plugins", "example-fixture");
  mkdirSync(path.join(plugin, "dist"), { recursive: true });
  writeFileSync(path.join(plugin, "package.json"), JSON.stringify({ name: "example-fixture", version: "0.0.0", type: "module" }));
  writeFileSync(path.join(plugin, "dist", "manifest.js"), 'export default { id: "example-fixture", version: "0.0.0" };\n');
  for (const { raw, sourcePath } of Object.values(templates)) {
    mkdirSync(path.dirname(path.join(scratch, sourcePath)), { recursive: true });
    writeFileSync(path.join(scratch, sourcePath), raw);
  }
  const result = spawnSync(process.execPath, [path.join(scratch, "scripts", "pack-all.mjs")], {
    cwd: scratch, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const index = JSON.parse(readFileSync(path.join(scratch, "dist-pcplugins", "templates-index.json"), "utf8"));
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.counts, { bundle: 1, routine: 1, skill: 1 });
  for (const [kind, { raw, sourcePath, header }] of Object.entries(templates)) {
    const entry = index.templates.find((item) => item.kind === kind && item.name === header.name);
    assert.ok(entry, `release catalog contains ${kind}`);
    assert.equal(entry.sourcePath, sourcePath);
    assert.equal(entry.contentHash, "sha256:" + createHash("sha256").update(raw).digest("hex"));
    assert.deepEqual(entry.frontmatter, header);
  }
  assert.equal(existsSync(path.join(repo, "dist-pcplugins")), checkoutOutputExisted, "test did not create checkout release artifacts");
  // Keep fixtures for inspection, but remove their dependency link after the test.
});
