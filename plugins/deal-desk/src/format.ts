/**
 * Text formatting for tool results. Pure.
 *
 * Money in tool text is always dollars with thousands separators and two
 * decimals ($1,150,000.00). Other currencies are written with their code.
 */

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "n/a";
  const negative = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const body = `${whole.toLocaleString("en-US")}.${frac}`;
  if (currency === "USD") return `${negative ? "-" : ""}$${body}`;
  return `${negative ? "-" : ""}${body} ${currency}`;
}

export function formatMultiple(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return `${x.toFixed(2)}x`;
}

export function formatPercent(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(digits)}%`;
}

export function formatRatio(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "n/a";
  return x.toFixed(2);
}

export function yesNo(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return "not checked";
  return v ? "yes" : "NO";
}

/** A plain markdown table. */
export function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}
