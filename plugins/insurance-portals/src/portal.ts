/**
 * Sign in to a carrier portal and collect the current policy documents.
 *
 * Sign-in is a small state machine driven by what is on screen (user name,
 * password, "send the code by email" choice, code boxes), so the same steps
 * cover Foremost's two-page sign-in, Liberty Mutual's one-page sign-in and
 * Selective's pop-up. The password is submitted at most once per run so a
 * wrong password can never lock the account out by retrying.
 *
 * After sign-in the request guard is switched on and the run only follows
 * links that read like documents or a policy's own page.
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Browser, Page, sleep } from "./cdp.js";
import {
    isDocumentLink,
  isNavigationLink,
  isSafeNavigationUrl,
  shouldBlockRequest,
} from "./safety.js";

export type CarrierKey = "foremost" | "liberty_mutual" | "selective";

export interface CarrierProfile {
  key: CarrierKey;
  name: string;
  loginUrl: string;
  /** Domains the portal itself lives on; navigation never leaves them. */
  siteDomains: string[];
  /** Domains the carrier's login-code emails come from. Nothing else is read. */
  senderDomains: string[];
}

export const CARRIERS: Record<CarrierKey, CarrierProfile> = {
  foremost: {
    key: "foremost",
    name: "Foremost",
    loginUrl: "https://www.myforemostaccount.com/fmcss/login",
    siteDomains: ["myforemostaccount.com", "foremost.com"],
    // Real senders: policy.foremost.com, payments.foremost.com.
    senderDomains: ["foremost.com"],
  },
  liberty_mutual: {
    key: "liberty_mutual",
    name: "Liberty Mutual",
    loginUrl: "https://eservice.libertymutual.com/account/auth",
    siteDomains: ["libertymutual.com"],
    // Real sender: DoNotReply@libertymutual.com.
    senderDomains: ["libertymutual.com"],
  },
  selective: {
    key: "selective",
    name: "Selective",
    loginUrl: "https://customer.selective.com/apps/SelectiveWeb/",
    siteDomains: ["selective.com", "selectiveinsurance.com"],
    // Real sender: AccountVerification@underwritingalerts.selective.com.
    senderDomains: ["selective.com"],
  },
};

export interface RunOptions {
  username: string;
  password: string;
  /** Fetches the newest login code that arrived after `requestedAt`. */
  getCode: (requestedAt: Date) => Promise<string>;
  deadline: number;
  maxDocuments: number;
  debugDir: string | null;
  log: (step: string, meta?: Record<string, unknown>) => void;
}

export interface CapturedPdf {
  label: string;
  bytes: Buffer;
  sha256: string;
}

