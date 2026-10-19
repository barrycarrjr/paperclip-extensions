---
name: domain-leakage-investor
description: Find "domain leakage" domains to acquire (the exact-match .com of a word a business advertises while its own site lives on a longer variant, so people who remember the ad type the short name and land somewhere else), screen them for trademark risk, value them, run them for income while they hold, and plan the sale. Use when an operator says "find leakage domains", "is this domain worth buying", "how is our domain portfolio doing", or "should we sell this domain". Never buys, bids, transfers or changes DNS on its own; every spend goes through board approval.
---

# Domain Leakage Investor

A business advertises a name ("Nuzzle") but its website is a variant
(`getnuzzle.com`, `nuzzlepillow.com`). Viewers remember the name, type
`nuzzle.com`, and land on whoever owns that domain. That stray traffic is
**leakage**. The owner of the exact-match domain collects it for free,
earns from it, and holds an asset whose value rises with the advertiser's
spend.

Worked public example (Rick Schwartz, X, 2026-10-19): `nuzzle.com` bought
at auction for $11,648, about 100,000 visits a year, about $2,000 a year
from parking ads (a 17% yearly return), with a $16,500 inbound offer
already received.

This skill has four modes. Pick the one the issue asks for:

| Mode | Use when | Output |
|------|----------|--------|
| `scout` | "Find leakage domains" | Ranked candidate list, issue document `leakage-candidates` |
| `evaluate` | "Is `<domain>` worth buying?" | One-domain buy memo + board approval request |
| `operate` | Monthly check on a domain we own | Income + traffic update on that domain's issue |
| `exit` | Offer received, or "should we sell?" | Exit memo with price floor, ask price and recommendation |

---

## Hard rules

1. **No money moves without board approval.** Bids, purchases, broker
   fees, marketplace listings with a Buy Now price, and accepting an
   offer each need an approved `request_board_approval`. The agent
   prepares; a human executes at the registrar or marketplace.
2. **Trademark screen before any spend** (Step 3). A domain that fails
   is dropped, however good the traffic looks.
3. **Never cold-pitch the business whose name matches the domain.**
   Offering a brand-matching domain to the brand is the textbook
   evidence of bad faith in UDRP and ACPA cases. Sales to that business
   happen only from offers they start. Listing the domain publicly on a
   marketplace is fine.
4. **Never turn on catch-all email** (MX records) for an acquired domain.
   Misdirected email meant for the business is not ours to read.
5. **Never redirect visitors to the business, a competitor, or an
   affiliate link for either.** That trades on their name.
6. **Numbers you did not measure are labelled as estimates,** with the
   assumption written next to them. Never present an estimate as data.
7. This skill is not legal advice. Before the company's first purchase,
   the board should have a trademark lawyer read the Step 3 screen.

---

## Pre-conditions

- `curl` and `jq`, plus web search / fetch (WebSearch, WebFetch or
  equivalent) for brand and auction research.
- Paperclip API access (`$PAPERCLIP_API_URL`, `$PAPERCLIP_API_KEY`) for
  documents, comments and approvals. See the `paperclip` skill.
- No paid service is required. Everything below uses free public
  endpoints. Paid tools (Similarweb, Ahrefs, Estibot premium) make
  traffic estimates better; mention them in a report as an option, never
  sign up for one.

---

## Step 1 (scout): Find advertisers whose name is leaking

Leakage is strongest when the business spends on **mass, non-clickable
ads** (TV, radio, podcasts, billboards, packaging) where people must
remember and type the name.

Sources, in order of signal:

1. **TV and streaming advertisers.** Search `site:ispot.tv <category>`
   and iSpot's "new this week" brand lists. Note each brand and the URL
   shown in the ad.
2. **Podcast and radio sponsors.** Search podcast ad reads for
   "go to <something>.com/<code>" where the spoken word differs from a
   short `.com`.
