/**
 * Policy terms: read the policy period printed in a PDF, and sort a policy's
 * documents into current and prior terms.
 *
 * The portals list documents by the date they were posted, not by policy
 * term. The term dates are printed in the documents themselves (the
 * declarations page: "Policy Period: 08/01/2026 to 08/01/2027"), so the text
 * of the first pages is read with pdf.js.
 */
import { safeFileName } from "./safety.js";

export interface Term {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

const DATE = String.raw`(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|[A-Z][a-z]{2,8}\.? \d{1,2},? \d{4})`;
const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Normalise one date as printed on a form to YYYY-MM-DD, or null. */
export function toIso(s: string): string | null {
  const num = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s.trim());
  if (num) {
    const y = num[3].length === 2 ? `20${num[3]}` : num[3];
    return `${y}-${num[1].padStart(2, "0")}-${num[2].padStart(2, "0")}`;
  }
  const word = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s.trim());
  if (word && MONTHS[word[1].toLowerCase()]) {
    return `${word[3]}-${MONTHS[word[1].toLowerCase()]}-${word[2].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Find the policy period in a document's text. Looks for the wordings used on
 * declarations pages: "Policy Period", "Policy Term", "Coverage Period",
 * "Term", or an "Effective Date ... Expiration Date" pair.
 */
export function findTerm(text: string): Term | null {
  const t = text.replace(/\s+/g, " ");
  // A term is about six months or a year long; anything else is some other
  // pair of dates (a payment schedule, a notice period).
  const plausible = (from: string, to: string) => {
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    return days >= 150 && days <= 400;
  };
  const patterns = [
    // Foremost and similar forms: the two dates printed side by side, then
    // the time the term starts ("07/20/26 07/20/27 12:01 A.M. STANDARD TIME"),
    // well after the "POLICY PERIOD" label.
    new RegExp(String.raw`${DATE}\s+${DATE}\s+12:01\s*A\.?\s?M\.?`, "i"),
    new RegExp(String.raw`policy\s*period\b.{0,300}?${DATE}\s+(?:to:?\s+)?${DATE}`, "i"),
    new RegExp(String.raw`(?:policy|coverage|insurance)\s*(?:period|term)\b[^0-9A-Z]{0,40}?(?:from\s*)?${DATE}[^0-9A-Za-z]{0,30}?(?:\d{1,2}:\d{2}\s*[AP]\.?M\.?[^0-9A-Za-z]{0,20})?(?:to|through|thru|until|-|–)\s*${DATE}`, "i"),
    new RegExp(String.raw`\bterm\b[^0-9A-Z]{0,20}?${DATE}\s*(?:to|through|thru|-|–)\s*${DATE}`, "i"),
    // Liberty Mutual (Safeco) new policies: "Coverage begins at the later
    // of: (1) 12:01 AM on 03/31/2026; or ... Coverage will expire at 12:01 AM
    // on 03/31/2027."
    new RegExp(String.raw`coverage begins\b.{0,80}?${DATE}.{0,300}?coverage (?:will )?expires?\b.{0,40}?${DATE}`, "i"),
    new RegExp(String.raw`effective\s*(?:date)?\s*:?\s*${DATE}.{0,80}?expiration\s*(?:date)?\s*:?\s*${DATE}`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(t);
    if (!m) continue;
    const from = toIso(m[1]);
    const to = toIso(m[2]);
    if (from && to && from < to && plausible(from, to)) return { from, to };
  }
  return null;
}

export interface Dated {
  /** Which policy the document belongs to (address + policy number). */
  policy: string;
  /** Document type as listed ("RENEWAL", "Declarations"). */
  title: string;
  posted: string | null;
  term: Term | null;
}

/**
 * Give documents without printed term dates (endorsements, notices) the term
 * of the same policy that their posted date falls inside, then mark each
 * document current or prior. A policy's current term is the one that covers
 * `today`, or failing that its latest term.
 */
export function assignTerms<T extends Dated>(docs: T[], today: string): Array<T & { current: boolean }> {
  const byPolicy = new Map<string, Term[]>();
  for (const d of docs) {
    if (!d.term) continue;
    const list = byPolicy.get(d.policy) ?? [];
    if (!list.some((x) => x.from === d.term!.from && x.to === d.term!.to)) list.push(d.term);
    byPolicy.set(d.policy, list);
  }
  const currentOf = (policy: string): Term | null => {
    const terms = byPolicy.get(policy) ?? [];
    return terms.find((x) => x.from <= today && today < x.to) ?? terms.sort((a, b) => a.from.localeCompare(b.from)).at(-1) ?? null;
  };
  // A policy with no readable term dates: fall back to posted dates. Its
  // current term starts at the newest renewal / new-business / declarations
  // document (or, if none is named that way, the newest document).
  const fallbackCutoff = (policy: string): string | null => {
    const own = docs.filter((x) => x.policy === policy && x.posted);
    const starts = own.filter((x) => /\b(renewal|new business|declarations?|dec page|rewrite|reinstatement)\b/i.test(x.title));
    const pool = starts.length ? starts : own;
    return pool.map((x) => x.posted!).sort().at(-1) ?? null;
  };
  return docs.map((d) => {
    let term = d.term;
    if (!term && d.posted) {
      term = (byPolicy.get(d.policy) ?? []).find((x) => x.from <= d.posted! && d.posted! < x.to) ?? null;
    }
    const cur = currentOf(d.policy);
    let current: boolean;
    if (term && cur) current = term.from === cur.from && term.to === cur.to;
    else if (cur && d.posted) {
      // Renewal packets are posted weeks before the term they start.
      const lead = /\b(renewal|declarations?|dec page)\b/i.test(d.title) ? 75 : 0;
      const start = new Date(Date.parse(cur.from) - lead * 86_400_000).toISOString().slice(0, 10);
      current = d.posted >= start;
    }
    else {
      const cutoff = fallbackCutoff(d.policy);
      // Nothing to compare against: keep it as current rather than drop it.
      current = !cutoff || !d.posted || d.posted >= cutoff;
    }
    return { ...d, term, current };
  });
}


/**
 * "<Carrier> - <address> - Policy <n> - Term <from> to <to> - <document> (posted <date>)".
 * Parts that are unknown are left out.
 */
export function fileNameFor(carrier: string, d: { policy: string; title: string; posted: string | null; term: Term | null }): string {
  const parts = [carrier, d.policy || null];
  if (d.term) parts.push(`Term ${d.term.from} to ${d.term.to}`);
  parts.push(d.posted ? `${d.title} (posted ${d.posted})` : d.title);
  return safeFileName(parts.filter(Boolean).join(" - "));
}

/** The term written into a file name by `fileNameFor`, if there is one. */
export function termFromName(name: string): Term | null {
  const m = /Term (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? { from: m[1], to: m[2] } : null;
}

/**
 * The name of a file already saved for this document (same policy, same
 * document, same posted date), or null. Lets a run skip downloads it has
 * already made: an interrupted run resumes, and monthly runs fetch only new
 * documents.
 */
export function existingFileFor(names: string[], carrier: string, d: { policy: string; title: string; posted: string | null }): string | null {
  if (!d.posted || !d.policy) return null;
  const head = safeFileName(`${carrier} - ${d.policy} - `);
  const tail = safeFileName(`${d.title} (posted ${d.posted})`);
  // Only names that carry term dates count: an older name without them is
  // fetched again so it can be saved under the full name.
  return names.find((n) => n.startsWith(head) && termFromName(n) && n.replace(/\.pdf$/i, "").replace(/ \(\d+\)$/, "").endsWith(tail)) ?? null;
}
