/**
 * Pure helpers for the notification watch: turn one GitHub notification thread
 * (plus the latest comment and subject state, when fetched) into the text of a
 * Paperclip task. No I/O lives here, so every rule is unit-testable.
 */

export interface GithubNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: {
    title: string;
    type: string;
    url: string | null;
    latest_comment_url: string | null;
  };
  repository: { full_name: string; html_url: string };
}

export interface LatestComment {
  author: string | null;
  body: string;
  htmlUrl: string | null;
}

export interface SubjectState {
  state: string | null;
  merged: boolean;
  htmlUrl: string | null;
}

export interface NotificationDetail {
  notification: GithubNotification;
  comment: LatestComment | null;
  subject: SubjectState | null;
}

export interface WatchedTask {
  title: string;
  body: string;
  isRequest: boolean;
}

const REASON_TEXT: Record<string, string> = {
  assign: "You were assigned",
  author: "Activity on something you opened",
  comment: "Activity on a thread you commented on",
  ci_activity: "A GitHub Actions run you triggered finished",
  mention: "You were @mentioned",
  team_mention: "Your team was @mentioned",
  review_requested: "Your review was requested",
  state_change: "Something you follow was opened, closed or merged",
  subscribed: "Activity on something you watch",
  manual: "Activity on a thread you subscribed to",
  approval_requested: "A deployment needs your approval",
  security_alert: "GitHub raised a security alert",
};

const MAX_QUOTED_CHARS = 4000;

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? `GitHub notification (${reason})`;
}

/** `https://api.github.com/repos/o/r/issues/12` → 12, or null for non-numbered subjects. */
export function subjectNumber(apiUrl: string | null): number | null {
  const match = apiUrl?.match(/\/(?:issues|pulls)\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Browser link for the thread, derived without an extra API call. */
export function subjectHtmlUrl(notification: GithubNotification): string {
  const apiUrl = notification.subject.url;
  const repoUrl = notification.repository.html_url;
  const number = subjectNumber(apiUrl);
  if (number === null) {
    return notification.subject.type === "CheckSuite" ? `${repoUrl}/actions` : repoUrl;
  }
  const kind = apiUrl?.includes("/pulls/") ? "pull" : "issues";
  return `${repoUrl}/${kind}/${number}`;
}

/** The latest comment is new activity only when it is not the subject itself. */
export function hasNewComment(notification: GithubNotification): boolean {
  const { url, latest_comment_url: latest } = notification.subject;
  return !!latest && latest !== url;
}

export function threadLabel(notification: GithubNotification): string {
  const number = subjectNumber(notification.subject.url);
  const repo = notification.repository.full_name;
  return number === null ? repo : `${repo}#${number}`;
}

export function buildTaskTitle(notification: GithubNotification): string {
  return `GitHub: ${threadLabel(notification)} ${notification.subject.title}`.slice(0, 200);
}

function sameLogin(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

/** True when the newest activity is the watched user's own comment. */
export function isOwnActivity(detail: NotificationDetail, watchedLogin: string): boolean {
  return sameLogin(detail.comment?.author, watchedLogin);
}

function describeSubjectState(subject: SubjectState | null): string | null {
  if (!subject) return null;
  if (subject.merged) return "Merged.";
  if (subject.state === "closed") return "Closed.";
  return null;
}

function quote(text: string): string {
  const trimmed = text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text;
  return trimmed
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * Builds the task (or follow-up comment) text. Comment bodies are quoted and
 * labelled as untrusted: only a trusted login's comment is flagged as a
 * request, and nothing in the body is ever treated as an instruction here.
 */
export function describeNotification(
  detail: NotificationDetail,
  trustedLogins: string[],
): WatchedTask {
  const { notification, comment, subject } = detail;
  const link = comment?.htmlUrl ?? subject?.htmlUrl ?? subjectHtmlUrl(notification);
  const author = comment?.author ?? null;
  const isRequest = trustedLogins.some((login) => sameLogin(author, login));

  const lines = [
    `**${reasonText(notification.reason)}** on [${threadLabel(notification)}](${link}): ${notification.subject.title}`,
  ];
  const stateLine = describeSubjectState(subject);
  if (stateLine) lines.push("", stateLine);
  if (comment) {
    const who = author ? `@${author}` : "someone";
    lines.push(
      "",
      isRequest
        ? `Request from ${who} (trusted). Their comment:`
        : `Information only, from ${who}. Not a request. Their comment:`,
      "",
      quote(comment.body || "(empty comment)"),
    );
  }
  lines.push("", `Updated ${notification.updated_at}. Open on GitHub: ${link}`);

  return { title: buildTaskTitle(notification), body: lines.join("\n"), isRequest };
}

export function repoAllowed(fullName: string, repos: string[] | undefined): boolean {
  if (!repos || repos.length === 0) return true;
  return repos.some((repo) => repo.toLowerCase() === fullName.toLowerCase());
}

/** Oldest first, so tasks and follow-up comments land in the order they happened. */
export function sortOldestFirst(notifications: GithubNotification[]): GithubNotification[] {
  return [...notifications].sort((a, b) => a.updated_at.localeCompare(b.updated_at));
}
