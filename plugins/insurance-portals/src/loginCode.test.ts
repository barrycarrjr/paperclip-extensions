/**
 * Runs the real IMAP client against a tiny fake IMAP server to prove the
 * mailbox limits: read-only open, envelopes only for search hits, and a body
 * downloaded for exactly one message (the newest from the carrier that
 * arrived after the code was requested).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { emailBodyText, setSettleMs, waitForLoginCode } from "./loginCode.js";

setSettleMs(300);

interface Msg {
  uid: number;
  from: string;
  date: Date;
  subject: string;
  body: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const imapDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${d.toISOString().slice(11, 19)} +0000`;

function raw(m: Msg): string {
  const over = rawOverride.current.get(m.uid);
  if (over) return over;
  return [
    `From: ${m.from}`,
    `To: me@example.com`,
    `Subject: ${m.subject}`,
    `Date: ${m.date.toUTCString()}`,
    `Message-ID: <${m.uid}@test>`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    m.body,
    ``,
  ].join("\r\n");
}

function envelope(m: Msg): string {
  const [user, host] = m.from.split("@");
  const addr = `((NIL NIL "${user}" "${host}"))`;
  return `("${m.date.toUTCString()}" "${m.subject}" ${addr} ${addr} ${addr} ((NIL NIL "me" "example.com")) NIL NIL NIL "<${m.uid}@test>")`;
}

function parseSet(set: string): number[] {
  const out: number[] = [];
  for (const part of set.split(",")) {
    const [a, b] = part.split(":");
    const lo = Number(a);
    const hi = b === undefined ? lo : b === "*" ? 1e9 : Number(b);
    for (const m of msgsRef.current) if (m.uid >= lo && m.uid <= hi) out.push(m.uid);
  }
  return out;
}
const msgsRef: { current: Msg[] } = { current: [] };

function fakeImap(messages: Msg[], log: string[]) {
  msgsRef.current = messages;
  return createServer((sock: Socket) => {
    sock.write("* OK [CAPABILITY IMAP4rev1] fake ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        const up = cmd.toUpperCase();
        log.push(up.startsWith("LOGIN") ? "LOGIN" : up);
        const ok = (t = "done") => sock.write(`${tag} OK ${t}\r\n`);
        if (up.startsWith("CAPABILITY")) {
          sock.write("* CAPABILITY IMAP4rev1\r\n");
          ok();
        } else if (up.startsWith("LOGIN")) {
          if (cmd.includes("app-pass")) ok();
          else sock.write(`${tag} NO [AUTHENTICATIONFAILED] bad\r\n`);
        } else if (up.startsWith("EXAMINE") || up.startsWith("SELECT")) {
          sock.write(`* ${messages.length} EXISTS\r\n* OK [UIDVALIDITY 7] ok\r\n* OK [UIDNEXT 100] ok\r\n* FLAGS (\\Seen)\r\n`);
          ok(up.startsWith("EXAMINE") ? "[READ-ONLY] examined" : "[READ-WRITE] selected");
        } else if (up.startsWith("UID SEARCH")) {
          const m = /FROM "?([^"\s]+)"?/i.exec(cmd);
          const needle = (m?.[1] ?? "").toLowerCase();
          const hits = messages.filter((x) => x.from.toLowerCase().includes(needle)).map((x) => x.uid);
          sock.write(`* SEARCH${hits.length ? " " + hits.join(" ") : ""}\r\n`);
          ok();
        } else if (up.startsWith("UID FETCH")) {
          const set = cmd.split(" ")[2];
          for (const uid of parseSet(set)) {
            const msg = messages.find((x) => x.uid === uid)!;
            const seq = messages.indexOf(msg) + 1;
            if (/BODY(\.PEEK)?\[\]/.test(up)) {
              const r = raw(msg);
              sock.write(`* ${seq} FETCH (UID ${uid} BODY[] {${Buffer.byteLength(r)}}\r\n${r})\r\n`);
            } else {
              sock.write(`* ${seq} FETCH (UID ${uid} INTERNALDATE "${imapDate(msg.date)}" ENVELOPE ${envelope(msg)})\r\n`);
            }
          }
          ok();
        } else if (up.startsWith("LOGOUT")) {
          sock.write("* BYE\r\n");
          ok();
          sock.end();
        } else {
          ok();
        }
      }
    });
    sock.on("error", () => undefined);
  });
}

/** Same fake server, but each message carries its own raw source. */
function fakeImapRaw(messages: Array<{ uid: number; from: string; date: Date; raw: string }>, log: string[]) {
  const asMsgs: Msg[] = messages.map((m) => ({ uid: m.uid, from: m.from, date: m.date, subject: "x", body: "" }));
  const server = fakeImap(asMsgs, log);
  rawOverride.current = new Map(messages.map((m) => [m.uid, m.raw]));
  return server;
}
const rawOverride: { current: Map<number, string> } = { current: new Map() };

