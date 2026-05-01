import nodemailer from "nodemailer";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { openConnection, safeLogout, type MailboxRuntime } from "./imap.js";
import type { ConfigMailbox } from "./types.js";

export interface TestCheck {
  name: string;
  passed: boolean;
  message: string;
  durationMs?: number;
}

export interface TestResult {
  ok: boolean;
  mailbox: string;
  checks: TestCheck[];
}

function deriveSmtpHost(imapHost: string): string {
  return imapHost.startsWith("imap.") ? "smtp." + imapHost.slice(5) : imapHost;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; durationMs: number }> {
  const start = Date.now();
  const result = await fn();
  return { result, durationMs: Date.now() - start };
}

export async function testMailbox(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  mailboxKey: string,
): Promise<TestResult> {
  const checks: TestCheck[] = [];

  // 1. Resolve the secret
  let resolvedPass: string | null = null;
  try {
    if (!cfg.pass) throw new Error("password secret-ref is empty");
    const { result, durationMs } = await timed(() => ctx.secrets.resolve(cfg.pass as string));
    resolvedPass = result;
    checks.push({
      name: "secret",
      passed: true,
      message: `Resolved password secret (${result.length} chars)`,
      durationMs,
    });
  } catch (err) {
    checks.push({
      name: "secret",
      passed: false,
      message: `Could not resolve secret: ${(err as Error).message}`,
    });
    return { ok: false, mailbox: mailboxKey, checks };
  }

  // 2. IMAP connect + auth + select pollFolder
  const folder = cfg.pollFolder ?? "INBOX";
  try {
    if (!cfg.imapHost) throw new Error("imapHost is empty");
    if (!cfg.user) throw new Error("user is empty");
    const imapPort = typeof cfg.imapPort === "number" ? cfg.imapPort : 993;
    const imapSecure = typeof cfg.imapSecure === "boolean" ? cfg.imapSecure : imapPort === 993;
    const rt: MailboxRuntime = {
      key: mailboxKey,
      user: cfg.user,
      pass: resolvedPass,
      imapHost: cfg.imapHost,
      imapPort,
      imapSecure,
      pollFolder: folder,
    };
    const { result: client, durationMs: connectMs } = await timed(() => openConnection(rt));
    checks.push({
      name: "imap.connect",
      passed: true,
      message: `Connected + authenticated to ${rt.imapHost}:${rt.imapPort} as ${rt.user}`,
      durationMs: connectMs,
    });
    try {
      const { result: lock, durationMs: openMs } = await timed(() => client.getMailboxLock(folder));
      try {
        const mb = client.mailbox;
        const exists = mb && typeof mb !== "boolean" ? mb.exists : 0;
        checks.push({
          name: "imap.folder",
          passed: true,
          message: `Folder "${folder}" exists (${exists} message${exists === 1 ? "" : "s"})`,
          durationMs: openMs,
        });
      } finally {
        lock.release();
      }
    } catch (err) {
      checks.push({
        name: "imap.folder",
        passed: false,
        message: `Could not open folder "${folder}": ${(err as Error).message}`,
      });
    } finally {
      await safeLogout(client);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string; authenticationFailed?: boolean };
    const code = e.code ?? (e.authenticationFailed ? "AUTHENTICATIONFAILED" : "IMAP_ERROR");
    checks.push({
      name: "imap.connect",
      passed: false,
      message: `[${code}] ${e.message ?? String(err)}`,
    });
  }

  // 3. SMTP connect + auth (nodemailer.verify())
  try {
    const smtpPort = typeof cfg.smtpPort === "number" ? cfg.smtpPort : 465;
    const smtpSecure = typeof cfg.smtpSecure === "boolean" ? cfg.smtpSecure : smtpPort === 465;
    const smtpHost = cfg.smtpHost ?? deriveSmtpHost(cfg.imapHost ?? "");
    const smtpUser = cfg.smtpUser ?? cfg.user ?? "";
    if (!smtpHost) throw new Error("smtpHost could not be derived (imapHost is empty)");
    if (!smtpUser) throw new Error("smtpUser/user is empty");

    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: resolvedPass },
    });
    try {
      const { durationMs } = await timed(() => transporter.verify());
      checks.push({
        name: "smtp.connect",
        passed: true,
        message: `Connected + authenticated to ${smtpHost}:${smtpPort} as ${smtpUser}`,
        durationMs,
      });
    } finally {
      transporter.close();
    }
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    const code = e.code ?? "SMTP_ERROR";
    const resp = e.responseCode ? ` (SMTP ${e.responseCode})` : "";
    checks.push({
      name: "smtp.connect",
      passed: false,
      message: `[${code}] ${e.message ?? String(err)}${resp}`,
    });
  }

  const ok = checks.every((c) => c.passed);
  await ctx.telemetry.track("test-mailbox", {
    mailbox: mailboxKey,
    ok: String(ok),
    failed: checks.filter((c) => !c.passed).map((c) => c.name).join(",") || "none",
  });

  return { ok, mailbox: mailboxKey, checks };
}
