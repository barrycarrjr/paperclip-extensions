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
  findDate,
  isDangerous,
  isDocumentLink,
  isNavigationLink,
  isSafeNavigationUrl,
  policyAddresses,
  policyNumberIn,
  policyNumbersIn,
  streetAddressesIn,
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
  /** Name of a file already saved for this document, if any: it is then not downloaded again. */
  alreadyHave?: (doc: { policy: string; title: string; posted: string | null }) => string | null;
}

export interface CapturedPdf {
  /** Everything known about it in one line (used when nothing better exists). */
  label: string;
  /** Which policy it belongs to, e.g. "12 Oak St - Policy 1234567" ("" if unknown). */
  policy: string;
  /** The document's own name as listed, without dates ("RENEWAL", "Declarations Page"). */
  title: string;
  /** Date the portal says it was posted, YYYY-MM-DD, if shown. */
  posted: string | null;
  bytes: Buffer;
  sha256: string;
}

type DocMeta = Omit<CapturedPdf, "bytes" | "sha256">;

export interface RunResult {
  documents: CapturedPdf[];
  pagesVisited: number;
  blockedRequests: number;
  /** Method and address (no query) of each blocked request, for checking the guard. */
  blockedPaths: string[];
  /** Policy/account numbers and street addresses shown after sign-in, for an operator's private list. */
  identifiers: string[];
  /** Documents not downloaded because a file for them is already saved. */
  skipped: Array<{ policy: string; title: string; posted: string | null; label: string; existingName: string }>;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Page-side scanners. These run inside the portal page, so they must be
// self-contained: no closures over Node variables.
// ---------------------------------------------------------------------------

/** True while a loading spinner or a page-covering overlay is on screen. */
export function pageBusy(): boolean {
  const vis = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const st = getComputedStyle(el as HTMLElement);
    return st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05;
  };
  const spinner = [
    ...document.querySelectorAll(
      '[role=progressbar], [aria-busy=true], [class*=spinner], [class*=Spinner], [class*=loader], [class*=Loader], [class*=loading], [class*=Loading], [class*=busy]',
    ),
  ].some(vis);
  // A stray "loading" class on a finished page is common (lazy images), so a
  // spinner only counts while the page has little else on it.
  const boxes = [...document.querySelectorAll('[onclick], [tabindex="0"], [kwidgettype]')].filter((e) => getComputedStyle(e as HTMLElement).cursor === "pointer" && !e.querySelector("a, button, input, [onclick]"));
  const links = [...document.querySelectorAll("a, button, [role=button], [role=link]"), ...boxes].filter(
    (el) => !el.closest("footer, [role=contentinfo], [class*=footer], [id*=footer]") && vis(el),
  ).length;
  if (spinner && links < 6) return true;
  // A fixed layer over most of the window (a dimmed "please wait" screen).
  return [...document.querySelectorAll("body *")].some((el) => {
    const st = getComputedStyle(el as HTMLElement);
    if (st.position !== "fixed" || st.pointerEvents === "none" || !vis(el)) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < innerWidth * 0.9 || r.height < innerHeight * 0.9) return false;
    const bg = st.backgroundColor;
    return /rgba\([^)]*,\s*0?\.\d+\)/.test(bg) && !/,\s*0\)$/.test(bg);
  });
}

