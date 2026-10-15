import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type GithubNotification,
  buildTaskTitle,
  describeNotification,
  hasNewComment,
  isOwnActivity,
  newestCommentUrl,
  repoAllowed,
  sortOldestFirst,
  subjectHtmlUrl,
  subjectNumber,
} from "./notificationEvents.js";

function notification(overrides: Partial<GithubNotification> = {}): GithubNotification {
  return {
    id: "1001",
    reason: "author",
    updated_at: "2026-01-02T10:00:00Z",
    subject: {
      title: "Add a widget",
      type: "Issue",
      url: "https://api.github.com/repos/acme/app/issues/7",
      latest_comment_url: "https://api.github.com/repos/acme/app/issues/comments/55",
    },
    repository: { full_name: "acme/app", html_url: "https://github.com/acme/app" },
    ...overrides,
  };
}

test("subjectNumber reads issue and pull numbers", () => {
  assert.equal(subjectNumber("https://api.github.com/repos/acme/app/issues/7"), 7);
  assert.equal(subjectNumber("https://api.github.com/repos/acme/app/pulls/12"), 12);
  assert.equal(subjectNumber(null), null);
});

test("subjectHtmlUrl maps API urls to browser urls", () => {
  assert.equal(subjectHtmlUrl(notification()), "https://github.com/acme/app/issues/7");
  const pull = notification({
    subject: { ...notification().subject, type: "PullRequest", url: "https://api.github.com/repos/acme/app/pulls/12" },
  });
  assert.equal(subjectHtmlUrl(pull), "https://github.com/acme/app/pull/12");
  const checks = notification({ subject: { ...notification().subject, type: "CheckSuite", url: null } });
  assert.equal(subjectHtmlUrl(checks), "https://github.com/acme/app/actions");
});

test("hasNewComment is false when the latest activity is the subject itself", () => {
  assert.equal(hasNewComment(notification()), true);
  const bare = notification({
    subject: { ...notification().subject, latest_comment_url: "https://api.github.com/repos/acme/app/issues/7" },
  });
  assert.equal(hasNewComment(bare), false);
});

test("buildTaskTitle names the repo, number and title", () => {
  assert.equal(buildTaskTitle(notification()), "GitHub: acme/app#7 Add a widget");
});

test("trusted login comments are requests; others are information only", () => {
  const detail = {
    notification: notification(),
    comment: { author: "Maintainer", body: "Please rename it", htmlUrl: "https://github.com/acme/app/issues/7#c55" },
    subject: null,
  };
  const trusted = describeNotification(detail, ["maintainer"]);
  assert.equal(trusted.isRequest, true);
  assert.match(trusted.body, /Request from @Maintainer \(trusted\)/);
  assert.match(trusted.body, /> Please rename it/);

  const stranger = describeNotification(detail, ["someone-else"]);
  assert.equal(stranger.isRequest, false);
  assert.match(stranger.body, /Information only, from @Maintainer\. Not a request\./);
});

test("comment text is quoted line by line and truncated", () => {
  const detail = {
    notification: notification(),
    comment: { author: "x", body: `first\nsecond\n${"y".repeat(5000)}`, htmlUrl: null },
    subject: null,
  };
  const { body } = describeNotification(detail, []);
  assert.match(body, /> first\n> second/);
  assert.ok(body.includes("…"));
  assert.ok(body.length < 4500);
});

test("merged pull requests say so", () => {
  const detail = {
    notification: notification({ reason: "state_change" }),
    comment: null,
    subject: { state: "closed", merged: true, htmlUrl: "https://github.com/acme/app/pull/7", comments: 0 },
  };
  const { body } = describeNotification(detail, []);
  assert.match(body, /Merged\./);
  assert.match(body, /https:\/\/github.com\/acme\/app\/pull\/7/);
});

test("own comments are recognised case-insensitively", () => {
  const detail = { notification: notification(), comment: { author: "Me", body: "", htmlUrl: null }, subject: null };
  assert.equal(isOwnActivity(detail, "me"), true);
  assert.equal(isOwnActivity({ ...detail, comment: null }, "me"), false);
});

test("repoAllowed treats an empty list as every repo", () => {
  assert.equal(repoAllowed("acme/app", undefined), true);
  assert.equal(repoAllowed("acme/app", []), true);
  assert.equal(repoAllowed("Acme/App", ["acme/app"]), true);
  assert.equal(repoAllowed("acme/other", ["acme/app"]), false);
});

test("sortOldestFirst orders by update time without mutating input", () => {
  const later = notification({ id: "2", updated_at: "2026-01-03T00:00:00Z" });
  const earlier = notification({ id: "1", updated_at: "2026-01-01T00:00:00Z" });
  const input = [later, earlier];
  assert.deepEqual(sortOldestFirst(input).map((n) => n.id), ["1", "2"]);
  assert.equal(input[0].id, "2");
});

test("newestCommentUrl reads the last page of the conversation", () => {
  assert.equal(
    newestCommentUrl("https://api.github.com/repos/acme/app/pulls/7", 4),
    "https://api.github.com/repos/acme/app/issues/7/comments?per_page=1&page=4",
  );
  assert.equal(newestCommentUrl("https://api.github.com/repos/acme/app/issues/7", 0), null);
});
