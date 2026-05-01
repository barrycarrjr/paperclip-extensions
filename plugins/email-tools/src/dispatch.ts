import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { ParsedMessage } from "./imap.js";
import type { ConfigMailbox } from "./types.js";

export function passesFilter(parsed: ParsedMessage, mailbox: ConfigMailbox): boolean {
  const fromFilters = mailbox.filterFromContains ?? [];
  if (fromFilters.length > 0) {
    const haystack = (parsed.from + " " + (parsed.fromAddress ?? "")).toLowerCase();
    if (!fromFilters.some((f) => haystack.includes(f.toLowerCase()))) return false;
  }
  const subjFilters = mailbox.filterSubjectContains ?? [];
  if (subjFilters.length > 0) {
    const subj = (parsed.subject ?? "").toLowerCase();
    if (!subjFilters.some((f) => subj.includes(f.toLowerCase()))) return false;
  }
  return true;
}

export async function dispatchReceived(
  ctx: PluginContext,
  mailbox: ConfigMailbox,
  parsed: ParsedMessage,
): Promise<void> {
  const mode = mailbox.onReceive?.mode ?? "none";
  const companyId = mailbox.ingestCompanyId;
  if (!companyId) return;

  if (mode === "event") {
    await ctx.events.emit("email.received", companyId, {
      mailbox: mailbox.key,
      uid: parsed.uid,
      messageId: parsed.messageId,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      date: parsed.date,
      snippet: parsed.text.replace(/\s+/g, " ").trim().slice(0, 280),
      hasAttachments: parsed.attachments.length > 0,
    });
  } else if (mode === "issue") {
    if (!mailbox.onReceive?.projectId) {
      ctx.logger.warn("email-tools: skipping issue dispatch — onReceive.projectId not set", {
        mailbox: mailbox.key,
      });
      return;
    }
    const description = buildIssueDescription(parsed);
    const priority = mailbox.onReceive.defaultPriority ?? "medium";
    await ctx.issues.create({
      companyId,
      projectId: mailbox.onReceive.projectId,
      title: parsed.subject || "(no subject)",
      description,
      assigneeAgentId: mailbox.onReceive.assigneeAgentId,
      priority,
      originKind: `plugin:email-tools`,
      originId: parsed.messageId ?? `uid-${parsed.uid}`,
    });
  }
  // mode "none" — no-op; agents pull on demand

  await ctx.telemetry.track("email-received", {
    mailbox: mailbox.key ?? "",
    uid: String(parsed.uid),
    mode,
    companyId,
  });
}

const ISSUE_BODY_MAX = 16_000;

function buildIssueDescription(parsed: ParsedMessage): string {
  const header = [
    `**From:** ${parsed.from || "(unknown)"}`,
    `**To:** ${parsed.to.join(", ") || "(unknown)"}`,
    parsed.cc.length > 0 ? `**Cc:** ${parsed.cc.join(", ")}` : null,
    `**Date:** ${parsed.date}`,
    `**Message-ID:** ${parsed.messageId ?? "(none)"}`,
  ]
    .filter(Boolean)
    .join("  \n");

  const attachmentBlock =
    parsed.attachments.length > 0
      ? "\n\n**Attachments:**\n" +
        parsed.attachments.map((a) => `- ${a.name} (${a.mime}, ${a.size} bytes, partId \`${a.partId}\`)`).join("\n")
      : "";

  let body = parsed.markdown || parsed.text || "_(no body)_";
  if (body.length > ISSUE_BODY_MAX) {
    body = body.slice(0, ISSUE_BODY_MAX) + "\n\n_…body truncated…_";
  }

  return `${header}\n\n---\n\n${body}${attachmentBlock}`;
}