export interface RunResult {
  documents: CapturedPdf[];
  pagesVisited: number;
  blockedRequests: number;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Page-side scanners. These run inside the portal page, so they must be
// self-contained: no closures over Node variables.
// ---------------------------------------------------------------------------

interface LoginScan {
  host: string;
  username: string | null;
  usernameFilled: boolean;
  password: string | null;
  codeInputs: string[];
  emailChoice: string | null;
  sendCode: string | null;
  submit: string | null;
  cookieReject: string | null;
  error: string | null;
  captcha: boolean;
  signedInHint: boolean;
}

export function scanLogin(): LoginScan {
  let n = Number((window as any).__pcipN || 0);
  const mark = (el: Element): string => {
    let m = el.getAttribute("data-pcip");
    if (!m) {
      m = `m${++n}`;
      (window as any).__pcipN = n;
      el.setAttribute("data-pcip", m);
    }
    return m;
  };
  const visible = (el: Element): boolean => {
    const h = el as HTMLElement;
    const r = h.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(h);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const label = (el: Element): string => {
    const h = el as HTMLInputElement;
    const parts = [h.innerText, h.value, h.getAttribute("aria-label"), h.getAttribute("title")];
    return parts.filter((x) => typeof x === "string" && x.trim()).join(" ").replace(/\s+/g, " ").trim();
  };
  const describe = (el: HTMLInputElement): string => {
    const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return [el.name, el.id, el.placeholder, el.getAttribute("aria-label"), el.autocomplete, lab?.textContent]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  };
  const inputs = [...document.querySelectorAll("input")].filter(
    (i) => visible(i) && !i.disabled && !["hidden", "checkbox", "radio", "submit", "button", "image"].includes(i.type),
  ) as HTMLInputElement[];

  const password = inputs.find((i) => i.type === "password") ?? null;
  const isCode = (i: HTMLInputElement) =>
    i.type !== "password" &&
    (i.autocomplete === "one-time-code" ||
      /(code|otp|passcode|verif|one.?time|pin\b|token)/.test(describe(i))) &&
    !/(zip|postal|promo|coupon|search)/.test(describe(i));
  const codeInputs = password ? [] : inputs.filter(isCode);
  const username =
    inputs.find(
      (i) =>
        !isCode(i) &&
        i.type !== "password" &&
        (i.type === "email" || /(user|email|login|e-mail)/.test(describe(i))) &&
        !/search/.test(describe(i)),
    ) ?? null;

  const clickables = [
    ...document.querySelectorAll('button, input[type=submit], input[type=button], a, [role=button], label, [role=radio], input[type=radio]'),
  ].filter(visible);

  // Look for the submit control near the field first (the field's own form,
  // dialog or login panel), then anywhere on the page.
  const field = password ?? codeInputs[0] ?? username;
  const scope = field?.parentElement?.closest("form, [role=dialog], [class*=modal], [class*=login], [id*=Login], [id*=login]") ?? null;
  const submitRe = /^(log ?in|sign ?in|continue|next|submit|verify|verify code|confirm|ok|done)$/i;
  const pickSubmit = (pool: Element[]) =>
    pool.find((c) => submitRe.test(label(c)) && c.tagName !== "A" && c.tagName !== "LABEL") ??
    pool.find((c) => (c as HTMLInputElement).type === "submit" && !/(reject|accept|cookie)/i.test(label(c))) ??
    null;
  const submitEl = (scope ? pickSubmit(clickables.filter((c) => scope.contains(c))) : null) ?? (field ? pickSubmit(clickables) : null);

  let emailChoice: Element | null = null;
  let sendCode: Element | null = null;
  if (!password) {
    const pageText = document.body.innerText.toLowerCase();
    // A button that plainly says "Send Email" is the choice itself, whatever
    // the surrounding text says (Selective's pop-up).
    const plainEmail = clickables.find((c) => /^(send )?(an )?e-?mail( me)?( (a|the|my) code)?$/i.test(label(c)));
    const mfaPage = /(code|verif|confirm (?:it'?s|your identity)|security check|two.?step|multi.?factor)/.test(pageText);
    if (plainEmail) emailChoice = plainEmail;
    else if (mfaPage) {
      emailChoice =
        clickables.find((c) => {
          const t = label(c).toLowerCase();
          if (!/e-?mail/.test(t) || /(text|sms|call|phone|voice)/.test(t)) return false;
          if (c.tagName === "INPUT" && (c as HTMLInputElement).checked) return false;
          return t.length < 80;
        }) ??
        [...document.querySelectorAll('input[type=radio]')].find((r) => {
          const lab = (r as HTMLInputElement).labels?.[0]?.textContent?.toLowerCase() ?? "";
          return /e-?mail/.test(lab + " " + (r as HTMLInputElement).value.toLowerCase()) && !(r as HTMLInputElement).checked;
        }) ??
        null;
    }
    if (plainEmail || mfaPage) {
      sendCode =
        clickables.find((c) => /^(send|send code|send me (?:a|the) code|send (?:a )?code|get code|continue|next)$/i.test(label(c))) ?? null;
    }
  }

  const cookieReject =
    (document.querySelector("#onetrust-reject-all-handler") as Element | null) ??
    clickables.find((c) => /^(reject all|reject|decline|decline all|necessary only)$/i.test(label(c))) ??
    null;

  const errEls = [...document.querySelectorAll('[role=alert], [class*=error], [class*=Error], [id*=error], [id*=Error], [class*=invalid]')].filter(visible);
  const errText = errEls.map((e) => (e as HTMLElement).innerText.trim()).find((t) =>
    /(incorrect|invalid|locked|not recognized|doesn.t match|does not match|try again|unable to|disabled|suspended|wrong)/i.test(t),
  );

  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"], .g-recaptcha, #px-captcha');
  const signedInHint = clickables.some((c) => /^(log ?out|sign ?out|log off)$/i.test(label(c)));

  return {
    host: location.host,
    username: username ? mark(username) : null,
    usernameFilled: !!username && username.value.trim().length > 0,
    password: password ? mark(password) : null,
    codeInputs: codeInputs.map(mark),
    emailChoice: emailChoice ? mark(emailChoice) : null,
    sendCode: sendCode ? mark(sendCode) : null,
    submit: submitEl ? mark(submitEl) : null,
    cookieReject: cookieReject && visible(cookieReject) ? mark(cookieReject) : null,
    error: errText ? errText.slice(0, 160) : null,
    captcha,
    signedInHint,
  };
}

interface LinkInfo {
  mark: string;
  text: string;
  href: string;
  context: string;
}

function scanLinks(): LinkInfo[] {
  let n = Number((window as any).__pcipN || 0);
  const out: LinkInfo[] = [];
  const visible = (el: Element): boolean => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el as HTMLElement);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const els = [...document.querySelectorAll('a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=button]')];
  for (const el of els) {
    if (!visible(el)) continue;
    const h = el as HTMLAnchorElement;
    const text = [h.innerText, (h as unknown as HTMLInputElement).value, h.getAttribute("aria-label"), h.getAttribute("title")]
      .filter((x) => typeof x === "string" && x.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const href = h.tagName === "A" && /^https?:/i.test(h.href) ? h.href : "";
    if (!text && !href) continue;
    let m = el.getAttribute("data-pcip");
    if (!m) {
      m = `m${++n}`;
      el.setAttribute("data-pcip", m);
    }
    const box = el.closest("tr, li, article, section, [class*=card], [class*=Card], [class*=row], [class*=policy], [class*=Policy]");
    const context = box ? (box as HTMLElement).innerText.replace(/\s+/g, " ").trim().slice(0, 140) : "";
    out.push({ mark: m, text, href, context });
  }
  (window as any).__pcipN = n;
  return out;
}

async function fetchInPage(page: Page, url: string): Promise<{ type: string; b64: string } | null> {
  return page
    .evaluate<{ type: string; b64: string } | null>(async (u: string) => {
      const r = await fetch(u, { credentials: "include" });
      if (!r.ok) return null;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length > 30_000_000) return null;
      let s = "";
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { type: r.headers.get("content-type") ?? "", b64: btoa(s) };
    }, url)
    .catch(() => null);
}

const isPdf = (b: Buffer) => b.length > 100 && b.subarray(0, 5).toString("latin1") === "%PDF-";

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/** What the sign-in step can see, for the debug notes. Never includes typed values. */
function describeScan(s: LoginScan) {
  return {
    host: s.host,
    username: !!s.username,
    usernameFilled: s.usernameFilled,
    password: !!s.password,
    codeBoxes: s.codeInputs.length,
    emailChoice: !!s.emailChoice,
    submit: !!s.submit,
    error: s.error,
    captcha: s.captcha,
  };
}

/** A fingerprint of the sign-in state; a change means the page reacted. */
const scanKey = (s: LoginScan) =>
  JSON.stringify([s.host, !!s.username, !!s.password, s.codeInputs.length, !!s.emailChoice, s.error, s.signedInHint]);

export async function runCarrier(
  browser: Browser,
  carrier: CarrierProfile,
  opts: RunOptions,
): Promise<RunResult> {
  try {
    return await runCarrierInner(browser, carrier, opts);
  } catch (err) {
    if (opts.debugDir) {
      for (const p of browser.pages.values()) {
        const s = await p.evaluate<LoginScan>(scanLogin).catch(() => null);
        await p.screenshot(join(opts.debugDir, "99-failed.png")).catch(() => undefined);
        await writeFile(
          join(opts.debugDir, "99-failed.json"),
          JSON.stringify({ error: err instanceof Error ? err.message : String(err), url: (await p.url()).split("?")[0], seen: s ? describeScan(s) : null }, null, 2),
        ).catch(() => undefined);
        break;
      }
    }
    throw err;
  }
}

async function runCarrierInner(
  browser: Browser,
  carrier: CarrierProfile,
  opts: RunOptions,
): Promise<RunResult> {
  const notes: string[] = [];
  let shot = 0;
  const snap = async (page: Page, name: string, extra?: unknown) => {
    opts.log(name);
    if (!opts.debugDir) return;
    shot++;
    const base = join(opts.debugDir, `${String(shot).padStart(2, "0")}-${name}`);
    await page.screenshot(`${base}.png`).catch(() => undefined);
    if (extra !== undefined) await writeFile(`${base}.json`, JSON.stringify(extra, null, 2)).catch(() => undefined);
  };
  if (opts.debugDir) await mkdir(opts.debugDir, { recursive: true });

  // Present as ordinary Chrome; the headless marker in the user agent alone
  // gets some sign-in pages to refuse service. Nothing else is disguised.
  const { userAgent } = (await browser.send("Browser.getVersion")) as { userAgent: string };
  const ua = userAgent.replace("HeadlessChrome", "Chrome");
  await browser.addHook(async (p) => {
    await p.send("Emulation.setUserAgentOverride", { userAgent: ua, acceptLanguage: "en-US,en" }).catch(() => undefined);
  });

  // PDF capture runs on every tab; it only records once `collecting` is on.
  let collecting = false;
  const captured: Array<{ at: number; bytes: Buffer }> = [];
  // PDF addresses whose bytes Chrome would not hand over (its PDF viewer
  // replaces a tab's body with a wrapper; a script that reads a response as a
  // blob leaves nothing behind). These are fetched again from the signed-in tab.
  const pdfUrls: Array<{ at: number; url: string }> = [];
  const pdfRequests = new Map<string, string>();
  await browser.addHook(async (p) => {
    p.on("Network.responseReceived", (e) => {
      const r = e.response as { mimeType?: string; url?: string };
      if (collecting && (r?.mimeType === "application/pdf" || /\.pdf(?:$|\?)/i.test(r?.url ?? ""))) {
        pdfRequests.set(String(e.requestId), r.url ?? "");
      }
    });
    p.on("Network.loadingFinished", (e) => {
      const id = String(e.requestId);
      const url = pdfRequests.get(id);
      if (url === undefined) return;
      pdfRequests.delete(id);
      const fallback = () => {
        if (url) pdfUrls.push({ at: Date.now(), url });
      };
      void p
        .send("Network.getResponseBody", { requestId: id })
        .then((b) => {
          const body = b as { body: string; base64Encoded: boolean };
          const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "latin1");
          if (isPdf(bytes)) captured.push({ at: Date.now(), bytes });
          else fallback();
        })
        .catch(fallback);
    });
  });
  browser.on("Browser.downloadProgress", (e) => {
    if (!collecting || e.state !== "completed") return;
    void readFile(join(browser.downloadDir, String(e.guid)))
      .then((bytes) => {
        if (isPdf(bytes)) captured.push({ at: Date.now(), bytes });
      })
      .catch(() => undefined);
  });

  const page = await browser.firstPage();

  /** After a submit, wait until the sign-in state visibly changes (or `ms` passes). */
  const waitForChange = async (before: LoginScan, ms: number) => {
    const key = scanKey(before);
    const until = Date.now() + ms;
    await sleep(1000);
    while (Date.now() < until) {
      const now = await page.evaluate<LoginScan>(scanLogin).catch(() => null);
      if (now && scanKey(now) !== key) return;
      await sleep(700);
    }
  };

  // ---------------- sign in ----------------
  await page.goto(carrier.loginUrl);
  await snap(page, "login-page");

  let passwordSubmittedAt = 0;
  let usernameSubmits = 0;
  let codeRequestedAt = 0;
  let codeEnteredAt = 0;
  let emailChosen = false;
  let cookiesHandled = false;
  let signedIn = false;
  const loginDeadline = Math.min(opts.deadline - 60_000, Date.now() + 200_000);

  while (Date.now() < loginDeadline) {
    const s = await page.evaluate<LoginScan>(scanLogin).catch(() => null);
    if (!s) {
      await sleep(1000);
      continue;
    }
    if (s.captcha) {
      await snap(page, "captcha");
      throw new Error(
        `[ECAPTCHA] ${carrier.name} showed a robot check. The plugin does not solve these. Sign in once by hand in Chrome, then try again later.`,
      );
    }
    if (s.cookieReject && !cookiesHandled) {
      cookiesHandled = true;
      await page.clickMark(s.cookieReject);
      await sleep(800);
      continue;
    }
    if (s.error && passwordSubmittedAt) {
      await snap(page, "login-error");
      throw new Error(`[ELOGIN_REJECTED] ${carrier.name} did not accept the sign-in: "${s.error}"`);
    }

    if (s.codeInputs.length > 0) {
      if (codeEnteredAt) {
        if (Date.now() - codeEnteredAt > 20_000) {
          await snap(page, "code-not-accepted");
          throw new Error(`[ECODE_REJECTED] ${carrier.name} did not accept the emailed login code.`);
        }
        await sleep(1500);
        continue;
      }
      await snap(page, "code-requested");
      const since = new Date((codeRequestedAt || passwordSubmittedAt || Date.now()) - 15_000);
      opts.log("waiting-for-email-code");
      const code = await opts.getCode(since);
      const boxes = s.codeInputs;
      if (boxes.length === 1 || code.length % boxes.length !== 0) {
        await page.typeIntoMark(boxes[0], code);
      } else {
        const per = code.length / boxes.length;
        for (let i = 0; i < boxes.length; i++) await page.typeIntoMark(boxes[i], code.slice(i * per, (i + 1) * per));
      }
      const again = await page.evaluate<LoginScan>(scanLogin).catch(() => s);
      if (again.submit) await page.clickMark(again.submit);
      else await page.pressEnter();
      codeEnteredAt = Date.now();
      await page.waitForLoad(20_000);
      continue;
    }

    if (passwordSubmittedAt && !emailChosen && s.emailChoice) {
      emailChosen = true;
      await snap(page, "choose-email");
      await page.clickMark(s.emailChoice);
      codeRequestedAt = Date.now();
      await sleep(1200);
      const after = await page.evaluate<LoginScan>(scanLogin).catch(() => null);
      if (after && after.codeInputs.length === 0 && after.sendCode) {
        await page.clickMark(after.sendCode);
        codeRequestedAt = Date.now();
      }
      await sleep(1500);
      continue;
    }

    if (s.password) {
      if (passwordSubmittedAt) {
        // Password box is back without an error message. Never submit twice.
        if (Date.now() - passwordSubmittedAt > 15_000) {
          await snap(page, "password-again");
          throw new Error(`[ELOGIN_REJECTED] ${carrier.name} asked for the password again. Check the saved user name and password.`);
        }
        await sleep(1500);
        continue;
      }
      if (s.username && !s.usernameFilled) await page.typeIntoMark(s.username, opts.username);
      await page.typeIntoMark(s.password, opts.password);
      await snap(page, "credentials-entered");
      if (s.submit) await page.clickMark(s.submit);
      else await page.pressEnter();
      passwordSubmittedAt = Date.now();
      await waitForChange(s, 30_000);
      await snap(page, "after-password");
      continue;
    }

    if (s.username && !passwordSubmittedAt) {
      if (usernameSubmits >= 2) {
        await snap(page, "username-again", describeScan(s));
        throw new Error(
          `[ELOGIN_REJECTED] ${carrier.name} kept asking for the user name` + (s.error ? `: "${s.error}"` : ".") ,
        );
      }
      usernameSubmits++;
      if (!s.usernameFilled || usernameSubmits === 1) await page.typeIntoMark(s.username, opts.username);
      await snap(page, `username-entered-${usernameSubmits}`, describeScan(s));
      if (s.submit) await page.clickMark(s.submit);
      else await page.pressEnter();
      await waitForChange(s, 20_000);
      await snap(page, `after-username-${usernameSubmits}`);
      continue;
    }

    const host = s.host.toLowerCase();
    const onPortal = carrier.siteDomains.some((d) => host === d || host.endsWith(`.${d}`)) && !/^login\./.test(host);
    if (passwordSubmittedAt && (s.signedInHint || (onPortal && Date.now() - passwordSubmittedAt > 8_000))) {
      signedIn = true;
      break;
    }
    await sleep(1500);
  }
  if (!signedIn) {
    await snap(page, "login-timeout");
    throw new Error(`[ELOGIN_TIMEOUT] Could not finish signing in to ${carrier.name} in time.`);
  }
  await snap(page, "signed-in");

  // ---------------- read-only from here ----------------
  let blockedRequests = 0;
  const guard = async (p: Page) => {
    p.on("Fetch.requestPaused", (e) => {
      const req = e.request as { method: string; url: string };
      if (shouldBlockRequest(req.method, req.url)) {
        blockedRequests++;
        opts.log("blocked-write-request", { method: req.method });
        void p.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      } else {
        void p.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
      }
    });
    await p.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  };
  await browser.addHook(guard);
  collecting = true;

  const documents: CapturedPdf[] = [];
  const seen = new Set<string>();
  const addPdf = (label: string, bytes: Buffer) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(sha256)) return false;
    seen.add(sha256);
    documents.push({ label, bytes, sha256 });
    return true;
  };

