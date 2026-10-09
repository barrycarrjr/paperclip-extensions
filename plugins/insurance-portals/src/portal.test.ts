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
          <button onclick="fetch('/docs/packet.pdf').then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='packet.pdf';document.body.appendChild(a);a.click()})">Policy packet (PDF)</button>
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

test("Foremost code page: picks Email, clicks 'Email me', never text or call", { skip: !chrome, timeout: 120_000 }, async () => {
  const hits: string[] = [];
  let ok = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}`);
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/fmcss/login") {
      return html(`<form action="/fmcss/login/mfa-enroll/abc" method="get"><input type="email" id="usernameInputField"><input type="password" placeholder="Enter password *"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/fmcss/login/mfa-enroll/abc") {
      return html(`<h1>Receive a one-time verification code</h1>
        <p>To make sure your data is secure, we're going to send a verification code. How would you like to receive it?</p>
        <b>Text or voice</b>
        <label><input type="radio" name="m" value="p1" checked onchange="pick()"> (•••) •••-0000</label>
        <label><input type="radio" name="m" value="p2" onchange="pick()"> (•••) •••-0000</label>
        <b>Email</b>
        <label><input type="radio" name="m" value="email" onchange="pick()"> m...e@example.com</label>
        <div id="btns"><button type="button" onclick="fetch('/send-text',{method:'POST'})">Send me a text</button><button type="button" onclick="fetch('/call',{method:'POST'})">Call me</button></div>
        <div id="code" style="display:none"><label for="c">Enter code</label><input id="c" autocomplete="one-time-code"><button type="button" onclick="fetch('/verify?c='+document.getElementById('c').value,{method:'POST'}).then(r=>r.ok?location.href='/home':0)">Verify</button></div>
        <script>function pick(){const e=document.querySelector('input[value=email]').checked;document.getElementById('btns').innerHTML=e?
          '<button type=button onclick="fetch(\\'/send-email\\',{method:\\'POST\\'}).then(()=>{document.getElementById(\\'btns\\').remove();document.getElementById(\\'code\\').style.display=\\'block\\'})">Email me</button>':
          '<button type=button onclick="fetch(\\'/send-text\\',{method:\\'POST\\'})">Send me a text</button><button type=button>Call me</button>'}</script>`);
    }
    if (url.pathname === "/verify") {
      ok = url.searchParams.get("c") === "246810";
      res.writeHead(ok ? 200 : 400);
      return res.end();
    }
    if (url.pathname === "/home") return html(`<nav><a href="/a">Home</a><a href="/b">Policies</a><a href="/c">Billing</a><a href="/logout">Log out</a></nav>`);
    res.writeHead(200).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await runCarrier(
      browser,
      { key: "foremost", name: "Fake", loginUrl: `http://127.0.0.1:${port}/fmcss/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "u@example.com", password: "p", getCode: async () => "246810", deadline: Date.now() + 110_000, maxDocuments: 5, debugDir: null, log: () => undefined },
    );
    assert.equal(ok, true, `signed in with the emailed code; hits: ${hits.join(", ")}`);
    assert.ok(hits.includes("POST /send-email"), "clicked Email me");
    assert.ok(!hits.includes("POST /send-text") && !hits.includes("POST /call"), "never text or call");
  } finally {
    await browser.close();
    server.close();
  }
});

test("kept profile: remembers the device, then skips the code, then skips sign-in", { skip: !chrome, timeout: 400_000 }, async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const profileDir = join(await mkdtemp(join(tmpdir(), "ip-profile-test-")), "foremost");
  let passwordPosts = 0;
  let codesAsked = 0;
  let keepSession = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const cookies = req.headers.cookie ?? "";
    const html = (b: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(200, { "content-type": "text/html", ...headers });
      res.end(page(b));
    };
    const go = (to: string, setCookie: string[] = []) => {
      res.writeHead(302, { location: to, "set-cookie": setCookie });
      res.end();
    };
    const session = keepSession ? "session=ok; Path=/; Max-Age=3600" : "session=ok; Path=/";
    if (url.pathname === "/login") {
      if (cookies.includes("session=ok")) return go("/home");
      return html(`<form action="/session" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/session") {
      passwordPosts++;
      if (cookies.includes("trusted=yes")) return go("/home", [session]);
      return go("/mfa");
    }
    if (url.pathname === "/mfa") {
      return html(`<h1>Verify your identity</h1><p>Enter the code we emailed you.</p>
        <form action="/check" method="get"><label for="c">Verification code</label><input id="c" name="code" autocomplete="one-time-code">
        <label class="box"><input type="checkbox" name="remember" style="position:absolute;opacity:0;width:1px;height:1px"> Remember this device</label>
        <button type="submit">Verify</button></form>`);
    }
    if (url.pathname === "/check") {
      if (url.searchParams.get("code") !== "1357") return html(`<div role="alert">Invalid code</div>`);
      const set = [session];
      if (url.searchParams.get("remember") === "on") set.push("trusted=yes; Path=/; Max-Age=86400");
      return go("/home", set);
    }
    if (url.pathname === "/home") {
      if (!cookies.includes("session=ok")) return go("/login");
      return html(`<nav><a href="/home">Home</a><a href="/p">Policies</a><a href="/b">Billing</a><a href="/logout">Log out</a></nav>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const carrier: CarrierProfile = { key: "foremost", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] };
  const run = async () => {
    const browser = await Browser.launch({ executablePath: chrome!, headless: true, profileDir });
    try {
      return await runCarrier(browser, carrier, {
        username: "u",
        password: "p",
        getCode: async () => {
          codesAsked++;
          return "1357";
        },
        deadline: Date.now() + 150_000,
        maxDocuments: 5,
        debugDir: null,
        log: (x) => process.env.PC_TRACE && console.log("step", x),
      });
    } finally {
      await browser.close();
    }
  };
  try {
    await run();
    assert.equal(codesAsked, 1, "first run needs the emailed code");
    assert.equal(passwordPosts, 1);

    keepSession = true;
    await run();
    assert.equal(codesAsked, 1, "second run: device remembered, no code");
    assert.equal(passwordPosts, 2, "second run still signs in with the password");

    const third = await run();
    assert.equal(passwordPosts, 2, "third run: session kept, no password typed");
    assert.equal(codesAsked, 1);
    assert.ok(third.notes.some((n) => /Already signed in/.test(n)));
  } finally {
    server.close();
  }
});

test("clicks 'Trust this browser' (not 'Not now') when offered after the code", { skip: !chrome, timeout: 120_000 }, async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname);
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") return html(`<form action="/mfa" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Sign in</button></form>`);
    if (url.pathname === "/mfa") return html(`<p>Enter the verification code we emailed.</p><form action="/trust" method="get"><input name="code" autocomplete="one-time-code"><button type="submit">Verify</button></form>`);
    if (url.pathname === "/trust") return html(`<h1>Trust this browser?</h1><p>You won't need a code next time.</p><a href="/home?t=no">Not now</a> <a href="/trusted">Trust this browser</a>`);
    if (url.pathname === "/trusted" || url.pathname === "/home") return html(`<nav><a href="/x">Home</a><a href="/y">Policies</a><a href="/z">Billing</a><a href="/logout">Log out</a></nav>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await runCarrier(
      browser,
      { key: "selective", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "u", password: "p", getCode: async () => "4321", deadline: Date.now() + 110_000, maxDocuments: 5, debugDir: null, log: () => undefined },
    );
    assert.ok(hits.includes("/trusted"), `clicked Trust this browser: ${hits.join(", ")}`);
    assert.ok(!hits.includes("/logout"));
  } finally {
    await browser.close();
    server.close();
  }
});

test("Foremost-style dashboard: opens the Policies menu and fetches each policy's declarations", { skip: !chrome, timeout: 200_000 }, async () => {
  const hits: string[] = [];
  const app = `<header><nav>
      <button id="home">Homepage</button>
      <button id="pol">Policies <span class="material-icons">chevron_right</span> Select policy from dropdown</button>
      <button>Payments</button><button>Claims</button><button>My profile</button><button>Sign out</button>
      <div id="menu" style="display:none"><button onclick="go('/policy/1')">Landlord H-111</button><button onclick="go('/policy/2')">Landlord H-222</button></div>
    </nav></header>
    <main id="main"></main>
    <footer><a href="#">Homepage</a><a href="#">Policies</a><a href="#">Payments</a></footer>
    <script>
      document.getElementById('pol').onclick=()=>{document.getElementById('menu').style.display='block'};
      function go(p){history.pushState({},'',p);render()}
      function render(){
        const m=document.getElementById('main'); m.innerHTML='';
        document.getElementById('menu').style.display='none';
        const p=location.pathname;
        setTimeout(()=>{
          if(p==='/home'){m.innerHTML='<h1>Welcome back</h1><p>Your policies are listed under Policies.</p>';return}
          const n=p.split('/').pop();
          m.innerHTML='<h1>Policy H-'+n+n+n+'</h1><button id="docs">Documents</button><div id="list"></div>';
          document.getElementById('docs').onclick=()=>{document.getElementById('list').innerHTML='<a href="/docs/dec-'+n+'.pdf">Declarations page</a> <a href="/pay">Make a payment</a>'};
        },3000);
      }
      render();
    </script>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname);
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<form action="/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`));
    }
    if (url.pathname === "/home" || url.pathname.startsWith("/policy/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(app));
    }
    const doc = /^\/docs\/dec-(\d)\.pdf$/.exec(url.pathname);
    if (doc) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf(`dec-${doc[1]}`));
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
      { username: "u", password: "p", getCode: async () => "0000", deadline: Date.now() + 190_000, maxDocuments: 10, debugDir: process.env.PC_DEBUG_DIR ?? null, log: (x) => process.env.PC_TRACE && console.log(Date.now() % 1000000, "step", x) },
    );
    const tags = result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]).sort();
    assert.deepEqual(tags, ["% dec-1", "% dec-2"], `hits: ${hits.join(", ")}`);
    assert.ok(!hits.includes("/pay"), "never opened the payment page");
  } finally {
    await browser.close();
    server.close();
  }
});

