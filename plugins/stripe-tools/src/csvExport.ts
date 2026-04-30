import type Stripe from "stripe";
import { stringify } from "csv-stringify";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const DEFAULT_COLUMNS = [
  "id",
  "created",
  "customerEmail",
  "amount",
  "currency",
  "status",
  "refunded",
  "amountRefunded",
  "fee",
  "net",
  "description",
];

export interface ExportSummary {
  totalGross: number;
  totalNet: number;
  totalRefunded: number;
  totalFee: number;
  currency: string | null;
}

export interface ExportResult {
  path: string;
  rowCount: number;
  summary: ExportSummary;
}

function rowFromCharge(charge: Stripe.Charge, columns: string[]): Record<string, unknown> {
  const balanceTransaction =
    typeof charge.balance_transaction === "object" && charge.balance_transaction !== null
      ? (charge.balance_transaction as Stripe.BalanceTransaction)
      : null;
  const customerEmail =
    charge.billing_details?.email ??
    (typeof charge.customer === "object" && charge.customer && !("deleted" in charge.customer)
      ? (charge.customer as Stripe.Customer).email
      : null) ??
    charge.receipt_email ??
    "";
  const fee = balanceTransaction?.fee ?? 0;
  const net = balanceTransaction?.net ?? 0;

  const all: Record<string, unknown> = {
    id: charge.id,
    created: new Date(charge.created * 1000).toISOString(),
    customerEmail,
    amount: charge.amount,
    currency: charge.currency,
    status: charge.status,
    refunded: charge.refunded,
    amountRefunded: charge.amount_refunded ?? 0,
    fee,
    net,
    description: charge.description ?? "",
  };

  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = all[c] ?? "";
  return out;
}

export async function exportChargesCsv(opts: {
  client: Stripe;
  fromUnix: number;
  toUnix: number;
  columns?: string[];
  outputPath?: string;
  accountKey: string;
  runId: string;
}): Promise<ExportResult> {
  const columns = opts.columns && opts.columns.length > 0 ? opts.columns : DEFAULT_COLUMNS;

  let outPath = opts.outputPath;
  if (!outPath) {
    const dir = path.join(os.tmpdir(), "paperclip-stripe-tools");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    outPath = path.join(
      dir,
      `${opts.accountKey}-charges-${opts.fromUnix}-${opts.toUnix}-${stamp}.csv`,
    );
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
  }

  const writeStream = fs.createWriteStream(outPath, { encoding: "utf8" });
  const stringifier = stringify({ header: true, columns });
  stringifier.pipe(writeStream);

  let rowCount = 0;
  const summary: ExportSummary = {
    totalGross: 0,
    totalNet: 0,
    totalRefunded: 0,
    totalFee: 0,
    currency: null,
  };

  for await (const charge of opts.client.charges.list({
    limit: 100,
    created: { gte: opts.fromUnix, lte: opts.toUnix },
    expand: ["data.balance_transaction", "data.customer"],
  })) {
    const row = rowFromCharge(charge, columns);
    const ok = stringifier.write(row);
    if (!ok) {
      await new Promise<void>((resolve) => stringifier.once("drain", resolve));
    }
    rowCount += 1;

    if (charge.status === "succeeded") {
      summary.totalGross += charge.amount;
      summary.totalRefunded += charge.amount_refunded ?? 0;
      const bt =
        typeof charge.balance_transaction === "object" && charge.balance_transaction !== null
          ? (charge.balance_transaction as Stripe.BalanceTransaction)
          : null;
      if (bt) {
        summary.totalFee += bt.fee ?? 0;
        summary.totalNet += bt.net ?? 0;
      }
    }
    if (!summary.currency && charge.currency) summary.currency = charge.currency;
  }

  stringifier.end();
  await new Promise<void>((resolve, reject) => {
    writeStream.on("finish", () => resolve());
    writeStream.on("error", reject);
    stringifier.on("error", reject);
  });

  return { path: outPath, rowCount, summary };
}
