import type Stripe from "stripe";

export interface MetricsSnapshot {
  asOfDate: string;
  currency: string;
  mrrCents: number;
  arrCents: number;
  activeSubs: number;
  signups7d: number;
  signups30d: number;
  cancellations30d: number;
  churnRate30d: number;
}

const DAYS_PER_MONTH = 30.4375;
const INTERVAL_DAYS: Record<string, number> = {
  day: 1,
  week: 7,
  month: 30.4375,
  year: 365.25,
};

function monthlyAmountCents(item: Stripe.SubscriptionItem): number {
  const price = item.price;
  if (!price.recurring) return 0;
  const unit = price.unit_amount ?? 0;
  const qty = item.quantity ?? 1;
  const intervalDays = INTERVAL_DAYS[price.recurring.interval] ?? DAYS_PER_MONTH;
  const intervalCount = price.recurring.interval_count ?? 1;
  const totalDays = intervalDays * intervalCount;
  if (totalDays <= 0) return 0;
  return (unit * qty * DAYS_PER_MONTH) / totalDays;
}

interface SnapshotCacheEntry {
  computedAt: number;
  asOfUnix: number;
  snapshot: MetricsSnapshot;
}

const snapshotCache = new Map<string, SnapshotCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(companyId: string, accountKey: string, asOfUnix: number) {
  // Bucket asOf to the nearest 5 minutes so callers within a window share the result.
  const bucketed = Math.floor(asOfUnix / 300) * 300;
  return `${companyId}::${accountKey}::${bucketed}`;
}

export async function computeMetricsSnapshot(opts: {
  client: Stripe;
  asOfDate?: string;
  companyId: string;
  accountKey: string;
}): Promise<MetricsSnapshot> {
  const asOf = opts.asOfDate ? new Date(opts.asOfDate) : new Date();
  if (Number.isNaN(asOf.getTime())) {
    throw new Error(`[EINVALID_INPUT] Invalid asOfDate: "${opts.asOfDate}"`);
  }
  const asOfUnix = Math.floor(asOf.getTime() / 1000);
  const day = 24 * 60 * 60;

  const ck = cacheKey(opts.companyId, opts.accountKey, asOfUnix);
  const cached = snapshotCache.get(ck);
  if (cached && Date.now() - cached.computedAt < CACHE_TTL_MS) {
    return cached.snapshot;
  }

  let activeSubs = 0;
  let mrrCents = 0;
  const currencies = new Set<string>();

  for await (const sub of opts.client.subscriptions.list({
    status: "active",
    limit: 100,
    expand: ["data.items.data.price"],
  })) {
    activeSubs += 1;
    const items = sub.items?.data ?? [];
    for (const item of items) {
      mrrCents += monthlyAmountCents(item);
      const cur = item.price.currency;
      if (cur) currencies.add(cur.toLowerCase());
    }
  }

  if (currencies.size > 1) {
    throw new Error(
      `[ESTRIPE_MIXED_CURRENCY] Active subs span ${currencies.size} currencies (${[...currencies].join(", ")}). v0.1.0 does not perform FX conversion.`,
    );
  }
  const currency = currencies.size === 1 ? [...currencies][0] : "usd";
  const roundedMrr = Math.round(mrrCents);
  const arrCents = roundedMrr * 12;

  let cancellations30d = 0;
  for await (const sub of opts.client.subscriptions.list({
    status: "canceled",
    limit: 100,
    created: { gte: asOfUnix - 30 * day },
  })) {
    if (typeof sub.canceled_at === "number" && sub.canceled_at >= asOfUnix - 30 * day) {
      cancellations30d += 1;
    }
  }

  let signups7d = 0;
  let signups30d = 0;
  for await (const customer of opts.client.customers.list({
    limit: 100,
    created: { gte: asOfUnix - 30 * day },
  })) {
    if (customer.created >= asOfUnix - 7 * day) signups7d += 1;
    if (customer.created >= asOfUnix - 30 * day) signups30d += 1;
  }

  const denominator = activeSubs + cancellations30d;
  const churnRate30d = denominator > 0 ? cancellations30d / denominator : 0;

  const snapshot: MetricsSnapshot = {
    asOfDate: asOf.toISOString(),
    currency,
    mrrCents: roundedMrr,
    arrCents,
    activeSubs,
    signups7d,
    signups30d,
    cancellations30d,
    churnRate30d,
  };

  snapshotCache.set(ck, { computedAt: Date.now(), asOfUnix, snapshot });
  return snapshot;
}
