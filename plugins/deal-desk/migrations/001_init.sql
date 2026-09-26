-- deal-desk initial schema.
--
-- The namespace name is derived by the host from the plugin key (deal-desk)
-- and the manifest namespaceSlug (deal_desk), as
-- plugin_<slug>_<first 10 hex of sha256(pluginKey)>. It is hardcoded here
-- because plugin migrations must use fully qualified names.
--
-- Every table carries company_id and every runtime query filters on it.
-- Money is whole cents in bigint columns.
-- Keep quote characters out of these comments. The host validator strips
-- quoted strings before it strips comments, so a stray apostrophe here
-- would make it misread the statement.

-- One deal per business record per company. business_id is the id of the
-- business in the business-records plugin. Plugins cannot read each other,
-- so it is stored as given and not checked.
CREATE TABLE plugin_deal_desk_bf83b73d01.deals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  business_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  stage text NOT NULL DEFAULT 'screen'
    CHECK (stage IN ('screen', 'diligence', 'offer', 'closing', 'closed', 'passed')),
  structure text NOT NULL DEFAULT 'undecided'
    CHECK (structure IN ('asset', 'stock', 'undecided')),
  acquiring_entity text,
  asking_price_cents bigint CHECK (asking_price_cents IS NULL OR asking_price_cents >= 0),
  currency char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX deals_company_business_uq
  ON plugin_deal_desk_bf83b73d01.deals (company_id, business_id);

CREATE INDEX deals_company_stage_idx
  ON plugin_deal_desk_bf83b73d01.deals (company_id, stage);

-- One row per period per source, so a tax return figure and a P and L
-- figure for the same year sit side by side.
CREATE TABLE plugin_deal_desk_bf83b73d01.earnings_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES plugin_deal_desk_bf83b73d01.deals (id),
  period_label text NOT NULL CHECK (length(btrim(period_label)) > 0),
  period_start date NOT NULL,
  period_end date NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('tax_return', 'pnl', 'bank', 'seller_stated', 'other')),
  revenue_cents bigint NOT NULL CHECK (revenue_cents >= 0),
  net_income_cents bigint NOT NULL,
  owner_comp_cents bigint NOT NULL CHECK (owner_comp_cents >= 0),
  depreciation_cents bigint CHECK (depreciation_cents IS NULL OR depreciation_cents >= 0),
  interest_cents bigint CHECK (interest_cents IS NULL OR interest_cents >= 0),
  document_id uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

CREATE UNIQUE INDEX earnings_periods_label_source_uq
  ON plugin_deal_desk_bf83b73d01.earnings_periods (deal_id, period_label, source_kind);

CREATE INDEX earnings_periods_company_deal_idx
  ON plugin_deal_desk_bf83b73d01.earnings_periods (company_id, deal_id);

-- The add-back schedule. The unique key on the lowercased description means
-- the same add-back cannot be counted twice for a period. An accepted row
-- must carry its evidence document, a rejected row its reason, and a
-- replacement cost is a positive cost.
CREATE TABLE plugin_deal_desk_bf83b73d01.earnings_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES plugin_deal_desk_bf83b73d01.deals (id),
  period_label text NOT NULL CHECK (length(btrim(period_label)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  amount_cents bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'owner_comp', 'owner_perk', 'one_time', 'non_cash', 'rent_to_owner', 'replacement_cost', 'other'
  )),
  claimed_by text NOT NULL CHECK (claimed_by IN ('seller', 'agent', 'barry', 'cpa', 'other')),
  status text NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'accepted', 'rejected')),
  evidence_document_id uuid,
  note text,
  status_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'accepted' OR evidence_document_id IS NOT NULL),
  CHECK (status <> 'rejected' OR (status_note IS NOT NULL AND length(btrim(status_note)) > 0)),
  CHECK (kind <> 'replacement_cost' OR amount_cents > 0)
);

CREATE UNIQUE INDEX earnings_adjustments_description_uq
  ON plugin_deal_desk_bf83b73d01.earnings_adjustments (deal_id, period_label, lower(description));

CREATE INDEX earnings_adjustments_company_deal_idx
  ON plugin_deal_desk_bf83b73d01.earnings_adjustments (company_id, deal_id, period_label);

-- Saved calculator runs. Never updated, only inserted: the plugin has no
-- UPDATE statement for this table, so a memo can cite a scenario by id and
-- it will say the same thing later.
CREATE TABLE plugin_deal_desk_bf83b73d01.scenarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES plugin_deal_desk_bf83b73d01.deals (id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  earnings_basis text NOT NULL CHECK (earnings_basis IN ('reported', 'conservative', 'seller_claimed', 'custom')),
  basis_note text,
  comparables_note text,
  inputs jsonb NOT NULL,
  outputs jsonb NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (earnings_basis <> 'custom' OR (basis_note IS NOT NULL AND length(btrim(basis_note)) > 0))
);

CREATE INDEX scenarios_company_deal_idx
  ON plugin_deal_desk_bf83b73d01.scenarios (company_id, deal_id, created_at);

CREATE UNIQUE INDEX scenarios_idempotency_uq
  ON plugin_deal_desk_bf83b73d01.scenarios (deal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Append-only. The plugin never updates or deletes a history row.
-- subject_id names the period, add-back or scenario a row is about (null
-- for rows about the deal record itself).
CREATE TABLE plugin_deal_desk_bf83b73d01.deal_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL,
  deal_id uuid NOT NULL REFERENCES plugin_deal_desk_bf83b73d01.deals (id),
  kind text NOT NULL CHECK (kind IN (
    'deal_created', 'deal_updated', 'stage_change', 'period_added', 'period_updated',
    'adjustment_added', 'adjustment_updated', 'adjustment_status_change', 'scenario_saved'
  )),
  subject_id uuid,
  field text,
  old_value text,
  new_value text,
  actor jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX deal_history_deal_idx
  ON plugin_deal_desk_bf83b73d01.deal_history (company_id, deal_id, created_at);