  const queue: string[] = [await page.url()];
  const visited = new Set<string>();
  const tried = new Set<string>();
  let pagesVisited = 0;
  const workDeadline = opts.deadline - 25_000;

  while (queue.length && pagesVisited < 10 && Date.now() < workDeadline && documents.length < opts.maxDocuments) {
    const url = queue.shift()!;
    const key = url.split("#")[0];
    if (visited.has(key) && pagesVisited > 0) continue;
    visited.add(key);
    if ((await page.url()) !== url) await page.goto(url).catch(() => undefined);
    pagesVisited++;

    // Single-page portals swap content in place; let a few safe in-page
    // navigation clicks happen on each page before moving on.
    for (let round = 0; round < 4 && Date.now() < workDeadline; round++) {
      const links = await page.evaluate<LinkInfo[]>(scanLinks).catch(() => [] as LinkInfo[]);
      await snap(page, `page-${pagesVisited}-${round}`, links.map((l) => ({ text: l.text, href: l.href ? new URL(l.href).pathname : "" })));

      for (const l of links) {
        if (l.href && isNavigationLink(l.text) && isSafeNavigationUrl(l.href, carrier.siteDomains)) {
          const k = l.href.split("#")[0];
          if (!visited.has(k) && !queue.includes(l.href)) queue.push(l.href);
        }
      }

      const docs = links.filter((l) => isDocumentLink(l.text, l.href));
      for (const d of docs) {
        if (documents.length >= opts.maxDocuments || Date.now() > workDeadline) break;
        const id = `${d.text}|${d.href}|${d.context}`;
        if (tried.has(id)) continue;
        tried.add(id);
        const label = makeLabel(d);
        if (d.href && isSafeNavigationUrl(d.href, carrier.siteDomains)) {
          const got = await fetchInPage(page, d.href);
          if (got) {
            const bytes = Buffer.from(got.b64, "base64");
            if (isPdf(bytes)) {
              if (addPdf(label, bytes)) opts.log("document-saved-in-memory");
              continue;
            }
          }
        }
        const before = await page.url();
        const clickAt = Date.now();
        await page.clickMark(d.mark);
        const until = Date.now() + 15_000;
        const arrived = () => captured.some((c) => c.at >= clickAt) || pdfUrls.some((u) => u.at >= clickAt);
        while (Date.now() < until && !arrived()) await sleep(500);
        await sleep(800);
        let got = 0;
        for (const c of captured.filter((c) => c.at >= clickAt)) if (addPdf(label, c.bytes)) got++;
        if (got === 0) {
          for (const u of pdfUrls.filter((u) => u.at >= clickAt)) {
            if (!isSafeNavigationUrl(u.url, carrier.siteDomains)) continue;
            const again = await fetchInPage(page, u.url);
            const bytes = again ? Buffer.from(again.b64, "base64") : null;
            if (bytes && isPdf(bytes) && addPdf(label, bytes)) break;
          }
        }
        // Close tabs the click opened, and return to where we were.
        for (const p of [...browser.pages.values()]) {
          if (p !== page) {
            await browser.send("Target.closeTarget", { targetId: p.targetId }).catch(() => undefined);
            browser.pages.delete(p.targetId);
          }
        }
        if ((await page.url()) !== before) await page.goto(before).catch(() => undefined);
      }

      const navButtons = links.filter((l) => !l.href && isNavigationLink(l.text) && !tried.has(`nav|${l.text}`));
      if (navButtons.length === 0) break;
      const nb = navButtons[0];
      tried.add(`nav|${nb.text}`);
      await page.clickMark(nb.mark);
      await page.waitForLoad(15_000);
      const now = await page.url();
      if (!visited.has(now.split("#")[0])) visited.add(now.split("#")[0]);
    }
  }

  if (documents.length === 0) {
    notes.push(
      `Signed in to ${carrier.name} but found no policy or declarations PDFs on the pages checked. The portal layout may need tuning; turn on 'Debug screenshots' in the plugin settings and run again.`,
    );
  }
  if (documents.length >= opts.maxDocuments) notes.push(`Stopped at the limit of ${opts.maxDocuments} documents.`);
  if (Date.now() >= workDeadline) notes.push("Stopped early to stay inside the 5-minute tool limit; some documents may be missing.");
  return { documents, pagesVisited, blockedRequests, notes };
}

function makeLabel(l: LinkInfo): string {
  const text = l.text.replace(/\s+/g, " ").trim();
  const generic = /^(view|download|open|pdf|view pdf|download pdf|print|view document|document)$/i.test(text) || text.length < 6;
  let label = text;
  if (generic && l.context) {
    label = `${l.context.replace(text, "").trim()} ${text}`.trim();
  }
  return label.slice(0, 80) || "Document";
}
