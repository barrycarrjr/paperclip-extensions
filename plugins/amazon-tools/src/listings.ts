// Shapes listing, catalog, offer and A+ responses into the trimmed JSON agents
// see, and into the flat snapshots Listing Watch compares between runs.

import { createHash } from "node:crypto";
import { dropEmpty } from "./trim.js";

type Obj = Record<string, unknown>;

function arr(value: unknown): Obj[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Obj[]) : [];
}

function forMarketplace(list: unknown, marketplaceId: string): Obj | undefined {
  const items = arr(list);
  return items.find((i) => i.marketplaceId === marketplaceId);
}

/** Values of one listing/catalog attribute, e.g. bullet_point, for one marketplace. */
export function attributeValues(attributes: unknown, name: string, marketplaceId: string): string[] {
  const entries = arr((attributes as Obj | undefined)?.[name]);
  const local = entries.filter((e) => !e.marketplace_id || e.marketplace_id === marketplaceId);
  return local
    .map((e) => (typeof e.value === "string" ? e.value : typeof e.value === "number" ? String(e.value) : undefined))
    .filter((v): v is string => typeof v === "string");
}

function money(price: unknown): string | undefined {
  const p = (price ?? {}) as Obj;
  const amount = p.amount ?? p.Amount;
  const currency = p.currencyCode ?? p.CurrencyCode;
  if (amount === undefined || amount === null) return undefined;
  return `${String(currency ?? "")} ${Number(amount).toFixed(2)}`.trim();
}

function issueList(issues: unknown): Obj[] {
  return arr(issues).map((i) => dropEmpty({
    code: i.code,
    severity: i.severity,
    message: typeof i.message === "string" ? i.message.slice(0, 500) : undefined,
    attributeNames: i.attributeNames,
    categories: i.categories,
  }) as Obj);
}

// ─── Agent-facing shapes ─────────────────────────────────────────────────

export function trimListing(item: unknown, marketplaceId: string, withAttributes = false): Obj {
  const i = (item ?? {}) as Obj;
  const summary = forMarketplace(i.summaries, marketplaceId) ?? {};
  const offer = arr(i.offers).find((o) => o.marketplaceId === marketplaceId && (o.offerType ?? "B2C") === "B2C");
  const out: Obj = {
    sku: i.sku,
    asin: summary.asin,
    productType: summary.productType,
    condition: summary.conditionType,
    status: summary.status,
    itemName: summary.itemName,
    mainImage: (summary.mainImage as Obj | undefined)?.link,
    lastUpdated: summary.lastUpdatedDate,
    price: money(offer?.price),
    issues: issueList(i.issues),
    fulfillmentAvailability: arr(i.fulfillmentAvailability).map((f) => ({
      fulfillmentChannelCode: f.fulfillmentChannelCode,
      quantity: f.quantity,
    })),
  };
  if (withAttributes) out.submitted = submittedContent(i.attributes, marketplaceId);
  return dropEmpty(out) as Obj;
}

/** What the seller submitted for the listing (Listings Items attributes). */
export function submittedContent(attributes: unknown, marketplaceId: string): Obj {
  return dropEmpty({
    title: attributeValues(attributes, "item_name", marketplaceId)[0],
    brand: attributeValues(attributes, "brand", marketplaceId)[0],
    bullets: attributeValues(attributes, "bullet_point", marketplaceId),
    description: attributeValues(attributes, "product_description", marketplaceId)[0],
    searchTerms: attributeValues(attributes, "generic_keyword", marketplaceId),
  }) as Obj;
}

/** What Amazon shows on the detail page (Catalog Items). */
export function trimCatalogItem(item: unknown, marketplaceId: string): Obj {
  const i = (item ?? {}) as Obj;
  const summary = forMarketplace(i.summaries, marketplaceId) ?? {};
  const images = arr(forMarketplace(i.images, marketplaceId)?.images);
  return dropEmpty({
    asin: i.asin,
    title: summary.itemName,
    brand: summary.brand,
    category: (summary.browseClassification as Obj | undefined)?.displayName,
    productType: forMarketplace(i.productTypes, marketplaceId)?.productType,
    bullets: attributeValues(i.attributes, "bullet_point", marketplaceId),
    description: attributeValues(i.attributes, "product_description", marketplaceId)[0],
    images: images
      .filter((img) => typeof img.link === "string")
      .map((img) => ({ variant: img.variant, link: img.link })),
    salesRanks: arr(forMarketplace(i.salesRanks, marketplaceId)?.displayGroupRanks).map((r) => ({
      title: r.title,
      rank: r.rank,
    })),
  }) as Obj;
}