3. **Shopping and DTC brands.** Shark Tank / Dragons' Den features,
   "as seen on TV" products, Product Hunt launches, Kickstarter top
   campaigns.
4. **Rebrands and name changes.** A company that changed its name may
   let the old exact-match `.com` lapse while years of links and
   bookmarks still point at it.
5. **Expiring and auction inventory.** GoDaddy Auctions, NameJet,
   DropCatch, SnapNames, Sedo and Afternic listings. Cross-check
   dictionary-word names against Step 1.1 to 1.4 brand lists.

For each brand, record: the spoken/printed name, the domain the brand
actually uses, where it advertises, and the exact-match `.com`
(name, lowercase, no spaces or hyphens).

A brand is a **leakage candidate** when its real site is NOT the
exact-match `.com`. Typical patterns: `get<name>.com`, `try<name>.com`,
`<name>hq.com`, `<name><product>.com`, `<name>.co`, `<name>.io`.

---

## Step 2: Check the exact-match domain

Run for each candidate domain (`D`):

```bash
D="example.com"

# Registered? RDAP 404 means not registered (verify at a registrar before
# celebrating; also check it is not reserved or premium-priced).
curl -s -L -o /tmp/rdap.json -w "%{http_code}\n" "https://rdap.org/domain/$D"
jq -r '[.events[]? | "\(.eventAction)=\(.eventDate)"] | join("  ")' /tmp/rdap.json

# History: which years the Wayback Machine has captures for. A long
# history with real content suggests type-in and link traffic.
curl -s "https://web.archive.org/cdx/search/cdx?url=$D&output=json&fl=timestamp,statuscode&collapse=timestamp:4" \
  | jq -c '.[1:] | map(.[0][0:4])'

# Where it points now: nameservers reveal parking / marketplace
# (e.g. *.afternic, *.sedoparking, *.bodis, *.parkingcrew, dan.com).
curl -s "https://dns.google/resolve?name=$D&type=NS" | jq -c '[.Answer[]?.data]'
curl -s -L -o /dev/null -w "%{http_code} %{url_effective}\n" "https://$D"
```

Classify the domain's status:

| Status | Meaning | Next action |
|--------|---------|-------------|
| `available` | Not registered | Register-price check; go to Step 3 |
| `auction` | Listed at an auction or expiring/drop list | Note close date + current bid; Step 3 |
| `for-sale` | Parked with a marketplace lander or Buy Now price | Note price; Step 3 |
| `parked` | Parked, no price shown | Owner may sell; Step 3, then inquiry |
| `in-use` | A real site or business uses it | Drop. Not leakage, it is someone's home |

Note: RDAP `registration` is the date of the **current** registration.
A domain that dropped and was re-registered shows the new date. Use the
Wayback history for its real age.

---

## Step 3: Trademark screen (hard gate)

