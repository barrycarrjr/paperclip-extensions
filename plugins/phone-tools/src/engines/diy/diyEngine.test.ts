/**
 * Unit tests for the DIY engine — covers the bits that work without a live
 * Jambonz/LLM instance: verb composition, conversation state transitions,
 * hook payload parsing, signature verification.
 *
 * Run with: pnpm --filter paperclip-plugin-phone-tools test
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  createDiyEngine,
  type DiyEngine,
  type DiyEngineOptions,
} from "./diyEngine.js";
import {
  buildHangupVerbs,
  buildTurnVerbs,
  type GatherVerb,
  type SayVerb,
} from "./verbBuilder.js";
import { verifyJambonzSignature } from "./jambonzClient.js";
import type { AssistantConfig } from "../types.js";

const baseOpts: DiyEngineOptions = {
  jambonzApiUrl: "https://jambonz.test",
  jambonzApiKey: "test-key",
  jambonzAccountSid: "acc-1",
  jambonzApplicationSid: "app-1",
  webhookSecret: null, // signature checks pass when null (dev-mode opt-out)
  hostBaseUrl: "https://paperclip.test",
  pluginId: "phone-tools",
  accountKey: "main",
  llmProvider: "anthropic",
  llmApiKey: "test-llm-key",
  ttsVendor: "google",
  ttsVoice: "en-US-Wavenet-D",
  ttsLanguage: "en-US",
  sttVendor: "deepgram",
  sttLanguage: "en-US",
  recordingEnabled: false,
};

const assistant: AssistantConfig = {
  name: "TestAssistant",
  systemPrompt: "You are a test.",
  firstMessage: "Hello, this is a test call.",
};

describe("verbBuilder", () => {
  it("buildTurnVerbs composes say + gather with the right hooks", () => {
    const verbs = buildTurnVerbs({
      spokenLine: "Hi there",
      nextHookUrl: "https://x/next",
      ttsVendor: "elevenlabs",
      ttsVoice: "rachel",
      ttsLanguage: "en-US",
      sttVendor: "deepgram",
      sttLanguage: "en-US",
    });
    assert.equal(verbs.length, 2);
    const say = verbs[0] as SayVerb;
    assert.equal(say.verb, "say");
    assert.equal(say.text, "Hi there");
    assert.equal(say.synthesizer?.voice, "rachel");
    const gather = verbs[1] as GatherVerb;
    assert.equal(gather.verb, "gather");
    assert.deepEqual(gather.input, ["speech"]);
    assert.equal(gather.actionHook, "https://x/next");
    assert.equal(gather.recognizer?.vendor, "deepgram");
  });

  it("buildTurnVerbs ends the call when no nextHookUrl provided", () => {
    const verbs = buildTurnVerbs({
      spokenLine: "Goodbye.",
      ttsVendor: "google",
      ttsVoice: "v",
      ttsLanguage: "en-US",
      sttVendor: "deepgram",
      sttLanguage: "en-US",
    });
    assert.equal(verbs.length, 2);
    assert.equal(verbs[0].verb, "say");
    assert.equal(verbs[1].verb, "hangup");
  });

  it("buildHangupVerbs without a spoken line is hangup-only", () => {
    const v = buildHangupVerbs();
    assert.equal(v.length, 1);
    assert.equal(v[0].verb, "hangup");
  });
});

describe("verifyJambonzSignature", () => {
  it("accepts everything when secret is null (dev-mode opt-out)", async () => {
    assert.equal(await verifyJambonzSignature(null, "anything", "whatever"), true);
  });

  it("rejects missing signature header when secret is configured", async () => {
    assert.equal(await verifyJambonzSignature("secret", "body", undefined), false);
  });

  it("accepts a correct HMAC-SHA256 signature", async () => {
    // Compute the same HMAC the verifier expects.
    const enc = new TextEncoder();
    const subtle = (globalThis as { crypto: { subtle: SubtleCrypto } }).crypto.subtle;
    const key = await subtle.importKey(
      "raw",
      enc.encode("secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await subtle.sign("HMAC", key, enc.encode("body"));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert.equal(await verifyJambonzSignature("secret", "body", hex), true);
  });

  it("rejects a tampered signature", async () => {
    assert.equal(
      await verifyJambonzSignature("secret", "body", "0".repeat(64)),
      false,
    );
  });
});

describe("DiyEngine — outbound call lifecycle", () => {
  let engine: DiyEngine;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    fetchCalls = [];
    // Stub fetch — return canned shapes for the Jambonz REST endpoints
    // the engine hits during these tests.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      fetchCalls.push({ url: u, init });
      if (u.includes("/v1/Accounts/acc-1/Calls") && init?.method === "POST") {
        return new Response(JSON.stringify({ sid: "call-xyz", status: "queued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (u.includes("/v1/Accounts/acc-1/PhoneNumbers")) {
        return new Response(
          JSON.stringify([
            { phone_number_sid: "n-1", number: "+15551234567", voip_carrier_sid: "c-1" },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (u.includes("/v1/Accounts/acc-1/Calls/")) {
        // GET or POST to a specific call
        return new Response(JSON.stringify({ sid: "call-xyz" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not stubbed", { status: 404 });
    }) as typeof fetch;
    engine = createDiyEngine(baseOpts);
  });

  it("startOutboundCall calls Jambonz and returns the engine sid", async () => {
    const result = await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    assert.equal(result.callId, "call-xyz");
    assert.equal(result.status, "queued");
    assert.ok(
      fetchCalls.some((c) =>
        c.url.includes("/v1/Accounts/acc-1/Calls") &&
        c.init?.method === "POST",
      ),
    );
  });

  it("startOutboundCall rejects string-named assistants in v0.6.0", async () => {
    await assert.rejects(
      () =>
        engine.startOutboundCall({
          to: "+15555550199",
          numberId: "+15551234567",
          assistant: "saved-name",
        }),
      /ENOT_SUPPORTED.*saved assistants/i,
    );
  });

  it("startOutboundCall requires numberId", async () => {
    await assert.rejects(
      () =>
        engine.startOutboundCall({
          to: "+15555550199",
          assistant,
        }),
      /EINVALID_INPUT.*numberId/,
    );
  });

  it("listNumbers maps Jambonz phone-numbers to NormalizedPhoneNumber", async () => {
    const numbers = await engine.listNumbers();
    assert.equal(numbers.length, 1);
    assert.equal(numbers[0].e164, "+15551234567");
    assert.equal(numbers[0].sipTrunk, "c-1");
  });

  it("handleCallHook on an outbound call returns first-turn verbs", async () => {
    await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    const r = await engine.handleCallHook("call-xyz", "{}", undefined);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.verbs.length, 2);
    const say = r.verbs[0] as SayVerb;
    assert.equal(say.verb, "say");
    assert.equal(say.text, "Hello, this is a test call.");
    const gather = r.verbs[1] as GatherVerb;
    assert.equal(gather.verb, "gather");
    assert.ok(gather.actionHook.includes("/diy/jambonz/next"));
    assert.ok(gather.actionHook.includes("callSid=call-xyz"));
  });

  it("handleCallHook on an unknown call returns a polite hangup", async () => {
    const r = await engine.handleCallHook("unknown-call", "{}", undefined);
    assert.ok(r.ok);
    if (!r.ok) return;
    // [say, hangup]
    assert.equal(r.verbs[r.verbs.length - 1].verb, "hangup");
  });

  it("handleNextHook reprompts when caller's speech is empty", async () => {
    await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    await engine.handleCallHook("call-xyz", "{}", undefined);
    const r = await engine.handleNextHook("call-xyz", "{}", undefined, { speech: { transcript: "" } });
    assert.ok(r.ok);
    if (!r.ok) return;
    const say = r.verbs[0] as SayVerb;
    assert.match(say.text, /didn't catch/i);
  });

  it("handleNextHook on a real caller turn calls the LLM and returns its reply as say+gather", async () => {
    // Add Anthropic stub.
    const baseStub = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://api.anthropic.com/v1/messages") {
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "Great, I can help with that." }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseStub(url, init);
    }) as typeof fetch;

    await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    await engine.handleCallHook("call-xyz", "{}", undefined);
    const r = await engine.handleNextHook("call-xyz", "{}", undefined, {
      speech: { transcript: "I'd like to book an appointment." },
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    const say = r.verbs[0] as SayVerb;
    assert.equal(say.text, "Great, I can help with that.");
    assert.equal(r.verbs[1].verb, "gather");
  });

  it("handleNextHook hangs up when the LLM says 'goodbye'", async () => {
    const baseStub = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://api.anthropic.com/v1/messages") {
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "Thanks for calling. Goodbye!" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseStub(url, init);
    }) as typeof fetch;

    await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    await engine.handleCallHook("call-xyz", "{}", undefined);
    const r = await engine.handleNextHook("call-xyz", "{}", undefined, {
      speech: { transcript: "OK, that's all I needed." },
    });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.verbs[r.verbs.length - 1].verb, "hangup");
  });

  it("handleStatusHook completes the call and produces a call.ended event", async () => {
    await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    const r = await engine.handleStatusHook(
      "call-xyz",
      "{}",
      undefined,
      {
        call_status: "completed",
        duration: 47,
        end_time: "2026-05-17T22:00:00Z",
        termination_reason: "normal-clearing",
      },
    );
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(r.event);
    assert.equal(r.event!.kind, "call.ended");
    if (r.event!.kind === "call.ended") {
      assert.equal(r.event!.durationSec, 47);
      assert.equal(r.event!.endReason, "normal-clearing");
    }

    const status = await engine.getCallStatus("call-xyz");
    assert.equal(status.status, "ended");
    assert.equal(status.durationSec, 47);
  });

  it("getCallTranscript returns conversation turns", async () => {
    const baseStub = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === "https://api.anthropic.com/v1/messages") {
        return new Response(
          JSON.stringify({ content: [{ type: "text", text: "Booked." }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return baseStub(url, init);
    }) as typeof fetch;

    await engine.startOutboundCall({
      to: "+15555550199",
      numberId: "+15551234567",
      assistant,
    });
    await engine.handleCallHook("call-xyz", "{}", undefined);
    await engine.handleNextHook("call-xyz", "{}", undefined, { speech: { transcript: "Book me a haircut" } });

    const t = await engine.getCallTranscript("call-xyz", "structured");
    assert.ok(t.structured);
    assert.equal(t.structured!.length, 3);
    assert.equal(t.structured![0].role, "agent");
    assert.equal(t.structured![1].role, "caller");
    assert.equal(t.structured![1].text, "Book me a haircut");
  });

  // Restore fetch after each test
  it("teardown: restores global fetch", () => {
    globalThis.fetch = origFetch;
  });
});
