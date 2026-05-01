export type OnReceiveMode = "none" | "event" | "issue";
export type IssuePriority = "low" | "medium" | "high" | "critical";

export interface OnReceiveConfig {
  mode?: OnReceiveMode;
  projectId?: string;
  assigneeAgentId?: string;
  defaultPriority?: IssuePriority;
  markAsRead?: boolean;
}

export interface ConfigMailbox {
  name?: string;
  key?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  user?: string;
  pass?: string;
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
}