test("Foremost layout: one 'Policy documents' button per policy, every term, tagged by address", { skip: !chrome, timeout: 240_000 }, async () => {
  const hits: string[] = [];
  const policies = [
    { n: "1234567", addr: "12 Oak St" },
    { n: "7654321", addr: "900 Elm Ave" },
  ];
  const home = `<header><nav><button>Homepage</button><button>Policies <span>chevron_right</span> Select policy from dropdown</button><button>Payments</button><button>Sign out</button></nav></header>
    <main id="main"></main><footer><a href="#">Policies</a></footer>
    <script>
      function showHome(delay){const mm=document.getElementById('main'); mm.innerHTML=''; setTimeout(()=>{mm.innerHTML=${JSON.stringify(
        policies
          .map(
            (p) => `<section><h3>#100 - ${p.n} Rental Dwelling</h3>
              <button aria-label="pay bill for policy ${p.n}" onclick="fetch('/pay',{method:'POST'})">Pay bill</button>
              <button aria-label="set up autopay for policy ${p.n}">Set up autopay</button>
              <button aria-label="policy documents for policy ${p.n}" onclick="history.pushState({},'','/policy/documents?p=${p.n}');render()">Policy documents</button></section>`,
          )
          .join("") +
          `<button>Paperless settings</button><ul>` +
          policies.map((p) => `<li><a href="#" onclick="return false">#100 - ${p.n} Managed policies ${p.addr} policy number ${p.n}</a></li>`).join("") +
          `</ul>`,
      )};},delay||1500);}
      // After Back the cards take a while to come back, as on the real portal.
      window.onpopstate=()=>{ if (location.pathname.startsWith('/policy')) render(); else showHome(5000); };
      if (!location.pathname.startsWith('/policy')) showHome();
      function render(){
        const n=new URLSearchParams(location.search).get('p');
        const m=document.getElementById('main'); m.innerHTML='';
        setTimeout(()=>{m.innerHTML='<div role=tablist><button role=tab>DETAILS</button><button role=tab>DOCUMENTS</button></div><h1>Policy documents</h1><table>'+
          [['RENEWAL','05/14/2026'],['RENEWAL','05/12/2025'],['NEW BUSINESS','07/20/2024']].map((d,i)=>
            '<tr><td><button aria-label="'+d[0]+' for document '+(i+1)+' posted date '+d[1]+'; opens in a new tab" onclick="window.open(\\'/docs/'+n+'-'+i+'.pdf\\')"><span>picture_as_pdf</span> '+d[0]+'</button></td><td>'+d[1]+'</td></tr>').join('')+'</table>'},1500);
      }
      if (location.pathname.startsWith('/policy')) render();
    </script>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<form action="/app/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`));
    }
    if (url.pathname === "/app/home" || url.pathname.startsWith("/policy/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(home));
    }
    const doc = /^\/docs\/(\d+)-(\d)\.pdf$/.exec(url.pathname);
    if (doc) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf(`${doc[1]}-${doc[2]}`));
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
      {
        username: "u",
        password: "p",
        getCode: async () => "0000",
        deadline: Date.now() + 230_000,
        maxDocuments: 20,
        debugDir: process.env.PC_DEBUG_DIR ?? null,
        log: () => undefined,
        // One document is already saved from an earlier run.
        alreadyHave: (d) =>
          d.policy === "12 Oak St - Policy 1234567" && d.title === "RENEWAL" && d.posted === "2025-05-12"
            ? "Foremost - 12 Oak St - Policy 1234567 - Term 2025-07-01 to 2026-07-01 - RENEWAL (posted 2025-05-12).pdf"
            : null,
      },
    );
    const tags = result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]).sort();
    assert.deepEqual(tags, ["% 1234567-0", "% 1234567-2", "% 7654321-0", "% 7654321-1", "% 7654321-2"], `every term but the saved one; hits: ${hits.join(", ")}`);
    assert.ok(!hits.some((h) => h.includes("/docs/1234567-1.pdf")), "the saved document was not downloaded again");
    assert.equal(result.skipped.length, 1);
    for (const id of ["1234567", "7654321", "12 Oak St", "900 Elm Ave"]) assert.ok(result.identifiers.includes(id), `noted ${id}`);
    const meta = result.documents.map((d) => `${d.policy} | ${d.title} | ${d.posted}`).sort();
    assert.deepEqual(meta, [
      "12 Oak St - Policy 1234567 | NEW BUSINESS | 2024-07-20",
      "12 Oak St - Policy 1234567 | RENEWAL | 2026-05-14",
      "900 Elm Ave - Policy 7654321 | NEW BUSINESS | 2024-07-20",
      "900 Elm Ave - Policy 7654321 | RENEWAL | 2025-05-12",
      "900 Elm Ave - Policy 7654321 | RENEWAL | 2026-05-14",
    ]);
    assert.ok(!hits.some((h) => h.startsWith("POST /pay")), "never paid");
  } finally {
    await browser.close();
    server.close();
  }
});

