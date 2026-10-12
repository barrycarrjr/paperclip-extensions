/**
 * Key figures from a declarations page: premium, dwelling (or main building)
 * limit, liability limit, mortgagee with the loan number's last 4 digits, and
 * the named insured.
 *
 * Each carrier and policy type lays its declarations out differently, so each
 * figure is read only from a known label immediately followed by its value
 * (layouts seen on Foremost, Liberty Mutual / Safeco and Selective forms). A
 * figure with no such label is null ("not found"), never guessed: a wrong
 * number would be worse than none. A full loan number is never kept.
 */

export interface Lender {
  /** "mortgagee" on property policies, "loss payee" on auto. */
  role: "mortgagee" | "loss payee";
  name: string;
  /** Last 4 characters of the loan number, or null when none is printed. */
  loanLast4: string | null;
  /** What the page says when there is no number yet ("TBD"), else null. */
  loanNote?: string | null;
}

export interface KeyFigures {
  /** Total premium for the term, in dollars. */
  premium: number | null;
  /** Dwelling (Coverage A) limit, or the main building limit on a commercial policy. */
  dwelling: number | null;
  dwellingKind: "dwelling" | "building" | null;
  /** Liability limit per occurrence (per person on auto). */
  liability: number | null;
  /** The liability limit as printed, e.g. "$250,000 each person / $500,000 each accident". */
  liabilityText: string | null;
  /** First mortgagee (or the auto loss payee). */
  lender: Lender | null;
  namedInsured: string | null;
  /** What kind of policy the page is for, which decides which figures apply. */
  policyType: "property" | "commercial" | "umbrella" | "auto" | null;
  /** Names of the figures not found on this document (figures that do not apply are left out). */
  notFound: string[];
  /** Figures that do not apply to this kind of policy (no dwelling on an auto policy). */
  notApplicable: string[];
}

const MONEY = String.raw`\$\s*([\d,]+(?:\.\d{2})?)`;
const amount = (s: string | undefined) => {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** First match of any pattern, in order. */
function first(text: string, patterns: RegExp[]): RegExpExecArray | null {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m;
  }
  return null;
}

const PREMIUM = [
  new RegExp(String.raw`TOTAL ANNUAL POLICY PREMIUM:\s*${MONEY}`),
  new RegExp(String.raw`TOTAL COMBINED PREMIUM:?\s*${MONEY}`),
  new RegExp(String.raw`Total Policy Premium:?\s*${MONEY}`, "i"),
  new RegExp(String.raw`\bANNUAL PREMIUM:?\s*${MONEY}`, "i"),
  new RegExp(String.raw`FULL TERM POLICY PREMIUM:?\s*${MONEY}`),
  new RegExp(String.raw`TOTAL (?:FULL TERM |SIX MONTH |POLICY )?PREMIUM:?\s*${MONEY}`),
];

const DWELLING = [
  new RegExp(String.raw`\bA\.?\s+DWELLING(?: FIRE)?\s+${MONEY}`),
  new RegExp(String.raw`COVERAGE A\b[^$]{0,30}?DWELLING\s*${MONEY}`, "i"),
];
const BUILDING = [new RegExp(String.raw`(?:\b\d+ \d+ BUILDING|TOTAL BLANKET BUILDING)\s*${MONEY}`)];

const LIABILITY: Array<{ re: RegExp; text?: (m: RegExpExecArray) => string }> = [
  { re: new RegExp(String.raw`LIMIT OF LIABILITY:\s*${MONEY}\s*PER OCCURRENCE`) },
  { re: new RegExp(String.raw`\bPERSONAL LIABILITY\s+${MONEY}`) },
  { re: new RegExp(String.raw`PREMISES LIABILITY \(EACH OCCURRENCE\)[^$]{0,160}?${MONEY}`) },
  { re: new RegExp(String.raw`\bPREMISES LIABILITY\s+${MONEY}`) },
  { re: new RegExp(String.raw`Liability and Medical Expenses Limit\s*${MONEY}`, "i") },
  {
    re: new RegExp(String.raw`BODILY INJURY LIABILITY\s+(?:\d{2}\s+)?${MONEY}\s*EACH PERSON\s*${MONEY}\s*EACH ACCIDENT`),
    text: (m) => `$${m[1]} each person / $${m[2]} each accident`,
  },
];

