/**
 * The reply box, on the task itself.
 *
 * A review task used to be a dead end: it showed the review and a suggested
 * reply, and replying meant leaving for the Reviews page. This puts the same
 * editor on the task, so the reply is written and sent where the person
 * already is.
 *
 * It is the same component as the Reviews page uses, not a second one, so
 * every rule about posting (the master switch, the live check against
 * Google, the confirm panel, the audit row, one attempt at a time) is the
 * same here by construction rather than by being copied.
 *
 * The host filters tabs by entity type only, so this tab appears on every
 * task in the company. On a task that is not a review it says so in one
 * line rather than showing a box that cannot work.
 */
import type { CSSProperties } from "react";
import { useHostContext, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import { ReviewEditor } from "./ReviewEditor.js";
import { describeReplyError } from "./replyErrors.js";
import { ErrorNote, Note, mutedText } from "./shared.js";

interface ReviewForIssue {
  reviewName: string | null;
  /** Present when there is a review but it cannot be opened yet. */
  reason?: string;
}

export function ReviewReplyTab({ context }: PluginDetailTabProps) {
  const host = useHostContext();
  const companyId = context.companyId ?? host.companyId;
  const issueId = context.entityId;

  const { data, loading, error, refresh } = usePluginData<ReviewForIssue>("review-for-issue", {
    companyId,
    issueId,
  });

  if (!companyId) {
    return (
      <div style={tabRoot}>
        <p style={mutedText}>Open this task inside a company to reply to its review.</p>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div style={tabRoot}>
        <p style={mutedText}>Looking for this task&apos;s review...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={tabRoot}>
        <ErrorNote>{describeReplyError(error)}</ErrorNote>
      </div>
    );
  }

  if (!data?.reviewName) {
    return (
      <div style={tabRoot}>
        <Note>{data?.reason ?? "This task is not a customer review, so there is nothing to reply to here."}</Note>
      </div>
    );
  }

  return (
    <div style={tabRoot}>
      <ReviewEditor
        companyId={companyId}
        companyPrefix={context.companyPrefix ?? host.companyPrefix}
        reviewName={data.reviewName}
        // Posting from here closes this review's task, so the lookup is
        // re-read: the editor then shows the reply that is now on Google.
        onPosted={() => refresh()}
        onClose={() => refresh()}
        // There is no list to go back to on a task page.
        showClose={false}
      />
    </div>
  );
}

const tabRoot: CSSProperties = { display: "grid", gap: 12, padding: "12px 0", maxWidth: 760 };