test("per-policy buttons gone after Back: falls back to the general policy picker", { skip: !chrome, timeout: 240_000 }, async () => {
  const hits: string[] = [];
  const pols = ["1234567", "7654321"];
  const app = `<header><nav><button>Homepage</button><button>Payments</button><button>Sign out</button></nav></header><main id="main"></main>
    <div id="modal" style="display:none"><button onclick="document.getElementById('modal').style.display='none'">Close</button>${pols
      .map((n) => `<button aria-label="view documents for policy number ${n}" onclick="go('/policy/documents?p=${n}')">Select policy</button>`)
      .join("")}</div>
    <script>
      let visits = 0;
      function go(p){document.getElementById('modal').style.display='none';history.pushState({},'',p);render()}
      function home(first){
        const m=document.getElementById('main');
        m.innerHTML = (first ? ${JSON.stringify(
          pols.map((n) => `<section>Policy ${n} <button aria-label="policy documents for policy ${n}" onclick="go('/policy/documents?p=${n}')">Policy documents</button></section>`).join(""),
        )} : '<p>Your policies</p>') +
          '<button onclick="document.getElementById(\\'modal\\').style.display=\\'block\\'">View policy documents</button>';
      }
      function render(){
        const n=new URLSearchParams(location.search).get('p'); const m=document.getElementById('main');
        if(!n){home(visits++===0);return}
        m.innerHTML='<h1>Policy documents</h1>'+[['RENEWAL','05/14/2026'],['RENEWAL','05/12/2025']].map((d,i)=>
          '<button onclick="window.open(\\'/docs/'+n+'-'+i+'.pdf\\')"><span>picture_as_pdf</span> '+d[0]+' '+d[1]+'</button>').join('');
      }
      window.onpopstate=render; render();
    </script>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname + url.search);
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<form action="/app/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`));
    }
    if (url.pathname === "/app/home" || url.pathname.startsWith("/policy/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(app));
    }
    const doc = /^\/docs\/(\d+)-(\d)\.pdf$/.exec(url.pathname);
    if (doc) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf(`${doc[1]}-${doc[2]}`));
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
      { username: "u", password: "p", getCode: async () => "0000", deadline: Date.now() + 230_000, maxDocuments: 20, debugDir: process.env.PC_DEBUG_DIR ?? null, log: () => undefined },
    );
    const tags = result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]).sort();
    assert.deepEqual(tags, ["% 1234567-0", "% 1234567-1", "% 7654321-0", "% 7654321-1"], `hits: ${hits.join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("Back is broken: reaches every policy through the header Policies menu, never a bill", { skip: !chrome, timeout: 240_000 }, async () => {
  const hits: string[] = [];
  const pols = [
    { n: "1234567", addr: "12 Oak St" },
    { n: "7654321", addr: "900 Elm Ave" },
    { n: "5555555", addr: "3 Pine Rd" },
  ];
  const app = `<header><nav><button>Homepage</button>
      <button id="pm" onclick="document.getElementById('menu').style.display='block'">Policies <span>expand_more</span> Select policy from dropdown</button>
      <div id="menu" style="display:none">${pols.map((p) => `<button onclick="go('/policy/details?p=${p.n}')">${p.addr} Rental Dwelling policy #100-${p.n}</button>`).join("")}</div>
      <button>Payments</button><button>Sign out</button></nav></header>
    <main id="main"></main>
    <button style="position:fixed;right:10px;bottom:10px;width:160px;height:50px;z-index:9">Chat Support</button>
    <script>
      function go(p){document.getElementById('menu').style.display='none';history.pushState({},'',p);render()}
      // Back lands on a blank page here, unlike a well-behaved site.
      window.onpopstate=()=>{document.getElementById('main').innerHTML=''};
      function render(){
        const u=new URL(location.href), n=u.searchParams.get('p'), m=document.getElementById('main');
        if(u.pathname==='/app/home'){m.innerHTML=${JSON.stringify(
          pols
            .map(
              (p) => `<section><h3>${p.addr}</h3><a href="#" onclick="return false">#100 - ${p.n}</a>
                <button aria-label="view bill for policy ${p.n}" onclick="fetch('/bill?p=${p.n}')">View bill</button>
                <button aria-label="policy documents for policy ${p.n}" onclick="go('/policy/documents?p=${p.n}')">Policy documents</button></section>`,
            )
            .join("") + pols.map((p) => `<a href="#" onclick="return false">#100 - ${p.n} Managed policies ${p.addr} policy number ${p.n}</a>`).join(""),
        )};return}
        const tabs='<div><button role=tab onclick="go(\\'/policy/details?p='+n+'\\')">DETAILS</button><button role=tab onclick="go(\\'/policy/documents?p='+n+'\\')">DOCUMENTS</button></div>';
        if(u.pathname==='/policy/details'){m.innerHTML=tabs+'<h1>Policy details</h1>';return}
        m.innerHTML=tabs+'<h1>Policy documents</h1>'+['05/14/2026','05/12/2025'].map((d,i)=>
          '<button onclick="window.open(\\'/docs/'+n+'-'+i+'.pdf\\')"><span>picture_as_pdf</span> RENEWAL '+d+'</button>').join('');
      }
      render();
    </script>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname + url.search);
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<form action="/app/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`));
    }
    if (url.pathname === "/app/home" || url.pathname.startsWith("/policy/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(app));
    }
    const doc = /^\/docs\/(\d+)-(\d)\.pdf$/.exec(url.pathname);
    if (doc) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf(`${doc[1]}-${doc[2]}`));
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
      { username: "u", password: "p", getCode: async () => "0000", deadline: Date.now() + 230_000, maxDocuments: 20, debugDir: process.env.PC_DEBUG_DIR ?? null, log: () => undefined },
    );
    const tags = result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]).sort();
    assert.deepEqual(tags, ["% 1234567-0", "% 1234567-1", "% 5555555-0", "% 5555555-1", "% 7654321-0", "% 7654321-1"], `hits: ${hits.join(", ")}`);
    assert.ok(!hits.some((h) => h.startsWith("/bill")), "never opened a bill");
    assert.deepEqual([...new Set(result.documents.map((d) => d.policy))].sort(), ["12 Oak St - Policy 1234567", "3 Pine Rd - Policy 5555555", "900 Elm Ave - Policy 7654321"]);
  } finally {
    await browser.close();
    server.close();
  }
});

