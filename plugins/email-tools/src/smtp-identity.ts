/**
 * Which addresses and hosts a mailbox sends as.
 *
 * Every one of these settings is optional on the settings page and documented
 * as "defaults to the mailbox's user". The defaulting used to be written as
 * `cfg.smtpFrom ?? cfg.user`, which only holds while an unused field is
 * absent. A field the operator opened and left empty is saved as an empty
 * string, and `??` passes an empty string straight through, so the mailbox
 * sent with no sender address at all. Gmail answers that with
 * `550 5.0.0 Sender is not allowed to send with empty mail_from`, which names
 * nothing the operator could connect to a settings field they had cleared.
 *
 * Kept out of the worker so the defaulting is unit-testable without an SMTP
 * server, and so there is one place that decides what "not set" means.
 */

/** A trimmed, non-empty string, or undefined for anything else. */
export function nonBlank(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** The mailbox settings that decide the outgoing identity. */
export interface SmtpIdentityConfig {
  /** Account address, and the fallback for the two optional fields below. */
  user?: string;
  /** IMAP host, used to derive an SMTP host when none is given. */
  imapHost?: string;
  smtpHost?: string;
  smtpUser?: string;
  smtpFrom?: string;
}

/** `imap.example.com` sends through `smtp.example.com`. */
export function deriveSmtpHost(imapHost: string): string {
  return imapHost.startsWith("imap.") ? "smtp." + imapHost.slice(5) : imapHost;
}

/** SMTP host to connect to: the configured one, else derived from the IMAP host. */
export function resolveSmtpHost(cfg: SmtpIdentityConfig): string {
  const configured = nonBlank(cfg.smtpHost);
  if (configured) return configured;
  return deriveSmtpHost(nonBlank(cfg.imapHost) ?? "");
}

/** Username to authenticate with: the configured one, else the account address. */
export function resolveSmtpUser(cfg: SmtpIdentityConfig): string {
  return nonBlank(cfg.smtpUser) ?? nonBlank(cfg.user) ?? "";
}

/** Address to send as: the configured one, else the account address. */
export function resolveSmtpFrom(cfg: SmtpIdentityConfig): string {
  return nonBlank(cfg.smtpFrom) ?? nonBlank(cfg.user) ?? "";
}

/**
 * Our own address, lower-cased, for dropping ourselves from a reply-all cc.
 *
 * Empty when the mailbox has no usable address at all. Callers must treat that
 * as "unknown" and keep every recipient: an empty needle makes `includes`
 * match everything, so filtering on it silently emptied the cc list instead of
 * removing one entry from it.
 */
export function resolveOwnAddress(cfg: SmtpIdentityConfig): string {
  return resolveSmtpFrom(cfg).toLowerCase();
}

/** Reply-all recipients, minus ourselves. */
export function withoutOwnAddress(addresses: string[], ownAddress: string): string[] {
  if (!ownAddress) return addresses;
  return addresses.filter((addr) => !addr.toLowerCase().includes(ownAddress));
}
