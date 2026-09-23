import nodemailer from "nodemailer";
import type { ImapFlow } from "imapflow";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { openConnection, safeLogout, type MailboxRuntime } from "./imap.js";
import { getAccessToken } from "./oauth.js";
import { providerFilingSentCopy, resolveSentFolder } from "./sent-copy.js";
import { nonBlank, resolveSmtpHost } from "./smtp-identity.js";
import type { ConfigMailbox, InstanceConfig } from "./types.js";

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

/**
 * Which of the replied and forwarded marks this server keeps. The replied
 * mark is a standard flag every server stores; the forwarded one is a keyword,
 * and a server that stores no keywords drops it.
 */
export function markSupportCheck(permanentFlags: Set<string> | undefined): TestCheck {
  const name = "imap.marks";
  if (!permanentFlags) {
    return { name, passed: true, message: "The server did not list the flags it keeps; marks are checked after each reply or forward." };
  }
  // An empty list is an answer, not a silence: this folder keeps no flags.
  if (permanentFlags.size === 0) {
    return { name, passed: true, message: "The server keeps no flags in this folder, so replies and forwards cannot be marked here." };
  }
  const listed = [...permanentFlags].join(" ");
  if (permanentFlags.has("\\*") || [...permanentFlags].some((f) => f.toLowerCase() === "$forwarded")) {
    return { name, passed: true, message: `Replied and forwarded marks can both be kept (server keeps: ${listed}).` };
  }
  return {
    name,
    passed: true,
    message: `The server keeps only these flags, so no forwarded mark: ${listed}.`,
  };
}

/**
 * Where copies of sent mail will be saved. A mailbox that cannot keep a copy
 * still sends, but the operator then cannot find what was sent, which is
 * exactly the failure this check is here to show before it happens.
 */
export async function sentFolderCheck(client: ImapFlow, cfg: ConfigMailbox): Promise<TestCheck> {
  const name = "imap.sent-folder";
  const start = Date.now();
  try {
    const filedBy = nonBlank(cfg.sentFolder)
      ? null
      : providerFilingSentCopy(resolveSmtpHost(cfg), cfg.authType);
    if (filedBy) {
      return {
        name,
        passed: true,
        message: `${filedBy} keeps its own copy of sent mail, so none is uploaded`,
        durationMs: Date.now() - start,
      };
    }
    const picked = await resolveSentFolder(client, cfg.sentFolder);
    if (!picked) {
      return {
        name,
        passed: false,
        message: "No Sent folder found, so copies of sent mail cannot be saved. Name one in 'Sent folder'.",
        durationMs: Date.now() - start,
      };
    }
    // Asking for its size also proves it exists: a name typed into 'Sent
    // folder' is otherwise taken on trust until the first send fails.
    // imapflow answers false, not a throw, when the server refuses; that is
    // "unknown", and printing it as 0 would invite someone to "fix" the choice.
    const status = (await client.status(picked.path, { messages: true })) as { messages?: number } | false;
    if (!status || typeof status.messages !== "number") {
      // A folder found by listing the mailbox exists, so this is only a
      // server that will not count it. A typed name is another matter.
      const typed = !!nonBlank(cfg.sentFolder);
      return {
        name,
        passed: !typed,
        message: typed
          ? `The server would not open "${picked.path}", the folder named in 'Sent folder'. Check the name: copies of sent mail cannot be saved until it is right.`
          : `Copies of sent mail go to "${picked.path}" (the server would not say how many messages it holds): ${picked.reason}.`,
        durationMs: Date.now() - start,
      };
    }
    return {
      name,
      passed: true,
      message: `Copies of sent mail go to "${picked.path}" (${status.messages} message${status.messages === 1 ? "" : "s"}): ${picked.reason}.`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      message: `Could not check the Sent folder: ${(err as Error).message}`,
      durationMs: Date.now() - start,
    };
  }
}

export async function testMailbox(
  ctx: PluginContext,
  cfg: ConfigMailbox,
  mailboxKey: string,
): Promise<TestResult> {
  const checks: TestCheck[] = [];

  // 1. Resolve credentials — OAuth access token or basic app password.
  const isOAuth = cfg.authType === "oauth2";
  let resolvedPass: string | null = null;
  let accessToken: string | undefined;
  try {
    if (isOAuth) {
      const clientId = ((await ctx.config.get()) as InstanceConfig).oauthMicrosoftClientId;
      if (!clientId) throw new Error("Microsoft OAuth Client ID is not set on the plugin settings page");
      const { result, durationMs } = await timed(() => getAccessToken(ctx, { clientId, mailboxKey }));
      accessToken = result;
      checks.push({
        name: "oauth",
        passed: true,
        message: `Acquired OAuth access token (${result.length} chars)`,
        durationMs,
      });
    } else {
      if (!cfg.pass) throw new Error("password secret-ref is empty");
      const { result, durationMs } = await timed(() => ctx.secrets.resolve(cfg.pass as string));
      resolvedPass = result;
      checks.push({
        name: "secret",
        passed: true,
        message: `Resolved password secret (${result.length} chars)`,
        durationMs,
      });
    }
  } catch (err) {
    checks.push({
      name: isOAuth ? "oauth" : "secret",
      passed: false,
      message: isOAuth
        ? `Could not get OAuth token (is the mailbox connected? open the Connect URL): ${(err as Error).message}`
        : `Could not resolve secret: ${(err as Error).message}`,
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
      pass: resolvedPass ?? "",
      accessToken,
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
        checks.push(markSupportCheck(mb && typeof mb !== "boolean" ? mb.permanentFlags : undefined));
      } finally {
        lock.release();
      }
      checks.push(await sentFolderCheck(client, cfg));
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

    const transporter = accessToken
      ? nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          auth: { type: "OAuth2", user: smtpUser, accessToken },
        })
      : nodemailer.createTransport({
          host: smtpHost,
          port: smtpPort,
          secure: smtpSecure,
          auth: { user: smtpUser, pass: resolvedPass ?? "" },
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