test("declines a 'Go paperless?' pop-up after sign-in, never enrolls", { skip: !chrome, timeout: 120_000 }, async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}`);
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") return html(`<form action="/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    if (url.pathname === "/home") {
      return html(`<nav><a href="/a">Home</a><a href="/b">Billing</a><a href="/c">Claims</a><a href="/logout">Log out</a></nav>
        <main><h1>Your policies</h1><a href="/docs/dec.pdf">Declarations page</a></main>
        <div role="dialog" aria-modal="true" id="pp" style="position:fixed;inset:0;background:white">
          <h2>Go paperless?</h2><p>Get your documents by email.</p>
          <button onclick="fetch('/enroll',{method:'POST'})">Enroll now</button>
          <button onclick="document.getElementById('pp').remove()">No thanks</button></div>`);
    }
    if (url.pathname === "/docs/dec.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf("dec"));
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
      { username: "u", password: "p", getCode: async () => "0000", deadline: Date.now() + 110_000, maxDocuments: 5, debugDir: null, log: () => undefined },
    );
    assert.ok(!hits.includes("POST /enroll"), "never enrolled");
    assert.equal(result.documents.length, 1);
  } finally {
    await browser.close();
    server.close();
  }
});

test("Liberty-style: a 'Log out' button on the sign-in pages does not end sign-in early", { skip: !chrome, timeout: 120_000 }, async () => {
  let codeAsked = false;
  let verified = false;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") {
      return html(`<button type="button">Log out</button><form action="/u/mfa" method="get"><input name="username" placeholder="Email or username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/u/mfa") {
      // A few seconds with no boxes at all, as Auth0 pages do while loading.
      return html(`<button type="button">Log out</button><div id="x"></div><script>setTimeout(()=>{document.getElementById('x').innerHTML='<p>Verify your identity. Enter the code we emailed.</p><form action="/done"><input name="code" autocomplete="one-time-code"><button type="submit">Continue</button></form>'},4000)</script>`);
    }
    if (url.pathname === "/done") {
      verified = url.searchParams.get("code") === "112233";
      return html(`<nav><a href="/x">Home</a><a href="/y">Policies</a><a href="/z">Billing</a><button>Log out</button></nav><main><p>Welcome</p></main>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await runCarrier(
      browser,
      { key: "liberty_mutual", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      {
        username: "u",
        password: "p",
        getCode: async () => {
          codeAsked = true;
          return "112233";
        },
        deadline: Date.now() + 110_000,
        maxDocuments: 5,
        debugDir: null,
        log: () => undefined,
      },
    );
    assert.equal(codeAsked, true, "waited for the code step");
    assert.equal(verified, true);
  } finally {
    await browser.close();
    server.close();
  }
});

for (const buttonsOnce of [false, true])
test(`every policy's documents at the same address (policy kept out of the URL)${buttonsOnce ? ", later ones via the header menu" : ""}`, { skip: !chrome, timeout: 240_000 }, async () => {
  const hits: string[] = [];
  const pols = [
    { n: "1234567", addr: "12 Oak St" },
    { n: "7654321", addr: "900 Elm Ave" },
    { n: "5555555", addr: "3 Pine Rd" },
  ];
  const app = `<header><nav><button>Homepage</button>
      <button onclick="document.getElementById('menu').style.display='block'">Policies <span>expand_more</span> Select policy from dropdown</button>
      <div id="menu" style="display:none">${pols.map((p) => `<button onclick="pick('${p.n}','details')">${p.addr} Rental Dwelling policy #100-${p.n}</button>`).join("")}</div>
      <button>Sign out</button></nav></header><main id="main"></main>
    <script>
      const P=${JSON.stringify(pols)}; let cur=null, tab='details', homeVisits=0; const ONCE=${buttonsOnce};
      function pick(n,t){cur=P.find(p=>p.n===n);tab=t;document.getElementById('menu').style.display='none';if(location.pathname!=='/app/policy')history.pushState({},'','/app/policy');render()}
      window.onpopstate=render;
      function render(){
        const m=document.getElementById('main');
        if(location.pathname==='/app/home'){const showButtons=!ONCE||homeVisits++===0; m.innerHTML=P.map(p=>'<section><h3>'+p.addr+'</h3><button aria-label="view bill for policy '+p.n+'">View bill</button>'+(showButtons?'<button aria-label="policy documents for policy '+p.n+'" onclick="pick(\\''+p.n+'\\',\\'documents\\')">Policy documents</button>':'')+'</section>').join('')+P.map(p=>'<a href="#" onclick="return false">#100 - '+p.n+' Managed policies '+p.addr+' policy number '+p.n+'</a>').join('');return}
        if(!cur){m.innerHTML='<p>Select a policy.</p>';return}
        const tabs='<div><button role=tab onclick="tab=\\'details\\';render()">DETAILS</button><button role=tab onclick="tab=\\'documents\\';render()">DOCUMENTS</button></div><h1>'+cur.addr+' Rental Dwelling policy '+(tab==='documents'?'documents':'details')+'</h1>';
        if(tab==='details'){m.innerHTML=tabs+'<p>Coverage summary</p>';return}
        m.innerHTML=tabs+['05/14/2026','05/12/2025'].map((d,i)=>'<button onclick="window.open(\\'/docs/'+cur.n+'-'+i+'.pdf\\')"><span>picture_as_pdf</span> RENEWAL '+d+'</button>').join('');
      }
      render();
    </script>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(url.pathname + url.search);
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(`<form action="/app/home" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`));
    }
    if (url.pathname.startsWith("/app/")) {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(page(app));
    }
    const doc = /^\/docs\/(\d+)-(\d)\.pdf$/.exec(url.pathname);
    if (doc) {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf(`${doc[1]}-${doc[2]}`));
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
      { username: "u", password: "p", getCode: async () => "0000", deadline: Date.now() + 230_000, maxDocuments: 20, debugDir: process.env.PC_DEBUG_DIR ?? null, log: () => undefined },
    );
    const got = result.documents.map((d) => `${d.policy} | ${d.bytes.toString("latin1").split("\n")[1]}`).sort();
    assert.deepEqual(got, [
      "12 Oak St - Policy 1234567 | % 1234567-0",
      "12 Oak St - Policy 1234567 | % 1234567-1",
      "3 Pine Rd - Policy 5555555 | % 5555555-0",
      "3 Pine Rd - Policy 5555555 | % 5555555-1",
      "900 Elm Ave - Policy 7654321 | % 7654321-0",
      "900 Elm Ave - Policy 7654321 | % 7654321-1",
    ], `each PDF under its own policy; hits: ${hits.join(", ")}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("Liberty Mutual rehearsal: text-code default switched to email, remember device, unnamed documents, nothing billed", { skip: !chrome, timeout: 240_000 }, async () => {
  const hits: string[] = [];
  let remembered = false;
  let codeOk = false;
  const pol = "H37-291-123456-40";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    const p = url.pathname;
    if (p === "/login") {
      return html(`<button style="width:0;height:0;padding:0;border:0;overflow:hidden">Log out</button>
        <form action="/u/mfa-sms" method="get"><input name="username" placeholder="Email or username"><input type="password" name="password" placeholder="Password">
        <input type="checkbox" id="slideOne" style="display:none"><button type="submit" id="1-submit">Log in</button>
        <p>By selecting Log in, I agree to the Liberty Mutual Paperless Terms and Conditions.</p></form>`);
    }
    if (p === "/u/mfa-sms") {
      return html(`<h1>Verify your identity</h1><p>We've sent a text message to (•••) •••-1234.</p>
        <form action="/u/mfa-check" method="get"><label for="c">Enter the 6-digit code</label><input id="c" name="code" autocomplete="one-time-code"><button type="submit">Continue</button></form>
        <a href="/u/mfa-methods">Try another method</a>`);
    }
    if (p === "/u/mfa-methods") {
      return html(`<h1>Other methods</h1><p>How do you want to get your verification code?</p><a href="/u/mfa-sms">SMS</a> <a href="/u/mfa-email">Email</a> <a href="/u/mfa-voice">Phone call</a>`);
    }
    if (p === "/u/mfa-email") {
      return html(`<h1>Verify your identity</h1><p>We've sent an email with your code to m***@example.com.</p>
        <form action="/u/mfa-check" method="get"><label for="c">Enter the code</label><input id="c" name="code" autocomplete="one-time-code">
        <label><input type="checkbox" name="remember"> Remember this device for 30 days</label><button type="submit">Continue</button></form>`);
    }
    if (p === "/u/mfa-check") {
      codeOk = url.searchParams.get("code") === "654321";
      remembered = url.searchParams.get("remember") === "on";
      res.writeHead(302, { location: codeOk ? "/account/home" : "/u/mfa-email" });
      return res.end();
    }
    if (!codeOk) return html("no");
    if (p === "/account/home") {
      return html(`<aside><h2>Policies</h2><a href="/account/policy?id=1">Homeowners ${pol}</a></aside>
        <nav><a href="/account/billing">Billing</a><a href="/account/claims">Claims</a><button>Log out</button></nav>
        <main><h1>Welcome</h1><p>Your account at a glance.</p></main>
        <div role="dialog" aria-modal="true" id="d" style="position:fixed;inset:0;background:#fff"><h2>Go paperless and save</h2>
          <button onclick="fetch('/account/paperless/enroll',{method:'POST'})">Enroll</button><button onclick="document.getElementById('d').remove()">Not now</button></div>`);
    }
    if (p === "/account/policy") {
      return html(`<nav><a href="/account/home">Home</a><button>Log out</button></nav><main><h1>Homeowners policy ${pol}</h1>
        <a href="/account/policy/documents?id=1">View policy documents</a> <a href="/account/billing/pay">Make a payment</a></main>`);
    }
    if (p === "/account/policy/documents") {
      return html(`<nav><a href="/account/home">Home</a><button>Log out</button></nav><main><h1>Policy documents</h1><table>
        <tr><td><a href="/api/doc?d=dec">Declarations 08/01/2026</a></td></tr>
        <tr><td><a href="/api/doc?d=chg">Policy Change Confirmation 03/12/2026</a></td></tr>
        <tr><td><a href="/api/doc?d=bill">Billing statement 09/01/2026</a></td></tr>
        <tr><td><a href="/account/billing/pay">Make a payment</a></td></tr></table></main>`);
    }
    if (p === "/api/doc") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf(`lm-${url.searchParams.get("d")}`));
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
      { username: "u", password: "p", getCode: async () => "654321", deadline: Date.now() + 230_000, maxDocuments: 20, debugDir: process.env.PC_DEBUG_DIR ?? null, log: () => undefined },
    );
    const tags = result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]).sort();
    assert.deepEqual(tags, ["% lm-chg", "% lm-dec"], `hits: ${hits.join(", ")}`);
    assert.ok(hits.includes("GET /u/mfa-email"), "switched to email");
    assert.ok(!hits.some((h) => h.includes("mfa-voice")), "never chose a phone call");
    assert.ok(remembered, "ticked remember this device");
    assert.ok(!hits.some((h) => h.includes("/billing/pay") || h.includes("paperless/enroll") || h.includes("d=bill")), "no payment, no enrolment, no bill");
    assert.ok(result.documents.every((d) => d.policy.includes(pol)), `filed under ${pol}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("Selective rehearsal: real login element names, Send Email pop-up, 4 one-digit boxes, clickable boxes after sign-in", { skip: !chrome, timeout: 240_000 }, async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    hits.push(`${req.method} ${url.pathname}${url.search}`);
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/apps/SelectiveWeb/") {
      return html(`<div id="frmLogin">
        <input type="text" id="frmLogin_txtUserID" autocomplete="off"><input type="password" id="frmLogin_txtPassword" autocomplete="off">
        <input type="button" id="frmLogin_btnLogin" value="Log In" onclick="fetch('/login',{method:'POST'}).then(()=>{document.getElementById('pop').style.display='block'})">
        <input type="button" id="frmLogin_btnPWAReportAClaim" value="Report a Claim" onclick="fetch('/claim',{method:'POST'})">
        <div id="pop" style="display:none"><p>For your security we need to verify your identity. How should we send your code?</p>
          <input type="button" id="frmLogin_btnSendEmail" value="Send Email" onclick="fetch('/send-email',{method:'POST'});document.getElementById('codes').style.display='block';document.getElementById('pop').style.display='none'">
          <input type="button" id="frmLogin_btnSendText" value="Send Text" onclick="fetch('/send-text',{method:'POST'})"></div>
        <div id="codes" style="display:none"><p>Enter the code we emailed you.</p>
          <input id="frmLogin_txtCode1" maxlength="1"><input id="frmLogin_txtCode2" maxlength="1"><input id="frmLogin_txtCode3" maxlength="1"><input id="frmLogin_txtCode4" maxlength="1">
          <input type="button" id="frmLogin_btnNextStep" value="Next" title="Next" onclick="const c=[1,2,3,4].map(i=>document.getElementById('frmLogin_txtCode'+i).value).join('');location.href='/apps/SelectiveWeb/home?c='+c"></div>
        </div>
        <div id="onetrust-banner-sdk"><p>We use cookies.</p>
          <button type="submit" id="onetrust-pc-btn-handler" onclick="fetch('/cookie-settings',{method:'POST'})">Cookies Settings</button>
          <button type="submit" id="onetrust-accept-btn-handler" onclick="fetch('/cookie-accept',{method:'POST'})">Accept Cookies</button></div>`);
    }
    if (url.pathname === "/apps/SelectiveWeb/home") {
      if (url.searchParams.get("c") !== "5521") return html("bad code");
      return html(`<style>.k{cursor:pointer;padding:6px;display:inline-block}</style>
        <div class="k" kwidgettype="Button" onclick="show('pols')">My Policies</div> <div class="k" kwidgettype="Button" onclick="fetch('/pay',{method:'POST'})">Pay My Bill</div> <div class="k" kwidgettype="Button">Log Out</div>
        <main id="m"><p>Welcome to MySelective</p></main>
        <script>
          function show(w){const m=document.getElementById('m');
            if(w==='pols'){m.innerHTML='<div class="k" kwidgettype="Button" onclick="show(\\'pol\\')">Homeowners Policy S 2290000123</div>';return}
            if(w==='pol'){m.innerHTML='<h1>Policy Details</h1><div class="k" kwidgettype="Button">Coverage</div><div class="k" kwidgettype="Button" onclick="show(\\'docs\\')">Documents</div>';return}
            m.innerHTML='<h1>Policy Documents</h1><div class="k" kwidgettype="Button" onclick="window.open(\\'/docs/sel.pdf\\')">Policy PDF</div>';
          }
        </script>`);
    }
    if (url.pathname === "/docs/sel.pdf") {
      res.writeHead(200, { "content-type": "application/pdf" });
      return res.end(pdf("selective-policy"));
    }
    res.writeHead(200).end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    const result = await runCarrier(
      browser,
      { key: "selective", name: "Fake", loginUrl: `http://127.0.0.1:${port}/apps/SelectiveWeb/`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "u", password: "p", getCode: async () => "5521", deadline: Date.now() + 230_000, maxDocuments: 20, debugDir: process.env.PC_DEBUG_DIR ?? null, log: () => undefined },
    );
    assert.deepEqual(result.documents.map((d) => d.bytes.toString("latin1").split("\n")[1]), ["% selective-policy"], `hits: ${hits.join(", ")}`);
    assert.ok(hits.includes("POST /send-email") && !hits.includes("POST /send-text"), "email, never text");
    assert.ok(!hits.includes("POST /claim") && !hits.includes("POST /pay"), "no claim, no payment");
    assert.ok(!hits.includes("POST /cookie-settings") && !hits.includes("POST /cookie-accept"), "cookie banner left alone");
  } finally {
    await browser.close();
    server.close();
  }
});

