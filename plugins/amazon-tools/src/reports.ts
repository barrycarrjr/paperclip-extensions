// Report types agents may request, list or read. Order reports are left out
// on purpose: with the wrong roles they can carry buyer names and addresses.
// get_report also refuses to read any report whose type is not listed here,
// even one created outside Paperclip.

export interface ReportTypeInfo {
  label: string;
  /** Amazon generates these on its own schedule; they cannot be requested. */
  systemOnly?: boolean;
  /** Allowed reportOptions keys. */
  options?: readonly string[];
}

export const REPORT_TYPES: Record<string, ReportTypeInfo> = {
  GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2: { label: "Settlement report (flat file)", systemOnly: true },
  GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA: { label: "Date range transaction report" },
  GET_FBA_MYI_UNSUPPRESSED_INVENTORY_DATA: { label: "FBA manage inventory" },
  GET_FBA_MYI_ALL_INVENTORY_DATA: { label: "FBA manage inventory (archived too)" },
  GET_AFN_INVENTORY_DATA: { label: "FBA inventory (all fulfillment centers)" },
  GET_FBA_REIMBURSEMENTS_DATA: { label: "FBA reimbursements" },
  GET_FBA_STORAGE_FEE_CHARGES_DATA: { label: "FBA monthly storage fees" },
  GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA: { label: "FBA estimated fees" },
  GET_MERCHANT_LISTINGS_ALL_DATA: { label: "All listings (incl. merchant-fulfilled quantity)" },
  GET_FLAT_FILE_OPEN_LISTINGS_DATA: { label: "Open listings (inventory)" },
  GET_SALES_AND_TRAFFIC_REPORT: {
    label: "Sales and traffic (business report)",
    options: ["dateGranularity", "asinGranularity"],
  },
};

export const REPORT_TYPE_NAMES = Object.keys(REPORT_TYPES);
export const REQUESTABLE_REPORT_TYPES = REPORT_TYPE_NAMES.filter((t) => !REPORT_TYPES[t]!.systemOnly);

export function isAllowedReportType(type: unknown): type is string {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(REPORT_TYPES, type);
}

/**
 * Columns dropped from any table report: buyer contact details and anything
 * finer-grained than state or country. The transaction report, for one, has
 * "order city" and "order postal" columns.
 */
const PERSONAL_COLUMN = /buyer|recipient|phone|e-?mail|(^|[\s_-])(city|postal|zip|address\w*)($|[\s_-])/i;

export function isPersonalColumn(name: string): boolean {
  return PERSONAL_COLUMN.test(name);
}

export interface ParsedReport {
  format: "table" | "json" | "text";
  totalRows: number;
  columns?: string[];
  rows: unknown[];
  truncated: boolean;
}

/** Turn a downloaded report into a page of rows. */
export function parseReport(text: string, offset: number, limit: number): ParsedReport {
  const trimmed = text.replace(/^﻿/, "");
  if (/^\s*[{[]/.test(trimmed)) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      // Sales-and-traffic style: page the largest top-level array.
      if (json && typeof json === "object" && !Array.isArray(json)) {
        const entries = Object.entries(json as Record<string, unknown>);
        const arrays = entries.filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>;
        arrays.sort((a, b) => b[1].length - a[1].length);
        const main = arrays[0];
        const totalRows = main ? main[1].length : 0;
        const pageOf = Object.fromEntries(
          entries.map(([k, v]) => [k, Array.isArray(v) ? v.slice(offset, offset + limit) : v]),
        );
        return {
          format: "json",
          totalRows,
          rows: [pageOf],
          truncated: arrays.some(([, v]) => v.length > offset + limit),
        };
      }
      const arr = Array.isArray(json) ? json : [json];
      return {
        format: "json",
        totalRows: arr.length,
        rows: arr.slice(offset, offset + limit),
        truncated: arr.length > offset + limit,
      };
    } catch {
      // fall through to text
    }
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length > 0 && lines[0]!.includes("\t")) {
    const allColumns = lines[0]!.split("\t");
    const keep = allColumns.map((c) => !isPersonalColumn(c));
    const columns = allColumns.filter((_, i) => keep[i]);
    const data = lines.slice(1);
    const rows = data.slice(offset, offset + limit).map((line) => {
      const cells = line.split("\t");
      const row: Record<string, string> = {};
      allColumns.forEach((c, i) => {
        const v = cells[i];
        if (keep[i] && v !== undefined && v !== "") row[c] = v;
      });
      return row;
    });
    return { format: "table", totalRows: data.length, columns, rows, truncated: data.length > offset + limit };
  }

  return {
    format: "text",
    totalRows: lines.length,
    rows: lines.slice(offset, offset + limit),
    truncated: lines.length > offset + limit,
  };
}
