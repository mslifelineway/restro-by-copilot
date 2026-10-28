ALTER TABLE orders
  ADD COLUMN billing_group_id uuid,
  ADD COLUMN billing_group_primary boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT orders_billing_group_primary_check
    CHECK (billing_group_primary = false OR billing_group_id IS NOT NULL);

CREATE UNIQUE INDEX orders_billing_group_primary
  ON orders (tenant_id, billing_group_id)
  WHERE billing_group_primary = true;
CREATE INDEX orders_billing_group_members
  ON orders (tenant_id, outlet_id, billing_group_id)
  WHERE billing_group_id IS NOT NULL;

ALTER TABLE invoices DROP CONSTRAINT invoices_tenant_id_order_id_key;