/** Offers on one ASIN: who has the Buy Box, at what price, and who else sells it. */
export function trimItemOffers(payload: unknown): Obj {
  const p = (payload ?? {}) as Obj;
  const summary = (p.Summary ?? {}) as Obj;
  const offers = arr(p.Offers);
  const winner = offers.find((o) => o.IsBuyBoxWinner === true);
  const buyBoxPrice = arr(summary.BuyBoxPrices)[0];
  return dropEmpty({
    asin: p.ASIN,
    totalOfferCount: summary.TotalOfferCount,
    buyBox: winner
      ? { holder: winner.MyOffer === true ? "us" : "other", sellerId: winner.SellerId, price: money(winner.ListingPrice) }
      : { holder: buyBoxPrice ? "unknown" : "none", price: money((buyBoxPrice as Obj | undefined)?.LandedPrice) },
    offers: offers.map((o) => dropEmpty({
      sellerId: o.SellerId,
      isOurs: o.MyOffer === true,
      price: money(o.ListingPrice),
      shipping: money(o.Shipping),
      fba: o.IsFulfilledByAmazon,
      buyBoxWinner: o.IsBuyBoxWinner,
      condition: o.SubCondition,
    })),
  }) as Obj;
}

/** A+ content for an ASIN: each published document's name, status and a fingerprint of its modules. */
export function trimAplusDocument(record: unknown): Obj {
  const r = ((record as Obj | undefined)?.contentRecord ?? {}) as Obj;
  const meta = (r.contentMetadata ?? {}) as Obj;
  const doc = (r.contentDocument ?? {}) as Obj;
  const modules = arr(doc.contentModuleList);
  return dropEmpty({
    contentReferenceKey: r.contentReferenceKey,
    name: meta.name ?? doc.name,
    status: meta.status,
    badges: meta.badgeSet,
    updated: meta.updateTime,
    moduleCount: modules.length,
    moduleTypes: modules.map((m) => m.contentModuleType),
    fingerprint: modules.length > 0 ? fingerprint(modules) : undefined,
  }) as Obj;
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

// ─── Snapshots ───────────────────────────────────────────────────────────
//
// A snapshot is a flat map of field -> value. Two runs are compared field by
// field, so each difference becomes one change row an agent can read.

export type Snapshot = Record<string, string | number | boolean | string[] | null>;

const MAX_TEXT = 2000;

function text(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

/** Status, issues, price and Buy Box: checked on every run. */
export function statusSnapshot(listing: Obj, offers: Obj | undefined): Snapshot {
  const issues = arr(listing.issues);
  const buyBox = (offers?.buyBox ?? {}) as Obj;
  const others = arr(offers?.offers)
    .filter((o) => o.isOurs !== true && typeof o.sellerId === "string")
    .map((o) => o.sellerId as string);
  return {
    asin: (listing.asin as string | undefined) ?? null,
    status: Array.isArray(listing.status) ? [...(listing.status as string[])].sort() : [],
    title: text(listing.itemName),
    mainImage: text(listing.mainImage),
    issues: issues.map((i) => `${String(i.severity ?? "")}: ${String(i.code ?? "")}`).sort(),
    ourPrice: (listing.price as string | undefined) ?? null,
    buyBoxHolder: offers ? ((buyBox.holder as string | undefined) ?? "none") : null,
    buyBoxPrice: offers ? ((buyBox.price as string | undefined) ?? null) : null,
    offerCount: offers ? ((offers.totalOfferCount as number | undefined) ?? 0) : null,
    otherSellers: offers ? [...new Set(others)].sort() : [],
  };
}

/** Detail-page content, submitted versus shown, and A+: checked once a day. */
export function contentSnapshot(submitted: Obj, live: Obj, aplus: Obj[]): Snapshot {
  const submittedTitle = text(submitted.title);
  const liveTitle = text(live.title);
  return {
    submittedTitle,
    liveTitle,
    titleOverridden: submittedTitle !== null && liveTitle !== null && submittedTitle !== liveTitle,
    submittedBullets: ((submitted.bullets as string[] | undefined) ?? []).map((b) => text(b) ?? ""),
    liveBullets: ((live.bullets as string[] | undefined) ?? []).map((b) => text(b) ?? ""),
    submittedDescription: text(submitted.description),
    liveDescription: text(live.description),
    searchTerms: ((submitted.searchTerms as string[] | undefined) ?? []).map((b) => text(b) ?? ""),
    brand: text(live.brand ?? submitted.brand),
    category: text(live.category),
    productType: text(live.productType),
    images: arr(live.images).map((img) => `${String(img.variant ?? "")} ${String(img.link ?? "")}`.trim()),
    aplus: aplus
      .map((d) => `${String(d.name ?? d.contentReferenceKey ?? "")} [${String(d.status ?? "")}] ${String(d.fingerprint ?? "")}`.trim())
      .sort(),
  };
}

export interface FieldChange {
  field: string;
  before: Snapshot[string] | undefined;
  after: Snapshot[string] | undefined;
}

export function diffSnapshots(before: Snapshot, after: Snapshot): FieldChange[] {
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return fields
    .filter((f) => JSON.stringify(before[f] ?? null) !== JSON.stringify(after[f] ?? null))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}
