ALTER TABLE orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY', 'COMPLETED', 'CANCELLED'));

DROP INDEX orders_open_table;
CREATE INDEX orders_open_table ON orders (tenant_id, outlet_id, table_id)
  WHERE status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY') AND deleted_at IS NULL;
