-- Keep the one-running-repair constraint after a worker/host restart.
-- If an older deployment has overlapping running attempts, reconcile them
-- before this migration; never automatically declare their outcomes known.
CREATE UNIQUE INDEX support_actions_one_running_target_idx
  ON plugin_customer_support_0c69412611.support_actions(lower(target_address))
  WHERE status='running';