/** Words that end a lender's name on the page. */
const NAME_END = String.raw`(?=\s+(?:ISAOA|ATIMA|ITS SUCCESSORS|C\/O|P\.?\s?O\.? BOX|OCCUPANCY|LOAN|\d))`;
const LENDERS: Array<{ role: Lender["role"]; re: RegExp }> = [
  { role: "mortgagee", re: new RegExp(String.raw`MORTGAGEE\(S\):\s*1\.\s*([A-Z][A-Z0-9 .,&'-]{1,80}?)${NAME_END}`) },
  { role: "mortgagee", re: new RegExp(String.raw`1ST MORTGAGEE:\s*([A-Z][A-Z0-9 .,&'-]{1,80}?)${NAME_END}`) },
  { role: "mortgagee", re: new RegExp(String.raw`\bMORTGAGEE:\s*([A-Z][A-Z0-9 .,&'-]{1,80}?)${NAME_END}`) },
  // Liberty Mutual / Safeco special form: "Servicing Mortgagee <name> ISAOA ..."
  { role: "mortgagee", re: new RegExp(String.raw`Servicing Mortgagee\s+([A-Z][A-Z0-9 .,&'-]{1,80}?)${NAME_END}`) },
  { role: "loss payee", re: new RegExp(String.raw`LOSS PAYEE:\s*(?:\d{2}\s+)?([A-Z][A-Z0-9 .,&'-]{1,80}?)${NAME_END}`) },
];
const LOAN = /LOAN (?:NO\.?|NUMBER):?\s*#?\s*([A-Z0-9-]{3,})/;

const STREET = String.raw`\d{1,6}\s+[A-Z0-9]`;
const NAMED_INSURED = [
  // Liberty Mutual / Safeco: "INSURED: <names> <street>"
  new RegExp(String.raw`\bINSURED:\s*([A-Z][A-Z .,&'-]{2,100}?)\s+${STREET}`),
  // Selective commercial: "Named Insured and Address <name> <street>"
  new RegExp(String.raw`Named Insured and Address\s+([A-Z][A-Z .,&'-]{2,100}?)\s+${STREET}`),
  // Liberty Mutual / Safeco special form: the mailing name follows the service details.
  new RegExp(String.raw`POLICY SERVICE INFORMATION:[^]{0,80}?WEBSITE:\s*([A-Z][A-Z .,&'-]{2,100}?)\s+${STREET}`),
  // Foremost: the name follows the term's start time on the declarations page.
  new RegExp(String.raw`DECLARATIONS PAGE[^]{0,200}?STANDARD TIME\s+([A-Z][A-Z .,&'-]{2,100}?)\s+${STREET}`),
];
/** Selective personal lines: the names before the mailing address, just ahead of "<policy> <rev> <state> <agent no.> <dates>". */
const SELECTIVE_HEADER = new RegExp(
  String.raw`\b\d{5}(?:-\d{4})?\s+([A-Z][A-Z .,&'-]{2,100}?)\s+${STREET}[^]{0,120}?\s\d{2}[A-Z]\s+[A-Z]{2}\s+\d{2}-\d{5}-\d{5}\b`,
);

const tidy = (s: string) => s.replace(/\s+/g, " ").replace(/[ ,.-]+$/, "").trim();