/** Visible links and buttons outside the page footer: a rough "is there a page here" count. */
export function contentLinkCount(): number {
  const boxes = [...document.querySelectorAll('[onclick], [tabindex="0"], [kwidgettype]')].filter((e) => getComputedStyle(e as HTMLElement).cursor === "pointer" && !e.querySelector("a, button, input, [onclick]"));
  return [...document.querySelectorAll("a, button, [role=button], [role=link]"), ...boxes].filter((el) => {
    if (el.closest("footer, [role=contentinfo], [class*=footer], [id*=footer]")) return false;
    const r = (el as HTMLElement).getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  }).length;
}

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
  /** An unticked "remember this device / trust this browser" box. */
  rememberBox: string | null;
  /** A "trust this browser" / "remember this device" button. */
  trustButton: string | null;
  /** The code page says the code went by text or phone, not email. */
  codeSentByText: boolean;
  /** "Try another method" and similar, to switch the code to email. */
  otherMethod: string | null;
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
  // Code boxes count even with the password box still showing: Selective
  // opens its code step as a pop-up over the sign-in form.
  const codeInputs = inputs.filter(isCode);
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
    // Plain boxes acting as buttons (Selective's "Log Out" is one).
    ...[...document.querySelectorAll('[onclick], [tabindex="0"], [kwidgettype]')].filter((e) => getComputedStyle(e as HTMLElement).cursor === "pointer" && !e.querySelector("a, button, input, [onclick]")),
  ].filter(visible);

  // Look for the submit control near the field first (the field's own form,
  // dialog or login panel), then anywhere on the page.
  const field = codeInputs[0] ?? password ?? username;
  const scope = field?.parentElement?.closest("form, [role=dialog], [class*=modal], [class*=login], [id*=Login], [id*=login]") ?? null;
  const submitRe = /^(log ?in|sign ?in|continue|next|submit|verify|verify code|confirm|ok|done)$/i;
  const pickSubmit = (pool: Element[]) =>
    pool.find((c) => submitRe.test(label(c)) && c.tagName !== "A" && c.tagName !== "LABEL") ??
    pool.find((c) => (c as HTMLInputElement).type === "submit" && !/(reject|accept|cookie)/i.test(label(c))) ??
    null;
  let submitEl = (scope ? pickSubmit(clickables.filter((c) => scope.contains(c))) : null) ?? (field ? pickSubmit(clickables) : null);
  if (codeInputs.length) {
    // On a code step the button is the one after the code boxes ("Next",
    // "Continue", "Verify"), never the sign-in form's "Log In" that may share
    // the same panel (Selective).
    const last = codeInputs[codeInputs.length - 1];
    const after = clickables.filter(
      (c) => last.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING && c.tagName !== "A" && c.tagName !== "LABEL",
    );
    const codeSubmit =
      after.find((c) => /^(next|continue|submit|verify|verify code|confirm|ok|done|validate code)$/i.test(label(c))) ??
      after.find((c) => (c as HTMLInputElement).type === "submit" && !/^(log ?in|sign ?in)$/i.test(label(c)));
    if (codeSubmit) submitEl = codeSubmit;
    else if (submitEl && /^(log ?in|sign ?in)$/i.test(label(submitEl))) submitEl = null;
  }

  let emailChoice: Element | null = null;
  let sendCode: Element | null = null;
  {
    const pageText = document.body.innerText.toLowerCase();
    // A button that plainly says "Send Email" is the choice itself, whatever
    // the surrounding text says (Selective's pop-up, shown over the sign-in
    // form, so the password box may still be on screen).
    const plainEmail = clickables.find((c) => /^(send )?(an )?e-?mail( me)?( (a|the|my) code)?$/i.test(label(c)));
    // Reading the page for "code"/"verify" wording only once the sign-in
    // form is gone; the sign-in page itself often mentions codes.
    const mfaPage = !password && /(code|verif|confirm (?:it'?s|your identity)|security check|two.?step|multi.?factor)/.test(pageText);
    if (plainEmail) emailChoice = plainEmail;
    else if (mfaPage) {
      emailChoice =
        clickables.find((c) => {
          const t = label(c).toLowerCase();
          if (!/e-?mail/.test(t) || /(text|sms|call|phone|voice|user ?name|forgot|sign ?in|log ?in)/.test(t)) return false;
          // The label of a typing box ("Username/email") is not a choice.
          const ctl = (c as HTMLLabelElement).control as HTMLInputElement | null | undefined;
          if (c.tagName === "LABEL" && ctl && !["radio", "checkbox"].includes(ctl.type)) return false;
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
        clickables.find((c) =>
          /^(send|send code|send me (?:a|the) code|send (?:a )?code|get code|continue|next|e-?mail me|e-?mail me (?:a|the) code|send (?:me )?(?:an )?e-?mail|send code (?:by|via|to) e-?mail)$/i.test(label(c)),
        ) ?? null;
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

  // "Remember this device", "Trust this browser", "Don't ask again on this
  // device", "Keep me signed in". Only these; a "save username" box is not one.
  const rememberRe =
    /(remember (?:this |my )?(?:device|browser|computer)|trust (?:this |my )?(?:device|browser|computer)|(?:don'?t|do not) (?:ask|challenge) (?:me )?(?:again|for a code)|skip (?:this|verification) (?:step )?(?:next time|on this)|keep me (?:signed|logged) in|stay (?:signed|logged) in|remember me\b)/i;
  const boxLabel = (b: HTMLInputElement) =>
    [b.labels?.[0]?.textContent, b.getAttribute("aria-label"), b.closest("label")?.textContent, b.parentElement?.textContent]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .slice(0, 200);
  const rememberEl =
    ([...document.querySelectorAll("input[type=checkbox], [role=checkbox], [role=switch]")] as HTMLInputElement[]).find((b) => {
      const checked = b.tagName === "INPUT" ? b.checked : b.getAttribute("aria-checked") === "true";
      if (checked) return false;
      const lab = b.tagName === "INPUT" ? boxLabel(b) : label(b) || boxLabel(b);
      if (!rememberRe.test(lab)) return false;
      // A styled checkbox often hides the input itself; its label is what shows.
      return visible(b) || (!!b.labels?.[0] && visible(b.labels[0]));
    }) ?? null;
  const trustEl =
    clickables.find((c) =>
      c.tagName !== "LABEL" &&
      c.tagName !== "INPUT" &&
      !c.querySelector("input[type=checkbox], [role=checkbox]") &&
      c.getAttribute("role") !== "checkbox" &&
      /^(?:yes,? )?(?:trust|remember) (?:this )?(?:device|browser|computer)$|^(?:yes,? )?(?:trust|remember)$|^don'?t ask again$/i.test(label(c)),
    ) ?? null;

  const bodyText = document.body.innerText;
  const codeSentByText =
    codeInputs.length > 0 &&
    /(text message|texted|\bsms\b|sent (?:a |the |your )?(?:code |verification code )?to (?:your )?(?:phone|mobile)|\(\W*\d{0,3}\W*\)\s*\W*-?\d{4}|[•*]{2,}\W?\d{4}\b|ending in \d{4}|voice call)/i.test(bodyText) &&
    !/@|e-?mail/i.test(bodyText.replace(/(?:email|e-mail) (?:or|and) (?:text|phone)|(?:text|phone) (?:or|and) e-?mail/gi, ""));
  const otherMethodEl = codeSentByText
    ? clickables.find((c) =>
        /^(try another (?:method|way)|choose another (?:method|way)|use another (?:method|way)|use a different (?:method|way)|other (?:verification )?(?:options|methods)|more options|send (?:the |a )?code (?:by|via|to) e-?mail|e-?mail me (?:a|the) code(?: instead)?|use e-?mail(?: instead)?|get (?:a|the) code by e-?mail)$/i.test(label(c)),
      ) ?? null
    : null;
  const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="captcha"], .g-recaptcha, #px-captcha');
  const signedInHint = clickables.some((c) => /^(log ?out|sign ?out|log off)$/i.test(label(c)));

  return {
    host: location.hostname,
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
    rememberBox: rememberEl ? mark(rememberEl) : null,
    codeSentByText,
    otherMethod: otherMethodEl ? mark(otherMethodEl) : null,
    trustButton: trustEl ? mark(trustEl) : null,
    signedInHint,
  };
}

/**
 * A safe "no" on a pop-up or interstitial shown after sign-in ("Go
 * paperless?", "Set up autopay?", "Confirm your phone", a cookie banner).
 * Returns the mark of a decline button, or null. Only plain declines count:
 * never a button that enrolls, accepts, confirms or saves anything.
 */
export function findDecline(): string | null {
  let n = Number((window as any).__pcipN || 0);
  const vis = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el as HTMLElement);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const say = (el: Element) =>
    [(el as HTMLElement).innerText, (el as HTMLInputElement).value, el.getAttribute("aria-label")]
      .filter((x) => typeof x === "string" && x.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  const decline =
    /^(not now|skip|skip for now|skip this step|remind me later|maybe later|ask me later|no,? thanks|no thank you|close|dismiss|reject|reject all|decline|decline all|necessary only|continue to (?:my )?account|go to (?:my )?account|continue to (?:my )?dashboard|i'?ll do this later|later|x|×)$/i;
  const onetrust = document.querySelector("#onetrust-reject-all-handler");
  if (onetrust && vis(onetrust)) {
    let m = onetrust.getAttribute("data-pcip");
    if (!m) onetrust.setAttribute("data-pcip", (m = `m${++n}`));
    (window as any).__pcipN = n;
    return m;
  }
  // Only inside something that looks like a pop-up or an interstitial page.
  const layers = [...document.querySelectorAll('[role=dialog], [role=alertdialog], [aria-modal=true], [class*=modal], [class*=Modal], [class*=interstitial], [class*=overlay], [id*=modal]')].filter(vis);
  for (const layer of layers) {
    const text = (layer as HTMLElement).innerText.toLowerCase();
    if (!/(paperless|autopay|auto-pay|automatic payment|verify your|confirm your|update your|survey|feedback|cookies|notifications|text alerts|new feature|what'?s new|tour|welcome)/.test(text)) continue;
    const btn = [...layer.querySelectorAll("button, a, [role=button], input[type=button]")].find((b) => vis(b) && decline.test(say(b)));
    if (btn) {
      let m = btn.getAttribute("data-pcip");
      if (!m) btn.setAttribute("data-pcip", (m = `m${++n}`));
      (window as any).__pcipN = n;
      return m;
    }
  }
  return null;
}

interface LinkInfo {
  mark: string;
  text: string;
  href: string;
  context: string;
  /** Inside the page footer: never used for navigation. */
  footer: boolean;
  /** The words shown on screen (no screen-reader text), icon names removed. */
  shown: string;
  /** The page marks it as a PDF (a PDF icon, "PDF" in its label or address). */
  pdfHint: boolean;
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
  const standard = 'a, button, [role=button], [role=link], [role=tab], [role=menuitem], input[type=button]';
  // Some portals (Selective) build buttons from plain boxes with a click
  // handler and a pointer cursor; count the innermost such box too.
  const boxes = [...document.querySelectorAll('[onclick], [tabindex="0"], [kwidgettype]')].filter(
    (e) =>
      !e.matches(standard) &&
      !e.closest(standard) &&
      !e.querySelector(`${standard}, input, [onclick]`) &&
      getComputedStyle(e as HTMLElement).cursor === "pointer",
  );
  const els = [...document.querySelectorAll(standard), ...boxes];
  for (const el of els) {
    if (!visible(el)) continue;
    const h = el as HTMLAnchorElement;
    const raw = [h.innerText, h.getAttribute("aria-label"), h.getAttribute("title"), h.getAttribute("href")].join(" ");
    const pdfHint = /picture_as_pdf|\bpdf\b|\.pdf\b/i.test(raw);
    // Icon-font ligatures are snake_case words ("chevron_right", "picture_as_pdf").
    const shown = (h.innerText || "").replace(/\b[a-z]+(?:_[a-z]+)+\b/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    const text = [h.innerText, (h as unknown as HTMLInputElement).value, h.getAttribute("aria-label"), h.getAttribute("title")]
      .filter((x) => typeof x === "string" && x.trim())
      .join(" ")
      .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, " ")
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
    const footer = !!el.closest("footer, [role=contentinfo], [class*=footer], [class*=Footer], [id*=footer]");
    out.push({ mark: m, text, href, context, footer, shown, pdfHint });
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
  // Debug only: how each PDF arrived and when, to tune for slow portals.
  // Addresses are reduced to host + path; no query strings, no contents.
  const captureLog: Array<Record<string, unknown>> = [];
  const runStart = Date.now();
  const logCapture = (event: string, meta: Record<string, unknown> = {}) => {
    if (opts.debugDir && captureLog.length < 500) captureLog.push({ s: Math.round((Date.now() - runStart) / 100) / 10, event, ...meta });
  };
  // Debug only: each navigation decision, to see why a policy was or was not reached.
  const navEvents: Array<Record<string, unknown>> = [];
  const navLog = (event: string, meta: Record<string, unknown> = {}) => {
    if (opts.debugDir && navEvents.length < 300) navEvents.push({ s: Math.round((Date.now() - runStart) / 100) / 10, event, ...meta });
  };
  const pathOf = (u?: string) => {
    try {
      const x = new URL(u ?? "");
      return x.protocol === "blob:" ? "blob:" : `${x.hostname}${x.pathname}`;
    } catch {
      return "";
    }
  };
  // PDF addresses whose bytes Chrome would not hand over (its PDF viewer
  // replaces a tab's body with a wrapper; a script that reads a response as a
  // blob leaves nothing behind). These are fetched again from the signed-in tab.
  const pdfUrls: Array<{ at: number; url: string }> = [];
  const pdfRequests = new Map<string, string>();
  await browser.addHook(async (p) => {
    p.on("Network.responseReceived", (e) => {
      const r = e.response as { mimeType?: string; url?: string; headers?: Record<string, string> };
      const disposition = Object.entries(r?.headers ?? {}).find(([k]) => k.toLowerCase() === "content-disposition")?.[1] ?? "";
      const looksPdf =
        r?.mimeType === "application/pdf" ||
        /\.pdf(?:$|\?)/i.test(r?.url ?? "") ||
        /\.pdf\b/i.test(disposition) ||
        (r?.mimeType === "application/octet-stream" && /document|download|pdf/i.test(r?.url ?? ""));
      if (collecting && looksPdf) {
        pdfRequests.set(String(e.requestId), r.url ?? "");
        logCapture("response", { mime: r?.mimeType, type: e.type, path: pathOf(r?.url), disposition: disposition ? "yes" : "no" });
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
          if (isPdf(bytes)) {
            captured.push({ at: Date.now(), bytes });
            logCapture("body-captured", { bytes: bytes.length });
          } else {
            logCapture("body-not-pdf", { bytes: bytes.length });
            fallback();
          }
        })
        .catch(() => {
          logCapture("body-unavailable");
          fallback();
        });
    });
  });
  browser.on("Browser.downloadWillBegin", (e) => {
    if (collecting) logCapture("download-begin", { path: pathOf(String(e.url ?? "")) });
  });
  browser.on("Browser.downloadProgress", (e) => {
    if (!collecting || e.state !== "completed") return;
    void readFile(join(browser.downloadDir, String(e.guid)))
      .then((bytes) => {
        logCapture("download-complete", { bytes: bytes.length, pdf: isPdf(bytes) });
        if (isPdf(bytes)) captured.push({ at: Date.now(), bytes });
      })
      .catch(() => undefined);
  });
  browser.on("Target.targetCreated", (e) => {
    const info = e.targetInfo as { type?: string; url?: string };
    if (collecting && info?.type === "page") logCapture("new-tab", { scheme: String(info.url ?? "").split(":")[0] });
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
  let switchedMethod = false;
  let sendClicked = false;
  let emailChosenAt = 0;
  let cookiesHandled = false;
  const rememberClicked = new Set<string>();
  const loginStartedAt = Date.now();
  let signedIn = false;
  let busySince = 0;
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
    if (s.rememberBox && !rememberClicked.has(s.rememberBox)) {
      rememberClicked.add(s.rememberBox);
      opts.log("remember-device-ticked");
      // Click the box, or its label when the box itself is hidden by styling.
      const ok = await page.evaluate<boolean>((m: string) => {
        const b = document.querySelector(`[data-pcip="${m}"]`) as HTMLInputElement | null;
        if (!b) return false;
        const target = (b.getBoundingClientRect().width > 2 ? b : b.labels?.[0]) as HTMLElement | undefined;
        if (!target) return false;
        target.scrollIntoView({ block: "center" });
        return true;
      }, s.rememberBox);
      if (ok) await page.clickMark(s.rememberBox);
      await sleep(400);
      continue;
    }
    if (s.trustButton && !rememberClicked.has(s.trustButton) && (codeEnteredAt || passwordSubmittedAt)) {
      rememberClicked.add(s.trustButton);
      opts.log("trust-browser-clicked");
      await snap(page, "trust-browser");
      await page.clickMark(s.trustButton);
      await waitForChange(s, 20_000);
      continue;
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

    if (s.codeInputs.length > 0 && s.codeSentByText && !codeEnteredAt) {
      // The portal sent the code by text (its default). Switch to email; the
      // plugin can only read email.
      if (s.otherMethod && !switchedMethod) {
        switchedMethod = true;
        await snap(page, "code-by-text-switching");
        opts.log("code-sent-by-text-switching-to-email");
        await page.clickMark(s.otherMethod);
        emailChosen = false;
        sendClicked = false;
        await waitForChange(s, 15_000);
        continue;
      }
      await snap(page, "code-by-text");
      throw new Error(
        `[ECODE_BY_TEXT] ${carrier.name} sent the login code by text message and offered no way to switch to email. Set email as the verification method in your ${carrier.name} account settings, or sign in once by hand and choose email with "remember this device".`,
      );
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
      if (boxes.length === 1) {
        await page.typeIntoMark(boxes[0], code);
      } else {
        // Several boxes (Selective shows four): fill each with as many
        // characters as it accepts (its maxlength), else split evenly.
        const sizes = await page
          .evaluate<number[]>((ms: string[]) => ms.map((m) => (document.querySelector(`[data-pcip="${m}"]`) as HTMLInputElement | null)?.maxLength ?? -1), boxes)
          .catch(() => boxes.map(() => -1));
        const total = sizes.reduce((a, b) => a + (b > 0 ? b : 0), 0);
        let parts: string[];
        if (sizes.every((n) => n > 0) && total === code.length) {
          let at = 0;
          parts = sizes.map((n) => code.slice(at, (at += n)));
        } else if (code.length % boxes.length === 0) {
          const per = code.length / boxes.length;
          parts = boxes.map((_, i) => code.slice(i * per, (i + 1) * per));
        } else if (sizes.every((n) => n === 1) || total >= code.length) {
          parts = boxes.map((_, i) => code[i] ?? "");
        } else {
          parts = [code, ...boxes.slice(1).map(() => "")];
        }
        for (let i = 0; i < boxes.length; i++) if (parts[i]) await page.typeIntoMark(boxes[i], parts[i]);
      }
      const again = await page.evaluate<LoginScan>(scanLogin).catch(() => s);
      if (again.submit) await page.clickMark(again.submit);
      else await page.pressEnter();
      codeEnteredAt = Date.now();
      await page.waitForLoad(20_000);
      continue;
    }

    // Email was picked but the code was not sent yet: the send button
    // ("Email me", "Send code") may only appear once email is selected.
    if (passwordSubmittedAt && emailChosen && !sendClicked && !codeEnteredAt && s.sendCode) {
      sendClicked = true;
      await snap(page, "send-code-by-email");
      await page.clickMark(s.sendCode);
      codeRequestedAt = Date.now();
      await waitForChange(s, 20_000);
      continue;
    }
    if (passwordSubmittedAt && emailChosen && !codeEnteredAt && Date.now() - emailChosenAt > 60_000) {
      await snap(page, "no-code-boxes");
      throw new Error(`[ECODE_STEP] ${carrier.name} asked how to send a login code, but no code boxes appeared after choosing email.`);
    }

    if (passwordSubmittedAt && !emailChosen && s.emailChoice) {
      emailChosen = true;
      emailChosenAt = Date.now();
      await snap(page, "choose-email");
      await page.clickMark(s.emailChoice);
      codeRequestedAt = Date.now();
      await sleep(1200);
      const after = await page.evaluate<LoginScan>(scanLogin).catch(() => null);
      if (after && after.codeInputs.length === 0 && after.sendCode) {
        sendClicked = true;
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
    const curPath = await page.url().then((u) => {
      try {
        return new URL(u).pathname;
      } catch {
        return "";
      }
    });
    // Still on a sign-in site or step (Liberty Mutual's sign-in page even has
    // a "Log out" button): a sign-out control there proves nothing.
    const onLoginSite = /^(login|auth|sso|signin|identity|id)\./.test(host) || /log-?in|sign-?in|\/auth|mfa|verify|otp/i.test(curPath);
    const signedInHint = s.signedInHint && !onLoginSite;
    const onPortal = carrier.siteDomains.some((d) => host === d || host.endsWith(`.${d}`)) && !onLoginSite;
    if (passwordSubmittedAt) {
      // No sign-in boxes left. Only call it signed in once any loading
      // spinner has cleared and there is a real page (a sign-out control, or
      // a handful of links outside the footer).
      const busy = await page.evaluate<boolean>(pageBusy).catch(() => true);
      if (busy) {
        busySince ||= Date.now();
        if (Date.now() - busySince > 90_000) {
          await snap(page, "stuck-loading");
          throw new Error(`[ELOGIN_STUCK] ${carrier.name} was still showing its loading screen 90 seconds after sign-in.`);
        }
        await sleep(1500);
        continue;
      }
      busySince = 0;
      const links = await page.evaluate<number>(contentLinkCount).catch(() => 0);
      if (signedInHint || (onPortal && links >= 4 && Date.now() - passwordSubmittedAt > 8_000)) {
        signedIn = true;
        break;
      }
    } else if (!s.username && !s.password && s.codeInputs.length === 0 && !s.emailChoice) {
      // The kept profile may still hold a session: the portal skipped the
      // sign-in page. Require a sign-out control, or a settled page with real
      // content whose address is not a sign-in address.
      const busy = await page.evaluate<boolean>(pageBusy).catch(() => true);
      const path = new URL((await page.url()) || "about:blank").pathname;
      const links = busy ? 0 : await page.evaluate<number>(contentLinkCount).catch(() => 0);
      if (
        !busy &&
        (signedInHint || (onPortal && links >= 4 && !/log-?in|sign-?in|auth|mfa|verify/i.test(path) && Date.now() - loginStartedAt > 8_000))
      ) {
        opts.log("already-signed-in");
        notes.push(`Already signed in to ${carrier.name} from an earlier run; no password or code was needed.`);
        signedIn = true;
        break;
      }
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
  const blockedPaths: string[] = [];
  const guard = async (p: Page) => {
    p.on("Fetch.requestPaused", (e) => {
      const req = e.request as { method: string; url: string };
      // Response stage (only for page loads): take a PDF's bytes here, before
      // Chrome's PDF viewer replaces them, so it never has to be fetched twice.
      if (e.responseStatusCode !== undefined) {
        const headers = (e.responseHeaders as Array<{ name: string; value: string }> | undefined) ?? [];
        const type = headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? "";
        const disp = headers.find((h) => h.name.toLowerCase() === "content-disposition")?.value ?? "";
        if (/application\/pdf/i.test(type) || /\.pdf\b/i.test(disp)) {
          void p
            .send("Fetch.getResponseBody", { requestId: e.requestId })
            .then((b) => {
              const body = b as { body: string; base64Encoded: boolean };
              const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "latin1");
              if (isPdf(bytes)) {
                captured.push({ at: Date.now(), bytes });
                logCapture("body-captured-early", { bytes: bytes.length });
              }
            })
            .catch(() => logCapture("early-body-unavailable"))
            .finally(() => void p.send("Fetch.continueResponse", { requestId: e.requestId }).catch(() => undefined));
        } else {
          void p.send("Fetch.continueResponse", { requestId: e.requestId }).catch(() => undefined);
        }
        return;
      }
      if (shouldBlockRequest(req.method, req.url)) {
        blockedRequests++;
        try {
          const u = new URL(req.url);
          if (blockedPaths.length < 50) blockedPaths.push(`${req.method} ${u.hostname}${u.pathname}`);
        } catch {
          // keep the count only
        }
        opts.log("blocked-write-request", { method: req.method });
        void p.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
      } else {
        void p.send("Fetch.continueRequest", { requestId: e.requestId }).catch(() => undefined);
      }
    });
    await p.send("Fetch.enable", {
      patterns: [
        { urlPattern: "*", requestStage: "Request" },
        { urlPattern: "*", resourceType: "Document", requestStage: "Response" },
      ],
    });
  };
  await browser.addHook(guard);
  collecting = true;

  const documents: CapturedPdf[] = [];
  const skipped: RunResult["skipped"] = [];
  const identifiers = new Set<string>();
  const seen = new Set<string>();
  const addPdf = (meta: DocMeta, bytes: Buffer) => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (seen.has(sha256)) return false;
    seen.add(sha256);
    documents.push({ ...meta, bytes, sha256 });
    return true;
  };

  /** Let the page finish: loading screen gone, then a short pause for late content. */
  const settle = async (ms = 30_000) => {
    const until = Date.now() + ms;
    while (Date.now() < until && (await page.evaluate<boolean>(pageBusy).catch(() => false))) await sleep(1000);
    // Decline any "go paperless / set up autopay / confirm your phone" pop-up.
    for (let i = 0; i < 3; i++) {
      const no = await page.evaluate<string | null>(findDecline).catch(() => null);
      if (!no) break;
      navLog("declined-popup");
      await page.clickMark(no);
      await sleep(1200);
    }
    // A page whose main area is still empty is usually still rendering:
    // wait for some text, then for it to stop changing.
    const mainUntil = Date.now() + 15_000;
    let last = -1;
    while (Date.now() < mainUntil) {
      const len = await page
        .evaluate<number>(() => {
          const m = document.querySelector("main, [role=main]");
          return m ? (m as HTMLElement).innerText.trim().length : -2;
        })
        .catch(() => -2);
      if (len === -2 || (len > 0 && len === last)) break;
      last = len;
      await sleep(700);
    }
    await sleep(500);
  };
  /**
   * Find a visible element by its exact link text and mark it, waiting up to
   * `waitMs` for it to appear (a page redrawn after Back fills in late).
   */
  const markByText = async (text: string, waitMs = 0): Promise<string | null> => {
    const until = Date.now() + waitMs;
    for (;;) {
      const m = await page
        .evaluate<LinkInfo[]>(scanLinks)
        .then((ls) => ls.find((l) => l.text === text && !l.footer)?.mark ?? null)
        .catch(() => null);
      if (m || Date.now() >= until) return m;
      await sleep(700);
    }
  };

  // What each page is about ("12 Oak St Policy 1234567"), learnt from the
  // button that led there; used to name the files saved from it.
  const pageContext = new Map<string, string>();
  const addresses: Record<string, string> = {};
  const contextFor = (text: string, fallback = ""): string => {
    const n = policyNumberIn(text);
    if (!n) return fallback;
    return [addresses[n], `Policy ${n}`].filter(Boolean).join(" - ");
  };
  const keyOf = (u: string) => u.split("#")[0];

  const queue: string[] = [];
  const visited = new Set<string>();
  const tried = new Set<string>();
  let pagesVisited = 0;
  const workDeadline = opts.deadline - 25_000;
  // Set only when the clock actually cut work short, so the note is true.
  let ranOut = false;
  const outOfTime = () => {
    if (Date.now() > workDeadline) ranOut = true;
    return ranOut;
  };
  const enqueue = (u: string, ctx: string) => {
    const k = keyOf(u);
    if (visited.has(k) || queue.some((q) => keyOf(q) === k)) return;
    if (/\.pdf(?:$|[?#])/i.test(u) || !isSafeNavigationUrl(u, carrier.siteDomains)) return;
    queue.push(u);
    if (ctx && !pageContext.has(k)) pageContext.set(k, ctx);
  };

  /**
   * Save the document links in `found`. On a list of dated PDFs only the
   * current term is kept. A link that turns out to open a page rather than
   * a PDF is queued as a page to read instead.
   */
  const takeDocs = async (found: LinkInfo[], ctx: string, docsPage = false) => {
    // Every listed document is fetched; which terms to keep is decided once
    // the term dates have been read from the PDFs.
    // On a page that is a list of documents, a dated entry is a document even
    // with no PDF mark or telling name ("Policy Change Confirmation 03/12/2026").
    // Titles like "Policy Change Confirmation" or "Cancellation Notice" name
    // a document; only an entry that starts with an action is refused.
    const datedOnList = (l: LinkInfo) =>
      docsPage &&
      !!findDate(l.text) &&
      !/^(make|pay|submit|cancel|change|update|edit|delete|remove|add|enroll|sign|request|report|start|set ?up|manage|go)\b/i.test((l.shown || l.text).trim()) &&
      !/(bill|invoice|payment|statement|receipt|claim)/i.test(l.text) &&
      !isNavigationLink(l.text);
    const docs = found.filter((l) => !l.footer && (isDocumentLink(l.text, l.href, l.pdfHint) || datedOnList(l)));
    for (const d of docs) {
      if (documents.length >= opts.maxDocuments || outOfTime()) break;
      const id = `${ctx}|${d.text}|${d.href}`;
      if (tried.has(id)) continue;
      tried.add(id);
      const meta = docMeta(d, contextFor(d.text, ctx));
      const existing = opts.alreadyHave?.(meta);
      if (existing) {
        skipped.push({ ...meta, existingName: existing });
        opts.log("document-already-saved");
        continue;
      }
      if (d.href && isSafeNavigationUrl(d.href, carrier.siteDomains)) {
        const got = await fetchInPage(page, d.href);
        if (got) {
          const bytes = Buffer.from(got.b64, "base64");
          if (isPdf(bytes)) {
            if (addPdf(meta, bytes)) opts.log("document-saved-in-memory");
            continue;
          }
        }
      }
      const before = await page.url();
      const clickAt = Date.now();
      logCapture("click-document");
      await page.clickMark(d.mark);
      const arrived = () => captured.some((c) => c.at >= clickAt) || pdfUrls.some((u) => u.at >= clickAt);
      // A PDF usually shows up within seconds. If the click moved to another
      // page instead, stop waiting early and read that page later.
      const until = Date.now() + 15_000;
      while (Date.now() < until && !arrived()) {
        await sleep(500);
        if (Date.now() - clickAt > 5_000 && (await page.url()) !== before && !arrived()) break;
      }
      await sleep(800);
      let got = 0;
      for (const c of captured.filter((c) => c.at >= clickAt)) if (addPdf(meta, c.bytes)) got++;
      if (got === 0) {
        for (const u of pdfUrls.filter((u) => u.at >= clickAt)) {
          if (!isSafeNavigationUrl(u.url, carrier.siteDomains)) continue;
          const again = await fetchInPage(page, u.url);
          const bytes = again ? Buffer.from(again.b64, "base64") : null;
          if (bytes && isPdf(bytes) && addPdf(meta, bytes)) {
            got++;
            break;
          }
        }
      }
      logCapture("document-done", { got, waitedS: Math.round((Date.now() - clickAt) / 100) / 10 });
      if (got > 0) opts.log("document-saved-in-memory");
      // Close tabs the click opened, and return to where we were.
      for (const p of [...browser.pages.values()]) {
        if (p !== page) {
          await browser.send("Target.closeTarget", { targetId: p.targetId }).catch(() => undefined);
          browser.pages.delete(p.targetId);
        }
      }
      const now = await page.url();
      if (now !== before) {
        if (got === 0) enqueue(now, contextFor(d.text, ctx));
        await page.goto(before).catch(() => undefined);
        await settle(20_000);
      }
    }
  };

  /** Go back to `here` the cheap way (browser Back), reloading only if that fails. */
  const goBack = async (here: string) => {
    await page.evaluate(() => history.back()).catch(() => undefined);
    const until = Date.now() + 8_000;
    while (Date.now() < until && keyOf(await page.url()) !== keyOf(here)) await sleep(300);
    if (keyOf(await page.url()) !== keyOf(here)) await page.goto(here).catch(() => undefined);
    await settle(15_000);
  };
  const policiesRead = new Set<string>();
  /** A visible "documents" control for policy `n`, whatever its exact wording. */
  const markByPolicyDocs = (n: string) =>
    page
      .evaluate<LinkInfo[]>(scanLinks)
      .then((ls) => ls.find((l) => !l.footer && l.text.includes(n) && /\bdocuments?\b/i.test(l.text) && !isDangerous(l.text))?.mark ?? null)
      .catch(() => null);

  /** Wait up to `ms` for `find` to return a mark. */
  const waitMark = async (find: () => Promise<string | null>, ms: number): Promise<string | null> => {
    const until = Date.now() + ms;
    for (;;) {
      const m = await find();
      if (m || Date.now() >= until) return m;
      await sleep(700);
    }
  };
  const visibleLinks = () => page.evaluate<LinkInfo[]>(scanLinks).catch(() => [] as LinkInfo[]);
  /** Never a bill, payment, autopay or claim entry, even though they name the policy too. */
  const notMoney = (t: string) => !isDangerous(t) && !/(bill|invoice|payment|statement|autopay|claim)/i.test(t);
  /** An entry naming policy `n`: a documents one first, then any safe one. */
  const markPolicyItem = async (n: string, exclude = new Set<string>()) => {
    const ls = (await visibleLinks()).filter((l) => !l.footer && l.text.includes(n) && notMoney(l.text) && !exclude.has(l.mark));
    return (ls.find((l) => /\bdocuments?\b/i.test(l.text)) ?? ls.find((l) => /polic/i.test(l.text)) ?? ls[0])?.mark ?? null;
  };
  /** The page's main text, without header and footer. */
  const mainText = () =>
    page
      .evaluate<string>(() => {
        const m = document.querySelector("main, [role=main]") as HTMLElement | null;
        if (m) return m.innerText;
        const b = document.body.cloneNode(true) as HTMLElement;
        b.querySelectorAll("header, footer, nav, [role=banner], [role=contentinfo]").forEach((x) => x.remove());
        return b.innerText;
      })
      .catch(() => "");
  const hasPdfList = async () => (await visibleLinks()).some((l) => l.pdfHint && isDocumentLink(l.text, l.href, l.pdfHint));

  /**
   * Get to policy `n`'s documents from wherever the run is, without relying
   * on the browser's Back. Tries, in order: the policy's own documents button
   * on this page; the "Policies" menu in the page header; the home page's
   * button after reloading home; the general "documents" picker.
   */
  const openPolicyDocs = async (n: string, home: string): Promise<boolean> => {
    const tag = n.slice(-4); // only the last digits go in the debug log
    const arrived = async (how: string, from: string, textBefore: string) => {
      await settle(15_000);
      const now = keyOf(await page.url());
      // Same address is normal here; the content must have changed.
      const ok = now !== from || (await mainText()) !== textBefore;
      navLog("open-policy", { policy: `...${tag}`, how, ok, path: pathOf(now) });
      return ok;
    };
    // 1. Its own button, here.
    let from = keyOf(await page.url());
    let m = await waitMark(() => markByPolicyDocs(n), from === keyOf(home) ? 20_000 : 2_000);
    if (m) {
      const tb = await mainText();
      await page.clickMark(m);
      if (await arrived("own-button", from, tb)) return true;
    }
    // 2. The Policies menu in the header (present on every Foremost page).
    from = keyOf(await page.url());
    const menu = (await visibleLinks()).find((l) => !l.footer && /^polic(?:y|ies)\b/i.test(l.text));
    if (menu) {
      const tb = await mainText();
      await page.clickMark(menu.mark);
      await sleep(1500);
      const item = await waitMark(() => markPolicyItem(n, new Set([menu.mark])), 4_000);
      if (item) {
        await page.clickMark(item);
        if (await arrived("header-menu", from, tb)) return true;
      } else {
        navLog("open-policy", { policy: `...${tag}`, how: "header-menu", ok: false, why: "no item" });
        await page.pressEscape().catch(() => undefined);
      }
    }
    // 3. Home again, and its button there.
    if (keyOf(await page.url()) !== keyOf(home)) {
      await page.goto(home).catch(() => undefined);
      await settle(20_000);
    }
    from = keyOf(await page.url());
    m = await waitMark(() => markByPolicyDocs(n), 20_000);
    if (m) {
      const tb = await mainText();
      await page.clickMark(m);
      if (await arrived("home-button", from, tb)) return true;
    }
    // 4. A general documents picker ("View policy documents").
    const general = (await visibleLinks()).find((l) => !l.footer && /\bdocuments?\b/i.test(l.text) && !policyNumberIn(l.text) && notMoney(l.text));
    if (general) {
      const tb = await mainText();
      await page.clickMark(general.mark);
      await sleep(1500);
      const item = await waitMark(() => markPolicyItem(n, new Set([general.mark])), 5_000);
      if (item) {
        await page.clickMark(item);
        if (await arrived("picker", from, tb)) return true;
      }
    }
    navLog("policy-unreachable", { policy: `...${tag}` });
    await snap(page, `unreachable-${tag}`, { seen: (await visibleLinks()).map((l) => l.text) });
    return false;
  };

  /**
   * Read one page: save its documents, then follow its navigation buttons.
   * A button that lands on another page is read there and then (depth
   * first) and the run steps back, so each page loads once. `depth` 0 is a
   * starting page; deeper pages only follow "documents" tabs.
   */
  const readPage = async (ctx: string, depth = 0): Promise<void> => {
    await settle();
    const here = await page.url();
    const pageKey = keyOf(here);
    const links = await page.evaluate<LinkInfo[]>(scanLinks).catch(() => [] as LinkInfo[]);
    Object.assign(addresses, policyAddresses(links.map((l) => l.text)), addresses);
    await snap(page, `page-${pagesVisited}`, links.map((l) => ({ text: l.text, href: l.href ? new URL(l.href).pathname : "", pdf: l.pdfHint })));
    const ownPolicy = policyNumberIn(ctx);
    if (ownPolicy) policiesRead.add(ownPolicy);

    // A link or box naming a policy number ("Homeowners H37-291-123456-40")
    // leads to that policy's page, unless it is a bill, payment or claim entry.
    const isNav = (l: LinkInfo) => isNavigationLink(l.text) || (!!policyNumberIn(l.text) && notMoney(l.text) && l.text.length <= 100);
    for (const l of links) {
      if (l.href && !l.footer && isNav(l)) enqueue(l.href, contextFor(l.text, ctx));
    }
    const pageText = await mainText();
    // Remember the account's own numbers and addresses (for the private list).
    for (const t of [...links.map((l) => l.text), pageText]) {
      for (const n of policyNumbersIn(t)) identifiers.add(n);
      for (const a of streetAddressesIn(t)) identifiers.add(a);
    }
    const docsPage = /\bdocuments?\b/i.test(pageText.slice(0, 400));
    await takeDocs(links, ctx, docsPage);
    if (depth >= 2) return;

    // Navigation buttons with no address. When a page offers "documents"
    // buttons, follow only those; when some name a policy (Foremost's home
    // page has one per policy), follow only those and skip the general one.
    let navs = links.filter((l) => !l.href && !l.footer && isNav(l) && !tried.has(`nav|${ctx}|${pageKey}|${l.text}`));
    const docNavs = navs.filter((l) => /\bdocuments?\b/i.test(l.text));
    // General "documents" buttons (no policy named), kept as a fallback for
    // policies whose own button cannot be found again.
    const generalDocNavs = docNavs.filter((l) => !policyNumberIn(l.text));
    if (docNavs.length) {
      const perPolicy = docNavs.filter((l) => policyNumberIn(l.text));
      navs = perPolicy.length ? [...perPolicy, ...generalDocNavs] : docNavs;
    } else if (depth > 0) {
      return;
    }
    // One documents button per policy (Foremost's home page): visit each
    // policy in turn with openPolicyDocs, which does not depend on Back.
    const perPolicyNumbers = [...new Set(docNavs.map((l) => policyNumberIn(l.text)).filter((x): x is string => !!x))];
    if (depth === 0 && perPolicyNumbers.length) {
      navLog("policies-found", { count: perPolicyNumbers.length });
      for (const n of perPolicyNumbers) {
        if (policiesRead.has(n)) continue;
        if (outOfTime() || documents.length >= opts.maxDocuments) break;
        if (await openPolicyDocs(n, here)) {
          // Make sure the page is about policy n before naming files after it:
          // it must not mention another policy unless it also mentions n.
          const t = await mainText();
          const mentions = (x: string) => t.includes(x) || (!!addresses[x] && t.includes(addresses[x]));
          const others = perPolicyNumbers.filter((o) => o !== n && mentions(o));
          if (others.length && !mentions(n)) {
            navLog("wrong-policy-page", { policy: `...${n.slice(-4)}` });
            await snap(page, `wrong-policy-${n.slice(-4)}`);
            continue;
          }
          visited.add(`${contextFor(`policy ${n}`)}|${keyOf(await page.url())}`);
          pagesVisited++;
          await readPage(contextFor(`policy ${n}`), 1);
          policiesRead.add(n);
        }
      }
      return;
    }
    const missed = new Set<string>();
    const toFollow = navs.slice(0, 14);
    for (const [idx, nb] of toFollow.entries()) {
      // On a policy's own pages, the last button followed needs no way back:
      // the next policy is opened from wherever the run ends up.
      const needBack = depth === 0 || idx < toFollow.length - 1;
      if (outOfTime() || documents.length >= opts.maxDocuments) break;
      tried.add(`nav|${ctx}|${pageKey}|${nb.text}`);
      const n = policyNumberIn(nb.text);
      if (n && policiesRead.has(n)) continue;
      // The general picker only matters if a policy's own button went missing.
      if (!n && docNavs.some((l) => policyNumberIn(l.text)) && missed.size === 0) continue;
      let m = await markByText(nb.text, 20_000);
      if (!m && n) m = await markByPolicyDocs(n);
      if (!m) {
        // Back did not bring the page's content back: load it again.
        opts.log("button-missing-after-back-reloading");
        await page.goto(here).catch(() => undefined);
        await settle(20_000);
        m = (await markByText(nb.text, 20_000)) ?? (n ? await markByPolicyDocs(n) : null);
      }
      if (!m) {
        opts.log("button-not-found");
        if (n) missed.add(n);
        const now = await page.evaluate<LinkInfo[]>(scanLinks).catch(() => [] as LinkInfo[]);
        await snap(page, `button-missing-${pagesVisited}`, { wanted: nb.text, url: (await page.url()).split("?")[0], seen: now.map((l) => l.text) });
      }
      if (!m) continue;
      const shownBefore = new Set((await page.evaluate<LinkInfo[]>(scanLinks).catch(() => [] as LinkInfo[])).map((l) => l.text));
      await page.clickMark(m);
      await settle(15_000);
      const now = await page.url();
      const navCtx = contextFor(nb.text, ctx);
      if (keyOf(now) !== pageKey) {
        // It moved to another page: read it now, then step back if needed.
        // The same address can show a different policy (Foremost keeps the
        // chosen policy out of the address), so "read already" is per policy.
        const vk = `${navCtx}|${keyOf(now)}`;
        if (!visited.has(vk)) {
          visited.add(vk);
          pagesVisited++;
          await readPage(navCtx, depth + 1);
        }
        if (needBack) await goBack(here);
        continue;
      }
      // Same page: it opened a menu or a tab. Save documents it revealed,
      // then visit the safe items it showed, skipping policies already read.
      const shown = (await page.evaluate<LinkInfo[]>(scanLinks).catch(() => [] as LinkInfo[])).filter(
        (l) => !shownBefore.has(l.text) && !l.footer && l.text.length <= 100 && !isDangerous(l.text),
      );
      Object.assign(addresses, policyAddresses(shown.map((l) => l.text)), addresses);
      await snap(page, `opened-${pagesVisited}`, shown.map((l) => l.text));
      await takeDocs(shown, navCtx, /\bdocuments?\b/i.test((await mainText()).slice(0, 400)));
      for (const item of shown.filter((l) => !isDocumentLink(l.text, l.href, l.pdfHint)).slice(0, 10)) {
        if (outOfTime()) break;
        const itemPolicy = policyNumberIn(item.text);
        if (itemPolicy && policiesRead.has(itemPolicy)) continue;
        if (/^(close|cancel|dismiss|back)\b/i.test(item.text)) continue;
        if (tried.has(`item|${ctx}|${pageKey}|${item.text}`)) continue;
        tried.add(`item|${ctx}|${pageKey}|${item.text}`);
        let im = await markByText(item.text, 3_000);
        if (!im) {
          const reopen = await markByText(nb.text);
          if (reopen) await page.clickMark(reopen);
          await sleep(1000);
          im = await markByText(item.text, 5_000);
        }
        if (!im) continue;
        const textBefore = await mainText();
        await page.clickMark(im);
        await settle(20_000);
        const went = await page.url();
        if (keyOf(went) === pageKey && (await mainText()) !== textBefore) {
          // The item swapped the page's content in place (Selective): read it here.
          const vk = `${contextFor(item.text, navCtx)}|${keyOf(went)}|${(await mainText()).slice(0, 80)}`;
          if (!visited.has(vk)) {
            visited.add(vk);
            pagesVisited++;
            await readPage(contextFor(item.text, navCtx), depth + 1);
          }
          continue;
        }
        if (keyOf(went) !== pageKey) {
          const vk = `${contextFor(item.text, navCtx)}|${keyOf(went)}`;
          if (!visited.has(vk)) {
            visited.add(vk);
            pagesVisited++;
            await readPage(contextFor(item.text, navCtx), depth + 1);
          }
          await goBack(here);
        }
      }
    }
  };

  const start = await page.url();
  visited.add(keyOf(start));
  pagesVisited++;
  await readPage("");
  while (queue.length && pagesVisited < 15 && !outOfTime() && documents.length < opts.maxDocuments) {
    const url = queue.shift()!;
    const k = keyOf(url);
    if (visited.has(k)) continue;
    visited.add(k);
    await page.goto(url).catch(() => undefined);
    pagesVisited++;
    await readPage(pageContext.get(k) ?? "");
  }

  // Documents skipped as already saved were found too; only say "none" when nothing was.
  if (documents.length === 0 && skipped.length === 0) {
    notes.push(
      `Signed in to ${carrier.name} but found no policy or declarations PDFs on the pages checked. The portal layout may need tuning; turn on 'Debug screenshots' in the plugin settings and run again.`,
    );
  }
  if (documents.length >= opts.maxDocuments) notes.push(`Stopped at the limit of ${opts.maxDocuments} documents.`);
  if (ranOut) notes.push("Stopped early to stay inside the 5-minute tool limit; some documents may be missing.");
  if (opts.debugDir) {
    await writeFile(join(opts.debugDir, "blocked-requests.json"), JSON.stringify(blockedPaths, null, 2)).catch(() => undefined);
  }
  if (opts.debugDir) {
    await writeFile(join(opts.debugDir, "pdf-capture-log.json"), JSON.stringify(captureLog, null, 2)).catch(() => undefined);
    await writeFile(join(opts.debugDir, "nav-log.json"), JSON.stringify(navEvents, null, 2)).catch(() => undefined);
  }
  return { documents, pagesVisited, blockedRequests, blockedPaths, skipped, identifiers: [...identifiers], notes };
}

function docMeta(l: LinkInfo, ctx: string): DocMeta {
  const shown = (l.shown || l.text).replace(/\s+/g, " ").trim();
  let title = shown
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (/^(view|download|open|pdf|view pdf|download pdf|print|view document|document)?$/i.test(title) && l.context) {
    title = `${l.context.replace(shown, "").replace(/\s+/g, " ").trim().slice(0, 60)} ${title}`.trim();
  }
  return { label: makeLabel(l, ctx), policy: ctx, title: title.slice(0, 80) || "Document", posted: findDate(l.text) };
}

function makeLabel(l: LinkInfo, ctx = ""): string {
  // Prefer the words on screen; screen-reader text often repeats them.
  let text = (l.shown || l.text).replace(/\s+/g, " ").trim();
  // The posted date may be only in the screen-reader text; keep it in the name.
  if (!findDate(text)) {
    const d = findDate(l.text);
    if (d) text = `${text} ${d}`;
  }
  text = text.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_m, mo, d, y) => `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`);
  const generic = /^(view|download|open|pdf|view pdf|download pdf|print|view document|document)$/i.test(text) || text.length < 6;
  let label = text;
  if (generic && l.context) label = `${l.context.replace(text, "").trim()} ${text}`.trim();
  return [ctx, label.slice(0, 80)].filter(Boolean).join(" - ") || "Document";
}