test("reads only the newest carrier code, read-only", { timeout: 30_000 }, async () => {
  const requestedAt = new Date();
  const ago = (s: number) => new Date(requestedAt.getTime() + s * 1000);
  const messages: Msg[] = [
    { uid: 1, from: "noreply@libertymutual.com", date: ago(-3600), subject: "Your code", body: "Your code is 111111" },
    { uid: 2, from: "alerts@email.libertymutual.com", date: ago(20), subject: "Your code", body: "Your code is 555555" },
    { uid: 3, from: "noreply@libertymutual.com", date: ago(40), subject: "Your code", body: "Your verification code is 222222." },
    { uid: 4, from: "spoof@libertymutual.com.evil.io", date: ago(60), subject: "Your code", body: "Your code is 333333" },
    { uid: 5, from: "friend@gmail.com", date: ago(70), subject: "lunch", body: "code 444444" },
  ];
  const log: string[] = [];
  const server = fakeImap(messages, log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const code = await waitForLoginCode(
      { user: "me@example.com", password: "app-pass", host: "127.0.0.1", port: (server.address() as AddressInfo).port, folder: "INBOX", secure: false },
      ["libertymutual.com"],
      requestedAt,
      8_000,
    );
    assert.equal(code, "222222");
    assert.ok(log.some((l) => l.startsWith("EXAMINE")), "opened with EXAMINE");
    assert.ok(!log.some((l) => l.startsWith("SELECT")), "never SELECT (read-write)");
    assert.ok(!log.some((l) => /STORE|EXPUNGE|COPY|MOVE|APPEND|DELETE/.test(l)), "no write commands");
    const bodyFetches = log.filter((l) => /BODY(\.PEEK)?\[\]/.test(l));
    assert.ok(bodyFetches.length >= 1, "a body was read");
    assert.ok(bodyFetches.every((l) => / 3 /.test(l.replace("UID FETCH", ""))), `only message 3, the newest, was ever read: ${bodyFetches.join(" | ")}`);
    assert.ok(!bodyFetches[0].includes("BODY[]") || bodyFetches[0].includes("PEEK"), "body read with PEEK");
    const searchedFrom = log.filter((l) => l.startsWith("UID SEARCH"));
    assert.ok(searchedFrom.every((l) => /FROM "?LIBERTYMUTUAL\.COM"?/.test(l)), "search limited to the carrier");
  } finally {
    server.close();
  }
});

test("no new code from the carrier: times out without reading anything else", { timeout: 30_000 }, async () => {
  const requestedAt = new Date();
  const messages: Msg[] = [
    { uid: 1, from: "noreply@selective.com", date: new Date(requestedAt.getTime() - 3_600_000), subject: "code", body: "Your code is 9999" },
    { uid: 2, from: "friend@gmail.com", date: new Date(requestedAt.getTime() + 5_000), subject: "code", body: "Your code is 1234" },
  ];
  const log: string[] = [];
  const server = fakeImap(messages, log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      waitForLoginCode(
        { user: "me@example.com", password: "app-pass", host: "127.0.0.1", port: (server.address() as AddressInfo).port, folder: "INBOX", secure: false },
        ["selective.com"],
        requestedAt,
        4_000,
      ),
      /ECODE_TIMEOUT/,
    );
    assert.equal(log.filter((l) => /BODY(\.PEEK)?\[\]/.test(l)).length, 0, "no message body was downloaded");
  } finally {
    server.close();
  }
});

test("wrong app password reports a clear error", { timeout: 30_000 }, async () => {
  const log: string[] = [];
  const server = fakeImap([], log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await assert.rejects(
      waitForLoginCode(
        { user: "me@example.com", password: "nope", host: "127.0.0.1", port: (server.address() as AddressInfo).port, folder: "INBOX", secure: false },
        ["selective.com"],
        new Date(),
        4_000,
      ),
      /EMAIL_AUTH_FAILED/,
    );
  } finally {
    server.close();
  }
});