for (const style of ["six named boxes", "one invisible field over drawn boxes"] as const)
test(`Liberty Mutual code screen (${style}): 6-digit code entered, Continue pressed`, { skip: !chrome, timeout: 120_000 }, async () => {
  let entered = "";
  const boxes =
    style === "six named boxes"
      ? [1, 2, 3, 4, 5, 6].map((i) => `<input type="text" inputmode="numeric" maxlength="1" aria-label="Digit ${i}" class="d">`).join("")
      : `<div style="position:relative;width:300px;height:50px"><div style="display:flex;gap:6px">${"<div style='width:40px;height:46px;border:1px solid #999'></div>".repeat(6)}</div>
         <input id="otp" type="text" inputmode="numeric" maxlength="6" style="position:absolute;inset:0;opacity:0"></div>`;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") {
      return html(`<form action="/u/mfa-email-challenge" method="get"><input name="username" placeholder="Email or username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/u/mfa-email-challenge") {
      return html(`<h1>Check your email</h1><p>We emailed a code to m***@ex*****</p><p>Enter the code to continue.</p>
        <form action="/u/done" method="get" onsubmit="document.getElementById('v').value=[...document.querySelectorAll('.d')].map(x=>x.value).join('')||document.getElementById('otp').value">
        ${boxes}<input type="hidden" name="v" id="v"><button type="submit">Continue</button></form><button type="button">Send a new code</button>`);
    }
    if (url.pathname === "/u/done") {
      entered = url.searchParams.get("v") ?? "";
      return html(`<nav><a href="/a">Home</a><a href="/b">Policies</a><a href="/c">Billing</a><button>Log out</button></nav><main><p>Welcome</p></main>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await runCarrier(
      browser,
      { key: "liberty_mutual", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "u", password: "p", getCode: async () => "482913", deadline: Date.now() + 110_000, maxDocuments: 5, debugDir: process.env.PC_DEBUG_DIR ?? null, log: (x) => process.env.PC_TRACE && console.log("step", x) },
    );
    assert.equal(entered, "482913");
  } finally {
    await browser.close();
    server.close();
  }
});

