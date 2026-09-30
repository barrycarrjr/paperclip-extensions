ALTER TABLE plugin_customer_support_0c69412611.support_cases
  ADD COLUMN symptom_outcome text CHECK (symptom_outcome IN ('resolved','still_present','needs_follow_up')),
  ADD COLUMN symptom_evidence text,
  ADD COLUMN symptom_basis text CHECK (symptom_basis IN ('person_confirmed','observed','not_confirmed')),
  ADD COLUMN symptom_recorded_by_user_id text,
  ADD COLUMN symptom_recorded_at timestamptz;