test("Selective: accepts AccountVerification@underwritingalerts.selective.com, ignores a look-alike", { timeout: 30_000 }, async () => {
  const requestedAt = new Date();
  const at = (s: number) => new Date(requestedAt.getTime() + s * 1000);
  const messages: Msg[] = [
    { uid: 1, from: "AccountVerification@underwritingalerts.selective.com", date: at(10), subject: "Your Selective verification code", body: "Your verification code is 4821." },
    { uid: 2, from: "AccountVerification@underwritingalerts.selective.com.evil.io", date: at(30), subject: "Your Selective verification code", body: "Your verification code is 9999." },
  ];
  const log: string[] = [];
  const server = fakeImap(messages, log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const code = await waitForLoginCode(
      { user: "me@example.com", password: "app-pass", host: "127.0.0.1", port: (server.address() as AddressInfo).port, folder: "INBOX", secure: false },
      ["selective.com"],
      requestedAt,
      8_000,
    );
    assert.equal(code, "4821");
    const bodies = log.filter((l) => /BODY(\.PEEK)?\[\]/.test(l));
    assert.ok(bodies.length >= 1 && bodies.every((l) => /UID FETCH 1 /.test(l)), "only the real Selective message was opened");
  } finally {
    server.close();
  }
});

test("Selective-style email: empty plain-text part, code only in the HTML (made-up code)", { timeout: 30_000 }, async () => {
  const requestedAt = new Date();
  const html = `<!DOCTYPE html><html><head><style type="text/css">
.hiddenHeader{display:none !important;font-size:0px;line-height:1px;top: -9999px;}
.bodyContentWhite { font-size: 14px; max-width: 680px; }</style></head>
<body><table><tr><td><span style="font-size: 13px">MySelective Password Reset</span></td></tr>
<tr><td><span style="font-size: 32px">MySelective </span></td></tr><tr><td><span>One-Time
Code</span></td></tr>
<tr><td><span>&#8201;</span></td></tr>
<tr><td><span style="font-size: 19px; line-height:23.00px">Here
is the One-Time Code.</span></td></tr>
<tr><td><span style="font-size: 16px">&#8201;</span></td></tr>
<tr><td><span style="font-size: 16px; font-weight: bold">3816</span></td></tr>
<tr><td><span>&#8201;</span></td></tr>
<tr><td><span>This is a single use code that expires in 10 minutes.</span></td></tr>
<tr><td><span>If you did not request this code, please contact us immediately at </span><a href="tel:18005550100"><span>800-555-0100</span></a></td></tr>
</table></body></html>`;
  const raw = [
    "From: \"Selective Insurance\" <AccountVerification@underwritingalerts.selective.com>",
    "To: ME@EXAMPLE.COM",
    "Subject: Here is Your MySelective One Time-Code",
    `Date: ${new Date(requestedAt.getTime() + 5000).toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "",
    "--b1",
    "Content-Transfer-Encoding: 7bit",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    html,
    "--b1--",
    "",
  ].join("\r\n");
  const log: string[] = [];
  const server = fakeImapRaw([{ uid: 9, from: "AccountVerification@underwritingalerts.selective.com", date: new Date(requestedAt.getTime() + 5000), raw }], log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const code = await waitForLoginCode(
      { user: "me@example.com", password: "app-pass", host: "127.0.0.1", port: (server.address() as AddressInfo).port, folder: "INBOX", secure: false },
      ["selective.com"],
      requestedAt,
      8_000,
    );
    assert.equal(code, "3816", "the code, not the &#8201; character code or a CSS number");
  } finally {
    server.close();
  }
});

test("emailBodyText uses the HTML when the plain part is blank, and decodes character codes", () => {
  assert.equal(emailBodyText("Your code is 1234", "<p>ignored</p>"), "Your code is 1234");
  const t = emailBodyText("\n", "<style>.a{font-size:0px}</style><p>Code&#8201;</p><td>5678</td>");
  assert.ok(!t.includes("8201") && !t.includes("font-size"), t);
  assert.ok(t.includes("5678"));
});

test("two codes a moment apart: waits and uses the later one (Selective)", { timeout: 30_000 }, async () => {
  const requestedAt = new Date();
  const messages: Msg[] = [
    { uid: 20, from: "AccountVerification@underwritingalerts.selective.com", date: new Date(requestedAt.getTime() + 2000), subject: "Code", body: "Here is the One-Time Code. 1111" },
  ];
  const log: string[] = [];
  const server = fakeImap(messages, log);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // The second email lands just after the first has been seen, in the same second.
  setTimeout(() => {
    messages.push({ uid: 21, from: "AccountVerification@underwritingalerts.selective.com", date: new Date(requestedAt.getTime() + 2000), subject: "Code", body: "Here is the One-Time Code. 2222" });
  }, 1300);
  setSettleMs(1500);
  try {
    const code = await waitForLoginCode(
      { user: "me@example.com", password: "app-pass", host: "127.0.0.1", port: (server.address() as AddressInfo).port, folder: "INBOX", secure: false },
      ["selective.com"],
      requestedAt,
      8_000,
    );
    assert.equal(code, "2222");
  } finally {
    setSettleMs(300);
    server.close();
  }
});
