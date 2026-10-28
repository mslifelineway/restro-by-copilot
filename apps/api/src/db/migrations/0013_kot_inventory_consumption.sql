-- Tie automatic consumption movements to a KOT line so retries cannot deduct twice.
ALTER TABLE stock_ledger ADD COLUMN source_key text;
CREATE UNIQUE INDEX stock_ledger_tenant_source_key
  ON stock_ledger (tenant_id, source_key);