/** Read the key figures from a document's text. */
export function readKeyFigures(rawText: string): KeyFigures {
  const t = rawText.replace(/\s+/g, " ");

  const premium = amount(first(t, PREMIUM)?.[1]);

  // Liberty Mutual / Safeco special form: one row of six limits after the
  // section heading, in the form's fixed order (A dwelling, B other
  // structures, C personal property, D loss of rent, E liability, F medical).
  // Taken only when B is a usual share of A, so a misread row is refused.
  let row: number[] | null = null;
  const rm = /Section I - Property Coverages and Section II - Liability Coverages\)((?:\s*\$[\d,]+){6})(?!\s*\$)/i.exec(t);
  if (rm) {
    const v = [...rm[1].matchAll(/\$([\d,]+)/g)].map((x) => Number(x[1].replace(/,/g, "")));
    if (v.length === 6 && v[0] > 0 && v[1] / v[0] >= 0.05 && v[1] / v[0] <= 0.5 && v[4] >= 25_000) row = v;
  }

  let dwelling = amount(first(t, DWELLING)?.[1]) ?? row?.[0] ?? null;
  let dwellingKind: KeyFigures["dwellingKind"] = dwelling ? "dwelling" : null;
  if (!dwelling) {
    dwelling = amount(first(t, BUILDING)?.[1]);
    if (dwelling) dwellingKind = "building";
  }

  let liability: number | null = null;
  let liabilityText: string | null = null;
  for (const l of LIABILITY) {
    const m = l.re.exec(t);
    if (!m) continue;
    liability = amount(m[1]);
    liabilityText = l.text ? l.text(m) : `$${m[1]}`;
    if (liability) break;
  }
  if (!liability && row) {
    liability = row[4];
    liabilityText = `$${row[4].toLocaleString("en-US")}`;
  }

  let lender: Lender | null = null;
  for (const l of LENDERS) {
    const m = l.re.exec(t);
    if (!m) continue;
    const after = t.slice(m.index, m.index + 400);
    const name = tidy(m[1]);
    // "1ST MORTGAGEE: NONE" means there is no mortgagee.
    if (/^(NONE|N\/A|NOT APPLICABLE)$/i.test(name)) break;
    const loan = LOAN.exec(after)?.[1]?.replace(/-/g, "") ?? null;
    const hasDigits = !!loan && /\d{4}/.test(loan);
    lender = {
      role: l.role,
      name,
      loanLast4: hasDigits ? loan!.slice(-4) : null,
      loanNote: loan && !hasDigits ? loan : null,
    };
    break;
  }

  const nm = first(t, NAMED_INSURED) ?? SELECTIVE_HEADER.exec(t);
  const namedInsured = nm ? tidy(nm[1]) : null;

  const policyType: KeyFigures["policyType"] = /BODILY INJURY LIABILITY\s+(?:\d{2}\s+)?\$/.test(t)
    ? "auto"
    : /LIMIT OF LIABILITY:\s*\$\s*[\d,]+\s*PER OCCURRENCE/.test(t) && /UMBRELLA/.test(t)
      ? "umbrella"
      : dwellingKind === "building"
        ? "commercial"
        : dwelling !== null
          ? "property"
          : null;
  const notApplicable =
    policyType === "auto" ? ["dwelling"] : policyType === "umbrella" ? ["dwelling", "mortgagee"] : [];

  const notFound: string[] = [];
  if (premium === null) notFound.push("premium");
  if (dwelling === null && !notApplicable.includes("dwelling")) notFound.push("dwelling");
  if (liability === null) notFound.push("liability");
  if (!lender && !notApplicable.includes("mortgagee")) notFound.push("mortgagee");
  if (!namedInsured) notFound.push("named insured");
  return { premium, dwelling, dwellingKind, liability, liabilityText, lender, namedInsured, policyType, notFound, notApplicable };
}

/** True when a document carries enough of a declarations page to be worth a summary. */
export function hasKeyFigures(f: KeyFigures): boolean {
  return f.policyType !== null && [f.premium, f.dwelling, f.liability].filter((x) => x !== null).length >= 2;
}
