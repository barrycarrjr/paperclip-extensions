/**
 * Read-only guard rails and text heuristics. Pure functions, unit-tested.
 *
 * Two layers keep a run read-only:
 *   1. Click allow-list: after sign-in the worker only clicks links whose text
 *      reads like a document or a "view policy" page, and never anything that
 *      matches DANGER below, whatever else it says.
 *   2. Request guard: once signed in, every request from every tab passes
 *      `shouldBlockRequest`, which fails PUT/PATCH/DELETE outright and fails
 *      POSTs whose address looks like a payment, change or submission.
 */

/** Street-type words, as written ("St") or in capitals ("ST"), never lower case. */
const STREET_SUFFIX = ((): string => {
  const words = ["St", "Street", "Pl", "Place", "Ave", "Avenue", "Rd", "Road", "Dr", "Drive", "Ln", "Lane", "Ct", "Court", "Way", "Blvd", "Boulevard", "Ter", "Terrace", "Cir", "Circle", "Pkwy", "Parkway", "Hwy", "Highway", "Sq", "Square", "Trl", "Trail", "Pike", "Row", "Aly", "Alley"];
  return [...words, ...words.map((w) => w.toUpperCase())].join("|");
})();

/** Words that mark a control as one that pays, changes, submits or signs out. */
const DANGER =
  /\b(pay|paying|payment|payments|autopay|auto-pay|bill ?pay|make a|submit|cancel|change|changes|update|edit|delete|remove|add|enroll|enrol|sign ?up|register|claim|claims|quote|purchase|buy|renew|reinstate|transfer|withdraw|confirm|accept|agree|log ?out|sign ?out|logoff|log off|settings|profile|preferences|paperless|e-?sign|esign|request|refer|chat|contact|feedback|survey|upgrade|switch|bundle|discount offer|apply)\b/i;

/** Link text that names a policy document worth saving. */
const DOCUMENT =
  /(declaration|\bdecs?\b|dec page|policy (?:packet|jacket|booklet|contract|pdf)|full policy|current policy|insurance (?:card|id)|\bid cards?\b|evidence of (?:insurance|property insurance)|certificate of insurance|\bview pdf\b|\bdownload\b.*\bpolicy\b|\bpolicy\b.*\b(?:download|pdf)\b)/i;

/** Link text that leads toward documents or a policy's own page. */
const NAVIGATE =
  /(\bdocuments?\b|\bpolicy (?:details|summary|overview|information|info)\b|\bview (?:policy|details|documents)\b|\bmy polic(?:y|ies)\b|^\s*polic(?:y|ies)\b|\bselect (?:a |your )?polic(?:y|ies)\b|\bcoverages?\b|\bid cards?\b)/i;

/** Liberty Mutual's screen-reader wording for a button that opens one document. */
const VIEW_NAMED_DOC = /^(?:view|print|view ?\/ ?print|download)\s+open (?:your|the) [a-z][a-z ]{1,40}? document in a new (?:tab|window)$/i;

/** The document a "View / print" button opens, from its screen-reader words ("Renewal", "Proof of insurance"). */
export function namedDocument(text: string): string | null {
  const m = /\bopen (?:your|the) ([a-z][a-z ]{1,40}?) document\b/i.exec(text);
  if (m) return m[1].trim().replace(/^./, (c) => c.toUpperCase());
  if (/\bproof of insurance\b/i.test(text)) return "Proof of insurance";
  return null;
}

/**
 * The control that lists the account's other policies ("Select another
 * policy"). Never a "change" or "switch" wording: those can mean changing
 * the policy itself.
 */
export function isPolicySelector(label: string): boolean {
  return /^[<‹\s]*(?:select|choose|pick) (?:another|a different|other|a|your)? ?polic(?:y|ies)$/i.test(label.trim());
}

/** Words that mark an older document we were not asked for. */
const NOT_CURRENT = /\b(prior|previous|expired|archived?|history|historical|cancell?ed|old)\b/i;

export function isDangerous(label: string): boolean {
  return DANGER.test(label);
}

/**
 * True for a link/button worth saving as a document. `pdfHint` means the
 * page marks the link as a PDF (a PDF icon, "PDF" in its label), as
 * Foremost's document list does for entries named only "RENEWAL 05/14/2026".
 */
