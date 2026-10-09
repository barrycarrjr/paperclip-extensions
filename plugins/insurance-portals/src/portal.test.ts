/**
 * End-to-end run against a fake portal on 127.0.0.1, in real Chrome.
 * Skipped when Chrome is not installed.
 *
 * The fake portal copies the shapes seen on the real sign-in pages: a cookie
 * banner, user name then password on separate pages (Foremost), a "Send
 * Email / Send Text" choice with four code boxes (Selective), and a policy
 * page. It also carries traps that a read-only run must never trigger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Browser, findChrome } from "./cdp.js";
import { runCarrier, type CarrierProfile } from "./portal.js";

function pdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.4\n% ${tag}\n${"x".repeat(200)}\n%%EOF\n`, "latin1");
}

const page = (body: string) =>
  `<!doctype html><html><head><title>Fake</title></head><body>${body}</body></html>`;

let chrome: string | null = null;
try {
  chrome = findChrome();
} catch {
  chrome = null;
}

test("signs in, uses the emailed code, saves documents and trips no trap", { skip: !chrome, timeout: 120_000 }, async () => {
  const hits: string[] = [];
  let passwordPosts = 0;
  let codeSent = false;
  let signedIn = false;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, html: string, type = "text/html") => {
        res.writeHead(status, { "content-type": type });
        res.end(html);
      };
      const p = url.pathname;
      if (p === "/login") {
        return send(
          200,
          page(`<div id="banner"><button id="onetrust-reject-all-handler" onclick="this.parentNode.remove()">Reject</button><button>Accept</button></div>
          <form action="/password" method="get"><label for="u">Email</label><input id="u" type="email" name="username"><button type="submit">Continue</button></form>
          <a href="/pay">Pay Bill</a>`),
        );
      }
      if (p === "/password") {
        return send(
          200,
          page(`<form action="/session" method="post"><input type="hidden" name="username" value="${url.searchParams.get("username") ?? ""}">
          <label for="pw">Password</label><input id="pw" type="password" name="password"><button type="submit">Log in</button></form>`),
        );
      }
      if (p === "/session" && req.method === "POST") {
        passwordPosts++;
        const f = new URLSearchParams(body);
        if (f.get("username") !== "me@example.com" || f.get("password") !== "s3cret!") {
          return send(200, page(`<div role="alert">Incorrect user name or password</div><input type="password">`));
        }
        res.writeHead(302, { location: "/mfa" });
        return res.end();
      }
      if (p === "/mfa") {
        return send(
          200,
          page(`<h1>Verify your identity</h1><p>We will send you a security code.</p>
          <div id="choose"><input type="button" id="frmLogin_btnSendEmail" value="Send Email" onclick="fetch('/send-code',{method:'POST'}).then(()=>{document.getElementById('choose').style.display='none';document.getElementById('boxes').style.display='block'})">
          <input type="button" value="Send Text" onclick="fetch('/send-text',{method:'POST'})"></div>
          <div id="boxes" style="display:none"><input id="frmLogin_txtCode1" maxlength="1"><input id="frmLogin_txtCode2" maxlength="1"><input id="frmLogin_txtCode3" maxlength="1"><input id="frmLogin_txtCode4" maxlength="1">
          <input type="button" value="Next" onclick="const c=[1,2,3,4].map(i=>document.getElementById('frmLogin_txtCode'+i).value).join('');fetch('/verify?code='+c,{method:'POST'}).then(r=>r.ok?location.href='/home':alert('bad'))"></div>`),
        );
      }
      if (p === "/send-code") {
        codeSent = true;
        return send(200, "ok", "text/plain");
      }
      if (p === "/verify") {
        signedIn = url.searchParams.get("code") === "4821";
        return send(signedIn ? 200 : 400, "", "text/plain");
      }
      if (!signedIn) return send(403, "no");
      if (p === "/home") {
        return send(
          200,
          page(`<nav><a href="/policies">My Policies</a> <a href="/pay">Make a Payment</a> <a href="/logout">Log out</a></nav>`),
        );
      }
      if (p === "/policies") {
        // A write the page fires on its own once signed in: the guard must stop it.
        return send(200, page(`<ul><li>Home policy H-1 <a href="/policy/1">Policy details</a></li></ul><script>fetch('/api/profile/update',{method:'POST',body:'{}'})</script>`));
      }
      if (p === "/policy/1") {
        return send(
          200,
          page(`<section><h2>Home policy H-1</h2>
          <a href="/docs/dec.pdf">Declarations Page</a>
          <button onclick="fetch('/docs/packet.pdf').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='packet.pdf';document.body.appendChild(a);a.click()})">Policy Documents</button>
          <button onclick="fetch('/api/preferences/paperless',{method:'POST'})">Change paperless policy documents</button>
          <a href="/pay">Pay now</a></section>
          <table><tr><td>Umbrella policy U-9</td><td><button onclick="window.open('/docs/umbrella.pdf')">View PDF</button></td></tr></table>`),
        );
      }
      if (p === "/docs/dec.pdf") return send(200, pdf("dec") as unknown as string, "application/pdf");
      if (p === "/docs/packet.pdf") return send(200, pdf("packet") as unknown as string, "application/pdf");
      if (p === "/docs/umbrella.pdf") return send(200, pdf("umbrella") as unknown as string, "application/pdf");
      return send(404, "not found");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  const carrier: CarrierProfile = {
    key: "selective",
    name: "Fake",
    loginUrl: `http://127.0.0.1:${port}/login`,
    siteDomains: ["127.0.0.1"],
    senderDomains: ["example.com"],
  };

  let codeRequestedAt: Date | null = null;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    const result = await runCarrier(browser, carrier, {
      username: "me@example.com",
      password: "s3cret!",
      getCode: async (since) => {
        codeRequestedAt = since;
        assert.equal(codeSent, true, "code asked for only after choosing email");
        return "4821";
      },
      deadline: Date.now() + 110_000,
      maxDocuments: 10,
      debugDir: process.env.PC_DEBUG_DIR ?? null,
      log: process.env.PC_DEBUG_DIR ? (s) => console.log("step", s) : () => undefined,
    });

    if (process.env.PC_DEBUG_DIR) console.log(hits);
    const tags = result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]).sort();
    assert.deepEqual(tags, ["% dec", "% packet", "% umbrella"]);
    assert.ok(codeRequestedAt, "code was requested");
    assert.equal(passwordPosts, 1, "password submitted exactly once");
    assert.ok(!hits.includes("POST /send-text"), "never chose text message");
    assert.ok(!hits.some((h) => h.endsWith(" /pay")), "never opened the payment page");
    assert.ok(!hits.some((h) => h.endsWith(" /logout")), "never signed out mid-run");
    assert.ok(!hits.includes("POST /api/preferences/paperless"), "never clicked the change button");
    assert.ok(!hits.includes("POST /api/profile/update"), "background write was blocked");
    assert.ok(result.blockedRequests >= 1, "guard reported the block");
    const labels = result.documents.map((d) => d.label);
    assert.ok(labels.includes("Declarations Page"));
    assert.ok(labels.some((l) => /Umbrella policy U-9/.test(l)), `contextual label: ${labels.join(" | ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("a wrong password stops the run after one try", { skip: !chrome, timeout: 90_000 }, async () => {
  let posts = 0;
  const server = createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (p === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<form action="/session" method="post"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Sign in</button></form>`));
    }
    if (p === "/session") {
      posts++;
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<div class="error">Incorrect username or password</div><form action="/session" method="post"><input name="username"><input type="password" name="password"><button type="submit">Sign in</button></form>`));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await assert.rejects(
      runCarrier(
        browser,
        { key: "foremost", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
        {
          username: "u",
          password: "wrong",
          getCode: async () => "0000",
          deadline: Date.now() + 80_000,
          maxDocuments: 5,
          debugDir: null,
          log: () => undefined,
        },
      ),
      /ELOGIN_REJECTED/,
    );
    assert.equal(posts, 1);
  } finally {
    await browser.close();
    server.close();
  }
});

test("radio-style code choice: picks Email, sends, enters a 6-digit code", { skip: !chrome, timeout: 90_000 }, async () => {
  const hits: string[] = [];
  let ok = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") {
      return html(`<form action="/mfa" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Sign in</button></form>`);
    }
    if (url.pathname === "/mfa") {
      return html(`<h1>Verify it's you</h1><p>How should we send your code?</p>
        <form action="/enter" method="get"><label><input type="radio" name="m" value="sms" checked> Text me</label>
        <label><input type="radio" name="m" value="email"> Email</label><button type="submit">Send code</button></form>`);
    }
    if (url.pathname === "/enter") {
      return html(`<form action="/check" method="get"><input type="hidden" name="m" value="${url.searchParams.get("m")}"><label for="c">Enter code</label><input id="c" name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form>`);
    }
    if (url.pathname === "/check") {
      ok = url.searchParams.get("code") === "739204" && url.searchParams.get("m") === "email";
      return html(ok ? `<a href="/logout">Sign out</a><p>Welcome</p>` : `<div role="alert">Invalid code</div>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    const result = await runCarrier(
      browser,
      { key: "liberty_mutual", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      {
        username: "u",
        password: "p",
        getCode: async () => "739204",
        deadline: Date.now() + 80_000,
        maxDocuments: 5,
        debugDir: null,
        log: () => undefined,
      },
    );
    assert.equal(ok, true, `signed in with email code; hits: ${hits.join(", ")}`);
    assert.equal(result.documents.length, 0);
    assert.ok(result.notes.some((n) => /no policy or declarations PDFs/.test(n)));
    assert.ok(!hits.some((h) => h.startsWith("GET /logout")), "never signed out");
  } finally {
    await browser.close();
    server.close();
  }
});

test("slow password step on the same page (Foremost-style) is waited for, not re-submitted", { skip: !chrome, timeout: 90_000 }, async () => {
  let usernameClicks = 0;
  let signedIn = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/fmcss/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<div id="ot"><button id="onetrust-reject-all-handler" onclick="document.getElementById('ot').remove()">Reject</button><button>Accept</button></div>
        <h1>Log in</h1><form onsubmit="event.preventDefault()">
        <input type="email" id="usernameInputField" placeholder="Username/email*">
        <label><input type="checkbox" checked> Save username</label>
        <div id="pw"></div>
        <button type="submit" id="go" onclick="fetch('/u',{method:'POST'});setTimeout(()=>{document.getElementById('pw').innerHTML='<input type=password id=pass placeholder=Password>';document.getElementById('go').textContent='Log in';document.getElementById('go').onclick=()=>{fetch('/p?v='+encodeURIComponent(document.getElementById('pass').value),{method:'POST'}).then(()=>location.href='/home')}},4000)">Continue</button></form>`));
    }
    if (url.pathname === "/u") {
      usernameClicks++;
      return res.writeHead(200).end();
    }
    if (url.pathname === "/p") {
      signedIn = url.searchParams.get("v") === "pw";
      return res.writeHead(200).end();
    }
    if (url.pathname === "/home") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(signedIn ? `<a href="/logout">Log out</a>` : `no`));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await runCarrier(
      browser,
      { key: "foremost", name: "Fake", loginUrl: `http://127.0.0.1:${port}/fmcss/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "me@example.com", password: "pw", getCode: async () => "0000", deadline: Date.now() + 80_000, maxDocuments: 5, debugDir: null, log: () => undefined },
    );
    assert.equal(signedIn, true);
    assert.equal(usernameClicks, 1, "Continue clicked once, then waited");
  } finally {
    await browser.close();
    server.close();
  }
});

test("waits out a loading screen after sign-in before looking for documents", { skip: !chrome, timeout: 120_000 }, async () => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") {
      return html(`<form action="/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/home") {
      return html(`<header><a href="/">Logo</a></header>
        <div id="wait" style="position:fixed;inset:0;background:rgba(0,0,0,0.5)"><div class="spinner" style="width:80px;height:80px;margin:300px auto;border:6px solid red;border-radius:50%"></div></div>
        <main id="main"></main><footer><a href="/terms">Terms of use</a><a href="/privacy">Privacy policy</a></footer>
        <script>setTimeout(()=>{document.getElementById('wait').remove();document.getElementById('main').innerHTML=
          '<nav><a href="/home">Home</a> <a href="/bill">Billing</a> <a href="/claims">Claims</a> <a href="/logout">Log out</a></nav>'+
          '<section><h2>Landlord policy</h2><a href="/docs/dec.pdf">View declarations page</a></section>'},25000)</script>`);
    }
    if (url.pathname === "/docs/dec.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf("late-dec"));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    const result = await runCarrier(
      browser,
      { key: "foremost", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "u", password: "p", getCode: async () => "0000", deadline: Date.now() + 110_000, maxDocuments: 5, debugDir: null, log: (s) => process.env.PC_TRACE && console.log(Date.now() % 100000, "step", s) },
    );
    assert.deepEqual(result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]), ["% late-dec"]);
  } finally {
    await browser.close();
    server.close();
  }
});
