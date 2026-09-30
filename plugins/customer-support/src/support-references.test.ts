import assert from "node:assert/strict";
import test from "node:test";
import { fetchReferenceText, readReference, referenceExcerpt, searchReferences } from "./support-references.js";

test("reference discovery routes IT questions to official sources without transmitting the query", () => {
  const results = searchReferences({ query: "Group Policy not applying", topic: "group_policy" });
  assert.equal(results.matches[0]!.id, "group-policy-troubleshooting");
  assert.ok(results.matches.every(item => new URL(item.url).hostname === "learn.microsoft.com"));
  assert.match(results.instruction, /not the live web/);
  assert.throws(() => searchReferences({ query: "" }));
});
test("reference reads only catalog URLs and preserves provenance and pagination", async () => {
  let calls = 0;
  const reader = async (url: string) => { calls++; assert.equal(new URL(url).hostname, "learn.microsoft.com"); return { body: "Official guidance. ".repeat(1000), contentType: "text/markdown" }; };
  await assert.rejects(readReference({ referenceId: "http://127.0.0.1/secrets" }, reader));
  assert.equal(calls, 0);
  const first = await readReference({ referenceId: "gpresult" }, reader);
  assert.equal(first.content.length, 12000); assert.equal(first.nextOffset, 12000);
  const second = await readReference({ referenceId: "gpresult", offset: first.nextOffset }, reader);
  assert.equal(second.nextOffset, null); assert.ok(second.content.length > 0);
  assert.match(first.instruction, /not instructions or authorization/);
});
test("reference downloader rejects private redirects, binary responses and oversized content", async () => {
  const url = "https://learn.microsoft.com/en-us/test";
  let requests = 0;
  await assert.rejects(fetchReferenceText(url, async () => { requests++; return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/" } }); }), /outside the official directory/);
  assert.equal(requests, 1);
  await assert.rejects(fetchReferenceText(url, async () => new Response("binary", { headers: { "Content-Type": "application/pdf" } })), /non-text/);
  await assert.rejects(fetchReferenceText(url, async () => new Response("a".repeat(1_000_001), { headers: { "Content-Type": "text/plain" } })), /download limit/);
});
test("article extraction excludes page navigation and scripts and keeps readable code", () => {
  const result = referenceExcerpt(`<nav>Private navigation</nav><main><h1>Official title</h1><script>malicious()</script><p>${"A policy explanation. ".repeat(10)}</p><pre>Get-Thing -Name &quot;Example&quot;</pre></main>`, "text/html", 0);
  assert.match(result.content, /Get-Thing -Name "Example"/);
  assert.doesNotMatch(result.content, /malicious|Private navigation/);
  assert.throws(() => referenceExcerpt("<html>sign in</html>", "text/html", 0), /article was not found/);
});