export function isDocumentLink(label: string, href = "", pdfHint = false): boolean {
  const text = label.trim();
  if (!text && !href) return false;
  if (NOT_CURRENT.test(text)) return false;
  // "View / print — Open your Policy change document in a new tab": the
  // words say it only opens a named document for reading, so the "change"
  // in the document's name does not make it a change.
  if (VIEW_NAMED_DOC.test(text)) return true;
  // Danger wins over everything: "Change how policy documents are sent" names
  // a document but is a settings change. Only the visible text is judged; an
  // address may carry "pay" in an id ("payplan.pdf") without meaning it.
  if (text && isDangerous(text)) return false;
  if (/(bill|invoice|payment|statement|receipt)/i.test(text)) return false;
  if (DOCUMENT.test(text)) return true;
  // "View / print — Open your Renewal document in a new tab" (Liberty Mutual):
  // one named document, not a list ("documents").
  if (/\b(?:your|this)\s+[a-z][a-z /-]{1,40}?\s+document\b(?!s)/i.test(text) && /\b(view|print|open|download)\b/i.test(text)) return true;
  if (/\bproof of insurance\b/i.test(text) && /\b(view|print|open|download)\b/i.test(text)) return true;
  if (pdfHint && !/\bdocuments\b/i.test(text)) return true;
  return /\.pdf(?:$|[?#])/i.test(href) && /(polic|declar|\bdec|idcard|id-card)/i.test(href);
}

/** True for a link worth following to reach the documents. */
export function isNavigationLink(label: string): boolean {
  const text = label.trim();
  if (!text || text.length > 60) return false;
  if (isDangerous(text) || NOT_CURRENT.test(text)) return false;
  return NAVIGATE.test(text);
}

/** Address fragments that mark a write we must never let through. */
const WRITE_URL =
  /(pay|payment|autopay|billing\/(?!document)|bill-pay|checkout|cancel|endorse|change|update|delete|remove|submit|claim|enroll|paperless|preference|profile|setting|esign|e-sign|bind|purchase|quote|refund|transfer|reinstat)/i;

export function shouldBlockRequest(method: string, url: string): boolean {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return false;
  if (m === "PUT" || m === "PATCH" || m === "DELETE") return true;
  let path = url;
  try {
    const u = new URL(url);
    path = u.hostname + u.pathname;
  } catch {
    // keep raw
  }
  // A read-only lookup named for what it gets ("GetBillPaySummary",
  // "GetClaimsByPolicy" on Selective) passes, unless a word of its name
  // says it changes something.
  if (isReadOnlyLookup(path)) return false;
  return WRITE_URL.test(path);
}

const WRITE_WORDS = new Set(
  ["submit", "update", "delete", "create", "cancel", "make", "process", "save", "set", "add", "remove", "enroll", "post", "apply", "change", "send", "generate", "register", "confirm", "accept", "pay", "schedule", "edit", "modify", "bind", "purchase", "transfer", "refund", "sign", "upload", "insert", "put", "patch", "reinstate", "renew", "endorse", "opt", "unenroll", "activate", "deactivate", "authorize", "validate", "verify"],
);

/** True for a POST to a service call named Get..., List..., Search... with no write word in its name. */
export function isReadOnlyLookup(path: string): boolean {
  const last = path.split("/").filter(Boolean).pop() ?? "";
  const m = /^(Get|List|Search|Find|Retrieve|Load|Read|Fetch)([A-Z][A-Za-z0-9]*)$/.exec(last);
  if (!m) return false;
  const words = m[2].split(/(?=[A-Z])/).map((w) => w.toLowerCase());
  // "GetBillPaySummary" reads a summary; "GetPayNow" or "GetAndUpdate" do not pass.
  const nouns = new Set(["summary", "summaries", "history", "details", "detail", "list", "info", "status"]);
  return !words.some((w, i) => WRITE_WORDS.has(w) && !(w === "pay" && nouns.has(words[i + 1] ?? "")));
}

/** Lower-case domain of an email address, or "" if there is none. */
export function emailDomain(address: string): string {
  const m = /@([^@>\s]+)\s*>?\s*$/.exec(address.trim());
  return m ? m[1].toLowerCase().replace(/\.$/, "") : "";
}

/** True only when the sender's domain is one of `domains` or a subdomain of one. */
export function senderAllowed(address: string, domains: readonly string[]): boolean {
  const d = emailDomain(address);
  if (!d) return false;
  return domains.some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
}

/**
 * Pull a one-time login code out of an email. Prefers a 4 to 8 digit number
 * that follows a word like "code"; falls back to a lone 6-digit number.
 * Returns null rather than guessing between several candidates.
 */
export function extractLoginCode(subject: string, body: string): string | null {
  // Emails laid out as tables put the code on its own line ("Here is the
  // One-Time Code." | | "1234", as Selective does): table bars, non-breaking
  // spaces and line breaks are flattened so the code is "near" the word again.
  const text = `${subject}\n${body}`.replace(/[|\u00a0]/g, " ").replace(/\s+/g, " ");
  const near =
    /(?:code|passcode|pass code|pin|verification|one[- ]time|security|otp)[^0-9]{0,60}?(?:is|:)?\s*\b(\d{4,8})\b(?![-./]\d)/i.exec(text);
  if (near) return near[1];
  const sixes = [...text.matchAll(/(?<![\d$.,/-])\b(\d{6})\b(?![\d,/-]|\.\d)/g)].map((m) => m[1]);
  const unique = [...new Set(sixes)];
  return unique.length === 1 ? unique[0] : null;
}

/** Make a string safe as a Drive file name. */
export function safeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
}

/** Split "My Drive/Insurance/2026" into ["Insurance", "2026"]. */
export function splitDrivePath(path: string): string[] {
  const parts = path
    .split(/[\\/]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length && /^my drive$/i.test(parts[0])) parts.shift();
  for (const p of parts) {
    if (p === "." || p === "..") throw new Error(`[EINVALID_DESTINATION] '${p}' is not allowed in a Drive path`);
  }
  return parts;
}

/** True when following `href` with a plain GET is safe and stays on the carrier's site. */
export function isSafeNavigationUrl(href: string, siteDomains: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  const loopback = host === "127.0.0.1" || host === "localhost";
  if (u.protocol !== "https:" && !(loopback && u.protocol === "http:")) return false;
  if (!siteDomains.some((d) => host === d || host.endsWith(`.${d}`))) return false;
  return !/(pay|billing|autopay|cancel|log-?out|sign-?out|logoff|claim|quote|enroll|paperless|preference|profile|setting|change|update|delete|remove)/i.test(
    u.pathname + u.search,
  );
}

/** Parse the first US (MM/DD/YYYY) or ISO date in `text`, as YYYY-MM-DD. */
export function findDate(text: string): string | null {
  const us = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(text);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

/**
 * From one policy's document list, keep the current term: everything posted
 * on or after the newest renewal / new-business / declarations document (or,
 * if none is named that way, only the newest). Undated entries are kept.
 */
export function currentTerm<T extends { text: string }>(docs: T[]): T[] {
  const dated = docs.map((d) => ({ d, date: findDate(d.text) }));
  const withDates = dated.filter((x) => x.date);
  if (withDates.length < 2) return docs;
  const starts = withDates.filter((x) => /\b(renewal|new business|declarations?|dec page|rewrite|reinstatement)\b/i.test(x.d.text));
  const pool = starts.length ? starts : withDates;
  const cutoff = pool.map((x) => x.date!).sort().at(-1)!;
  return dated.filter((x) => !x.date || x.date >= cutoff).map((x) => x.d);
}

/**
 * Map each policy number seen on a page to the street address shown with it,
 * e.g. "Managed policies 12 Oak St policy number 1234567" gives
 * { "1234567": "12 Oak St" }.
 */
export function policyAddresses(texts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const street = new RegExp(String.raw`(?<![\w-])(\d{1,6}(?: [A-Z0-9][A-Za-z0-9.']*){1,4} (?:${STREET_SUFFIX})\b\.?)`);
  for (const t of texts) {
    const addr = street.exec(t)?.[1];
    if (!addr) continue;
    for (const n of policyNumbersIn(t)) out[n] ??= addr.replace(/\.$/, "").trim();
  }
  return out;
}

/**
 * Policy-looking numbers in `text`: a run of 7+ digits ("4012345678"), or a
 * token of letters, digits and dashes holding at least 7 digits
 * ("H37-291-123456-40", "AOS2911234564"). Phone numbers, dates and card
 * endings are not policy numbers.
 */
export function policyNumbersIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9-])[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){5,}(?![A-Za-z0-9-])/g)) {
    const tok = m[0];
    const digits = tok.replace(/\D/g, "").length;
    if (digits < 7) continue;
    if (/^\(?\d{3}\)?[-. ]?\d{3}-\d{4}$/.test(tok) || /^1?-?\d{3}-\d{3}-\d{4}$/.test(tok)) continue; // phone
    if (/^\d{1,4}-\d{1,2}-\d{1,4}$/.test(tok)) continue; // date
    if (/^\d{8}$/.test(tok) && /^(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(tok)) continue; // 20260929
    out.push(tok);
  }
  return out;
}

/** The policy-looking number in `text` with the most digits, if any. */
export function policyNumberIn(text: string): string | null {
  const all = policyNumbersIn(text);
  if (!all.length) return null;
  const score = (t: string) => t.replace(/\D/g, "").length;
  return all.sort((a, b) => score(b) - score(a))[0];
}

/** Street addresses written in `text` ("12 Oak St", "900 W Elm Avenue", "929 W 3RD ST"). */
export function streetAddressesIn(text: string): string[] {
  const street = new RegExp(String.raw`(?<![\w-])(\d{1,6}(?: [A-Z0-9][A-Za-z0-9.']*){1,4} (?:${STREET_SUFFIX})\b)`, "g");
  return [...text.matchAll(street)].map((m) => m[1].trim());
}
