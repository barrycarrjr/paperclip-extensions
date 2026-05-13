/**
 * Campaign + Lead + DNC + CompliancePreflight type definitions.
 *
 * All four shapes persist in `ctx.state` (instance scope) — no new
 * SDK capabilities required. State key conventions:
 *
 *   campaign:<id>                            → Campaign
 *   campaign:<id>:lead:<phoneE164>           → CampaignLead
 *   campaign:<id>:counters:<YYYY-MM-DD>      → CampaignDailyCounters
 *   campaign:<id>:lead-index                 → string[] (lead phone numbers, for enumeration)
 *   campaigns:<companyId>                    → string[] (campaign IDs owned by company)
 *   dnc:<accountKey>                         → DncList
 *
 * The lead-index sidecar exists because `ctx.state.list` doesn't
 * support prefix scans uniformly across all SDK versions; an explicit
 * index keeps lead enumeration O(1) per campaign.
 */

export type CampaignStatus = "draft" | "running" | "paused" | "stopped" | "completed";

export type CampaignLeadStatus =
  | "pending"
  | "calling"
  | "called"
  | "no-answer"
  | "busy"
  | "qualified"
  | "disqualified"
  | "transferred"
  | "dnc"
  | "voicemail";

export type CampaignAudienceKind = "b2b-businesses" | "b2b-with-soleprop" | "consumer";

export type CampaignListSource =
  | "first-party-customers"
  | "first-party-inquired"
  | "scraped-public-business"
  | "rented"
  | "purchased"
  | "other";

export interface CompliancePreflight {
  audienceKind: CampaignAudienceKind;
  audienceJustification: string;
  listSource: CampaignListSource;
  listSourceNote: string;
  geographicScope: string[];
  callerLocalHours: { startHour: number; endHour: number; weekendsAllowed: boolean };
  openingDisclosure: string;
  optOutLanguage: string;
  acknowledgedTcpa: boolean;
  acknowledgedDnc: boolean;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

export interface CampaignPacing {
  /** Max simultaneous outbound calls FROM THIS CAMPAIGN. Caps to account.maxConcurrentCalls. */
  maxConcurrent: number;
  /** Soft delay between consecutive dials within a single runner tick. */
  secondsBetweenDials: number;
  /** Hard rate cap per campaign. */
  maxPerHour: number;
  /** Hard rate cap per campaign. */
  maxPerDay: number;
}

export interface CampaignRetry {
  onNoAnswer: { afterSec: number; maxAttempts: number };
  onBusy: { afterSec: number; maxAttempts: number };
}

export interface Campaign {
  id: string;
  companyId: string;
  accountKey: string;
  assistantAgentId: string;
  name: string;
  purpose: string;
  preflight: CompliancePreflight;
  pacing: CampaignPacing;
  retry: CampaignRetry;
  /**
   * Optional Paperclip project where qualified leads' issues land.
   * If unset, falls back to the assistant's own
   * `transferIssueProjectId` from PhoneConfig.
   */
  outcomeIssueProjectId?: string;
  status: CampaignStatus;
  startedAt?: string;
  pausedAt?: string;
  stoppedAt?: string;
  createdAt: string;
  createdBy: string;
}

export interface CampaignLead {
  campaignId: string;
  phoneE164: string;
  name?: string;
  businessName?: string;
  websiteUrl?: string;
  /** Free-form per-lead context the runner passes to the AI as call brief. */
  meta?: Record<string, unknown>;
  /** IANA tz hint for business-hours enforcement. Falls back to campaign scope's TZ. */
  timezoneHint?: string;
  status: CampaignLeadStatus;
  attempts: number;
  lastAttemptAt?: string;
  /** Earliest time this lead may be re-dialed (retry gate). */
  nextAttemptAfter?: string;
  callIds: string[];
  outcome?: {
    summary: string;
    transferred: boolean;
    transferredTo?: string;
    qualifiedNote?: string;
    issueId?: string;
  };
}

export interface CampaignDailyCounters {
  attempted: number;
  qualified: number;
  disqualified: number;
  noAnswer: number;
  transferred: number;
  costUsd: number;
}

export interface DncEntry {
  phoneE164: string;
  addedAt: string;
  /** Source campaign if added via opt-out tool; null if added manually. */
  addedByCampaignId?: string;
  /** "opt-out" | "operator-added" | "regulatory" — free-form. */
  reason?: string;
}

export interface DncList {
  accountKey: string;
  entries: DncEntry[];
}

/**
 * Default pacing for new campaigns. Conservative — operator can tune
 * upward in the wizard if their carrier / Vapi org tier supports more.
 */
export const DEFAULT_PACING: CampaignPacing = {
  maxConcurrent: 2,
  secondsBetweenDials: 90,
  maxPerHour: 30,
  maxPerDay: 200,
};

/**
 * Default retry policy. After 4 hours an unanswered lead is dialed
 * once more; after 10 minutes a busy signal retries up to 3 times.
 * Past these caps the lead settles on no-answer / busy permanently.
 */
export const DEFAULT_RETRY: CampaignRetry = {
  onNoAnswer: { afterSec: 4 * 60 * 60, maxAttempts: 2 },
  onBusy: { afterSec: 10 * 60, maxAttempts: 3 },
};