Under UDRP and the US Anti-Cybersquatting Consumer Protection Act, a
domain can be taken away (and in the US, damages awarded) when it
matches a mark, the owner has no legitimate interest, and it was
acquired or used in bad faith. Bad faith includes buying it mainly to
sell to the mark owner, or using it to profit from confusion with the
mark (including parking ads for the brand's own products). For UDRP, the
date **we** acquire the domain counts as the registration date, so an
old domain does not protect a new buyer.

Score each candidate. Any **FAIL** drops it.

| Check | PASS | FAIL |
|-------|------|------|
| Word type | Common dictionary word, common name, or generic phrase with many unrelated meanings ("nuzzle", "harbor", "bolt") | Coined or invented word that only means the brand ("Xfinity", "Zillow") |
| Typos | Exact word | Misspelling, typo or added letter of a brand name |
| Fame | Mark is not famous | Famous mark (household name), any spelling |
| Other uses | Search shows other businesses, places or meanings using the word | The word is used only by this brand |
| Planned use | Use tied to the word's ordinary meaning (Step 5) | Any plan that relies on people thinking it is the brand |

Also run a trademark search on the word (USPTO trademark search,
WIPO Global Brand Database) and record registered marks, owners and
classes. Many marks on the same word across unrelated classes is a
good sign (no single owner). One mark that owns the word is a warning.

Write the result as `screen: PASS | FAIL` with one line of reasons per
check. If unsure, mark `screen: REVIEW` and flag it to the board; do not
treat REVIEW as PASS.

---

## Step 4: Value it (evaluate)

Before purchase you cannot see the traffic, so estimate from signals
and label every figure as an estimate.

**Leakage signals** (score 0 to 3 each, total out of 15):

| Signal | 0 | 3 |
|--------|---|---|
| Advertiser spend on recall media | None found | National TV / heavy podcast |
| Name memorability gap | Brand uses exact-match `.co` only | Brand uses a long or odd variant |
| Search interest in the brand name | Flat / tiny | Strong and rising (Google Trends via search) |
| Domain history | No captures | 10+ years of real content |
| Seller traffic data | None | Auction/marketplace shows visits |

Auction platforms (GoDaddy Auctions, NameJet, Sedo) often show a
traffic or visitor figure for the listing. Use it, cited.

**Money math** (show it in the memo):

```
est_annual_visits   = seller figure, or a stated assumption
parking_rpm         = revenue per 1,000 visits. Assumption, default $10.
                      (Public example: $2,000 / 100,000 visits = $20.)
est_parking_income  = est_annual_visits / 1000 * parking_rpm
renewal_cost        = current yearly renewal at the chosen registrar
est_net_income      = est_parking_income - renewal_cost
income_value        = est_net_income / 0.10      # price that yields 10% a year
resale_comps        = recent sales of similar names (NameBio search)
max_price           = lower of income_value and 50% of the low end of
                      resale_comps, unless the board sets a different rule
```

Show a low / base / high case. If `max_price` is below the asking price
or current bid, recommend passing and say what would change the answer.

**Buy memo** (issue document `buy-memo-<domain>`), sections in order:

1. Recommendation (buy up to $X / pass) and why, in two sentences.
2. The advertiser: name, real site, where it advertises, evidence links.
3. Domain status and history (Step 2 output).
4. Trademark screen (Step 3 table).
5. Money math, three cases, every assumption labelled.
6. Holding plan (Step 5) and exit plan (Step 7).
7. Risks: brand stops advertising, brand files UDRP, estimates wrong,
   renewal price rises.

Then request approval:

```bash
curl -s -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json" \
  -d "$(jq -n --arg agent "$PAPERCLIP_AGENT_ID" --arg issue "$PAPERCLIP_TASK_ID" \
        --arg d "$D" --arg max "$MAX_PRICE" '{
    type: "request_board_approval",
    requestedByAgentId: $agent,
    issueIds: [$issue],
    payload: {
      title: ("Buy " + $d + " up to $" + $max),
      summary: "Leakage domain. Buy memo attached to the issue.",
      recommendedAction: ("Bid or buy " + $d + " at no more than $" + $max + ". A human completes the purchase."),
      risks: ["Traffic figures are estimates until we own it.", "Trademark screen is not legal advice."]
    }
  }')"
```

---

## Step 5: Earn while holding (after purchase)

When the board reports the purchase done, open one issue per domain
(`Domain: <domain>`) to be its running record. Put the purchase price,
date, registrar and renewal date in the issue description.

Setup checklist (a human does the account steps; the agent writes the
checklist into the issue):

1. **Lock and auto-renew** at the registrar. Note renewal date.
2. **Measure traffic.** Point DNS through a free analytics option
   (Cloudflare free plan analytics) or use the parking provider's stats.
   Real numbers replace the estimates from Step 4.
3. **Monetize in a way tied to the word's ordinary meaning,** one of:
   - **Parking with a "for sale" banner** (Bodis, ParkingCrew, Sedo
     parking, or the marketplace's own lander). Set the ad keywords to
     the word's dictionary meaning. **Block keywords for the brand's
     product category and the brand's name.** Ads for the brand's own
     products are exactly what UDRP panels treat as bad faith. This
     costs some income; it keeps the asset.
   - **A simple content page** about the word's ordinary meaning, with
     a "this domain may be for sale" link. Lower income, strongest
     legal position.
   - **Lease or lease-to-own** to a business that uses the word in an
     unrelated field (marketplace lease-to-own listings).
4. **List for sale** on Afternic (GoDaddy network) and Sedo with a
   "make offer" or a Buy Now price at the Step 7 ask. A public listing
   is open to anyone; it is not a pitch to the brand.

## Step 6 (operate): Monthly check

On each domain issue, post a comment:

```
Month: <YYYY-MM>
Visits: <n> (source: <parking stats | Cloudflare>)   Trend vs last month: <+/-%>
Income: $<n> month, $<n> trailing 12 months
Yield on cost: <trailing 12m net income / purchase price>%
Brand check: still advertising? <yes/no, evidence>. Site changed? <url>
Spikes: <dates and size, if any>
Offers received: <none | amount, from, date>
Renewal due: <date>
Action needed: <none | what>
```

Watch for:
- **Traffic spikes** that line up with the brand's campaigns. Note them;
  they support the exit price.
- **The brand moving onto a different variant** or going quiet; leakage
  will fade, so consider selling sooner.
- **Any legal letter or UDRP complaint.** Stop, do not reply, raise it to
  the board as urgent the same heartbeat.

---

## Step 7 (exit): Price and sell

**Price floor** (never accept below without a board decision):

```
floor = max( purchase_price + holding_costs_to_date,
             trailing_12m_net_income * 5 )
```

**Ask price**: the higher of comparable sales (NameBio) and
`trailing_12m_net_income * 10`. The board may set a different multiple.

**What the traffic is worth to a buyer.** When a buyer (any buyer)
makes an offer, the memo may show what the traffic could be worth to a
business that converts it, as context for the board's counter:

```
annual_visits * conversion (state: 1% low, 3% base) * average order (state)
  = potential annual sales reaching the right business
```

This is context for evaluating an offer the buyer started. **Never
put this math in a message to the brand, and never contact the brand
first** (Hard rule 3).

**Exit memo** (issue document `exit-memo-<domain>`):

1. Recommendation: accept / counter at $X / decline, in two sentences.
2. The offer: amount, who (if known), through which channel, date.
3. Holding results: cost, income to date, trailing 12m, yield.
4. Floor, ask, comps, traffic trend.
5. Hold-on value: what another year is likely to earn, and the risk the
   brand stops advertising.

Request board approval to accept or counter. Sales close through a
marketplace or escrow (Afternic, Sedo, Escrow.com); never accept direct
payment and transfer the domain on trust.

---

## Scout report format

Issue document `leakage-candidates`, newest first:

| Domain | Brand + real site | Ad channel | Status | Screen | Signal score /15 | Price / bid | Est. max price | Next step |
|--------|-------------------|------------|--------|--------|------------------|-------------|----------------|-----------|

Under the table: the top three with one line each on why, and every
candidate dropped at Step 3 with its FAIL reason (so the board can see
the screen working). End with a comment on the issue linking the
document and naming the next action.

---

## Failure handling

| Situation | What to do |
|-----------|------------|
| RDAP times out or rate-limits | Retry once after 30 seconds; else mark status `unknown`, never `available` |
| No traffic data anywhere | Score the signal 0 and say "no traffic data"; do not invent visits |
| Auction closes before approval | Note it on the issue and move on; do not bid without approval |
| Trademark search unavailable | Mark `screen: REVIEW`, not PASS |
| Board rejects | Record the reason on the issue so future scouts learn the board's taste |
