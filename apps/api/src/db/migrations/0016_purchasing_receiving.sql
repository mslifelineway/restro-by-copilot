CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  name text NOT NULL,
  phone text,
  email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id)
);
CREATE UNIQUE INDEX suppliers_outlet_name
  ON suppliers (tenant_id, outlet_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER suppliers_touch BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'ORDERED' CHECK (status IN ('ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED')),
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, supplier_id) REFERENCES suppliers(tenant_id, outlet_id, id),
  UNIQUE (tenant_id, outlet_id, id)
);
CREATE INDEX purchase_orders_outlet_date ON purchase_orders (tenant_id, outlet_id, created_at DESC);
CREATE TRIGGER purchase_orders_touch BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  ordered_quantity_milli bigint NOT NULL CHECK (ordered_quantity_milli > 0),
  received_quantity_milli bigint NOT NULL DEFAULT 0 CHECK (received_quantity_milli >= 0 AND received_quantity_milli <= ordered_quantity_milli),
  unit_cost_paise bigint NOT NULL CHECK (unit_cost_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id, purchase_order_id) REFERENCES purchase_orders(tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id),
  UNIQUE (tenant_id, purchase_order_id, inventory_item_id)
);
CREATE UNIQUE INDEX purchase_order_lines_tenant_id_id ON purchase_order_lines (tenant_id, id);

CREATE TABLE purchase_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  purchase_order_id uuid NOT NULL,
  received_by uuid NOT NULL REFERENCES users(id),
  reference text,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id, purchase_order_id) REFERENCES purchase_orders(tenant_id, outlet_id, id),
  UNIQUE (tenant_id, outlet_id, id)
);

CREATE TABLE purchase_receipt_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  receipt_id uuid NOT NULL,
  purchase_order_line_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  unit_cost_paise bigint NOT NULL CHECK (unit_cost_paise >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id, receipt_id) REFERENCES purchase_receipts(tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, purchase_order_line_id) REFERENCES purchase_order_lines(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON suppliers, purchase_orders TO rms_app;
GRANT SELECT, INSERT, UPDATE ON purchase_order_lines TO rms_app;
GRANT SELECT, INSERT ON purchase_receipts, purchase_receipt_lines TO rms_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers','purchase_orders','purchase_order_lines','purchase_receipts','purchase_receipt_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;
