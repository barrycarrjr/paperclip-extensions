export type OnReceiveMode = "none" | "event" | "issue";
export type IssuePriority = "low" | "medium" | "high" | "critical";

export interface OnReceiveConfig {
  mode?: OnReceiveMode;
  projectId?: string;
  assigneeAgentId?: string;
  defaultPriority?: IssuePriority;
  markAsRead?: boolean;
}

export type MailboxAuthType = "basic" | "oauth2";
export type OAuthProvider = "microsoft";

export interface ConfigMailbox {
  name?: string;
  key?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  user?: string;
  /** Secret-ref to the app password. Required only for `authType: "basic"`. */
  pass?: string;
  /**
   * Authentication mode. "basic" = username + app password (default, legacy).
   * "oauth2" = XOAUTH2 via "Connect with Microsoft" (required for Outlook/365
   * since Microsoft disabled basic auth). When "oauth2", `pass` is ignored and
   * tokens are stored in plugin state keyed by mailbox `key`.
   */
  authType?: MailboxAuthType;
  /** OAuth provider when authType is "oauth2". Defaults to "microsoft". */
  oauthProvider?: OAuthProvider;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpFrom?: string;
  allowedCompanies?: string[];
  pollEnabled?: boolean;
  pollFolder?: string;
  pollSinceDays?: number;
  ingestCompanyId?: string;
  onReceive?: OnReceiveConfig;
  filterFromContains?: string[];
  filterSubjectContains?: string[];
  disallowMove?: boolean;
}

export interface InstanceConfig {
  allowSend?: boolean;
  pollIntervalMinutes?: number;
  mailboxes?: ConfigMailbox[];
  /**
   * Azure Entra "Application (client) ID" of the registered OAuth app, used for
   * all `authType: "oauth2"` Microsoft mailboxes. Public client (PKCE) — no
   * client secret is stored.
   */
  oauthMicrosoftClientId?: string;
  /**
   * The exact redirect URI registered in the Azure app (Authentication blade).
   * Must match byte-for-byte. Typically
   * `http://localhost:3100/api/plugins/<pluginId>/api/oauth/callback`.
   */
  oauthRedirectUri?: string;
}
