ALTER TABLE orders
  ADD COLUMN assigned_waiter_id uuid REFERENCES users(id);
CREATE INDEX orders_assigned_waiter
  ON orders (tenant_id, outlet_id, assigned_waiter_id, created_at DESC)
  WHERE assigned_waiter_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE dining_tables
  ADD COLUMN merged_order_id uuid;
ALTER TABLE dining_tables
  ADD CONSTRAINT dining_tables_merged_order_fk
  FOREIGN KEY (tenant_id, merged_order_id) REFERENCES orders(tenant_id, id);
CREATE INDEX dining_tables_merged_order_lookup
  ON dining_tables (tenant_id, outlet_id, merged_order_id)
  WHERE merged_order_id IS NOT NULL;
