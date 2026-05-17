/**
 * Jambonz verb composition.
 *
 * Jambonz' application-hook protocol: when something happens on a call
 * (call answered, gather completed, etc.) Jambonz POSTs a webhook to the
 * application URL and EXPECTS a JSON array of verbs as the response.
 * Each verb tells Jambonz what to do next.
 *
 * v0.6.0 only uses three verbs:
 *   - `say`      — speak text via the configured TTS provider
 *   - `gather`   — collect speech input via STT (Deepgram by default),
 *                  then hit the actionHook with the transcript
 *   - `hangup`   — end the call
 *
 * Audio routing, STT, and TTS are handled by Jambonz internally — we
 * just compose the high-level verb sequence and post the resulting
 * conversation turn back. This is much simpler than maintaining our own
 * audio pipeline and is the right slice for v0.6.0.
 *
 * Future v0.6.x can swap to the streaming WebSocket API for barge-in.
 */

export interface SayVerb {
  verb: "say";
  text: string;
  /** ElevenLabs / etc. provider config — operator picks the voice. */
  synthesizer?: {
    vendor?: string;
    voice?: string;
    language?: string;
  };
}

export interface GatherVerb {
  verb: "gather";
  input: ["speech"];
  actionHook: string;
  recognizer?: {
    vendor?: string;
    language?: string;
  };
  /** End-of-utterance silence window in seconds. */
  timeout?: number;
  /** Hard cap on total gather duration. */
  numDigits?: number;
}

export interface HangupVerb {
  verb: "hangup";
}

export type JambonzVerb = SayVerb | GatherVerb | HangupVerb;

export interface TurnVerbOpts {
  spokenLine: string;
  /**
   * URL Jambonz will POST to with the transcript of the caller's reply
   * after the gather completes. Empty/undefined → no gather (terminal
   * turn — the call ends after the spoken line plays).
   */
  nextHookUrl?: string;
  ttsVendor: string;
  ttsVoice: string;
  ttsLanguage: string;
  sttVendor: string;
  sttLanguage: string;
  /** End-of-utterance silence in seconds. Default 1. */
  endOfTurnSec?: number;
}

/**
 * Compose the verb sequence for a single conversation turn: speak a
 * line, then optionally gather the caller's reply. If `nextHookUrl` is
 * omitted, the call ends after the spoken line plays.
 */
export function buildTurnVerbs(opts: TurnVerbOpts): JambonzVerb[] {
  const say: SayVerb = {
    verb: "say",
    text: opts.spokenLine,
    synthesizer: {
      vendor: opts.ttsVendor,
      voice: opts.ttsVoice,
      language: opts.ttsLanguage,
    },
  };

  if (!opts.nextHookUrl) {
    return [say, { verb: "hangup" }];
  }

  const gather: GatherVerb = {
    verb: "gather",
    input: ["speech"],
    actionHook: opts.nextHookUrl,
    recognizer: {
      vendor: opts.sttVendor,
      language: opts.sttLanguage,
    },
    timeout: opts.endOfTurnSec ?? 1,
  };

  return [say, gather];
}

/**
 * Compose a terminal hangup verb sequence (e.g. operator force-end or
 * end-of-conversation signal from the LLM).
 */
export function buildHangupVerbs(spokenLine?: string, ttsCfg?: {
  vendor: string;
  voice: string;
  language: string;
}): JambonzVerb[] {
  const verbs: JambonzVerb[] = [];
  if (spokenLine && ttsCfg) {
    verbs.push({
      verb: "say",
      text: spokenLine,
      synthesizer: {
        vendor: ttsCfg.vendor,
        voice: ttsCfg.voice,
        language: ttsCfg.language,
      },
    });
  }
  verbs.push({ verb: "hangup" });
  return verbs;
}