test("Selective 'This code is invalid': closes it, asks for one new code, uses it", { skip: !chrome, timeout: 120_000 }, async () => {
  let sends = 0;
  let ok = false;
  const codes = ["1111", "2222"];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") {
      return html(`<form action="/code" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/code") {
      sends++;
      return html(`<p>Please enter the 4-digit code you received below.</p>
        ${[1, 2, 3, 4].map((i) => `<input id="c${i}" maxlength="1">`).join("")}
        <a href="#" onclick="fetch('/resend').then(()=>{});return false">Send another code.</a>
        <input type="button" value="Next" title="Next" onclick="const c=[1,2,3,4].map(i=>document.getElementById('c'+i).value).join('');fetch('/check?c='+c).then(r=>r.text()).then(t=>{if(t==='ok'){location.href='/home'}else{document.getElementById('bad').style.display='block'}})">
        <div id="bad" role="dialog" style="display:none"><p>This code is invalid. Please enter a different code or request a new one.</p>
          <button onclick="document.getElementById('bad').style.display='none'">Close</button></div>`);
    }
    if (url.pathname === "/resend") {
      sends++;
      res.writeHead(200);
      return res.end("sent");
    }
    if (url.pathname === "/check") {
      // Only the code from the latest send is valid.
      ok = url.searchParams.get("c") === codes[sends - 1];
      res.writeHead(200);
      return res.end(ok ? "ok" : "bad");
    }
    if (url.pathname === "/home") return html(`<nav><a href="/a">Home</a><a href="/b">Policies</a><a href="/c">Billing</a><a href="/logout">Log out</a></nav>`);
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  let asked = 0;
  try {
    await runCarrier(
      browser,
      { key: "selective", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      {
        username: "u",
        password: "p",
        // The first answer is the stale code; after the resend, the new one.
        getCode: async () => (asked++ === 0 ? "9999" : codes[sends - 1]),
        deadline: Date.now() + 110_000,
        maxDocuments: 5,
        debugDir: null,
        log: () => undefined,
      },
    );
    assert.equal(ok, true);
    assert.equal(sends, 2, "exactly one new code requested");
    assert.equal(asked, 2);
  } finally {
    await browser.close();
    server.close();
  }
});

test("code boxes that jump back on Backspace and forward on typing get the right digits", { skip: !chrome, timeout: 120_000 }, async () => {
  let got = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const html = (b: string) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(b));
    };
    if (url.pathname === "/login") {
      return html(`<form action="/code" method="get"><input name="username" autocomplete="username"><input type="password" name="password"><button type="submit">Log in</button></form>`);
    }
    if (url.pathname === "/code") {
      return html(`<p>Please enter the 4-digit code you received below.</p>
        ${[0, 1, 2, 3].map((i) => `<input class="b" data-i="${i}" maxlength="1">`).join("")}
        <input type="button" value="Next" title="Next" onclick="location.href='/check?c='+[...document.querySelectorAll('.b')].map(x=>x.value).join('')">
        <script>
          const bs=[...document.querySelectorAll('.b')];
          bs.forEach((b,i)=>{
            b.addEventListener('keydown',e=>{ if(e.key==='Backspace'&&!b.value&&i>0){ e.preventDefault(); bs[i-1].value=''; bs[i-1].focus(); } });
            b.addEventListener('input',()=>{ if(b.value.length===1&&i<3) bs[i+1].focus(); });
          });
        </script>`);
    }
    if (url.pathname === "/check") {
      got = url.searchParams.get("c") ?? "";
      return html(got === "0092" ? `<nav><a href="/a">Home</a><a href="/b">Policies</a><a href="/c">Billing</a><a href="/logout">Log out</a></nav>` : `<p>This code is invalid.</p>`);
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const browser = await Browser.launch({ executablePath: chrome!, headless: true });
  try {
    await runCarrier(
      browser,
      { key: "selective", name: "Fake", loginUrl: `http://127.0.0.1:${port}/login`, siteDomains: ["127.0.0.1"], senderDomains: [] },
      { username: "u", password: "p", getCode: async () => "0092", deadline: Date.now() + 110_000, maxDocuments: 5, debugDir: null, log: () => undefined },
    );
    assert.equal(got, "0092");
  } finally {
    await browser.close();
    server.close();
  }
});
