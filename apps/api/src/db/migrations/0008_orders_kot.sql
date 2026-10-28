-- P1 M7: outlet-scoped dine-in/takeaway orders and immutable KOT snapshots.
CREATE UNIQUE INDEX dining_tables_tenant_id_id ON dining_tables (tenant_id, id);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  table_id uuid,
  order_type text NOT NULL CHECK (order_type IN ('DINE_IN', 'TAKEAWAY', 'DELIVERY')),
  status text NOT NULL DEFAULT 'OPEN'
    CHECK (status IN ('OPEN', 'IN_PROGRESS', 'READY', 'COMPLETED', 'CANCELLED')),
  notes text NOT NULL DEFAULT '',
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, table_id) REFERENCES dining_tables(tenant_id, id),
  CHECK ((order_type = 'DINE_IN' AND table_id IS NOT NULL) OR (order_type <> 'DINE_IN' AND table_id IS NULL))
);
CREATE UNIQUE INDEX orders_tenant_id_id ON orders (tenant_id, id);
CREATE INDEX orders_outlet_created ON orders (tenant_id, outlet_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX orders_open_table ON orders (tenant_id, outlet_id, table_id) WHERE status IN ('OPEN','IN_PROGRESS','READY') AND deleted_at IS NULL;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE kot_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  order_id uuid NOT NULL,
  ticket_number bigint GENERATED ALWAYS AS IDENTITY,
  status text NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'PREPARING', 'READY', 'SERVED', 'CANCELLED')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id)
);
CREATE UNIQUE INDEX kot_tickets_tenant_id_id ON kot_tickets (tenant_id, id);
CREATE INDEX kot_outlet_queue ON kot_tickets (tenant_id, outlet_id, created_at) WHERE deleted_at IS NULL;
CREATE TRIGGER kot_tickets_touch BEFORE UPDATE ON kot_tickets FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  order_id uuid NOT NULL,
  kot_ticket_id uuid,
  menu_item_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  item_name text NOT NULL,
  variant_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  tax_code text NOT NULL,
  cgst_rate integer NOT NULL CHECK (cgst_rate BETWEEN 0 AND 10000),
  sgst_rate integer NOT NULL CHECK (sgst_rate BETWEEN 0 AND 10000),
  igst_rate integer NOT NULL CHECK (igst_rate BETWEEN 0 AND 10000),
  add_ons jsonb NOT NULL DEFAULT '[]',
  notes text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'IN_KITCHEN', 'READY', 'SERVED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  FOREIGN KEY (tenant_id, kot_ticket_id) REFERENCES kot_tickets(tenant_id, id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants(tenant_id, id)
);
CREATE INDEX order_items_order ON order_items (tenant_id, order_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX order_items_unfired ON order_items (tenant_id, order_id) WHERE kot_ticket_id IS NULL AND status = 'PENDING' AND deleted_at IS NULL;
CREATE TRIGGER order_items_touch BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON orders, kot_tickets, order_items TO rms_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rms_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['orders','kot_tickets','order_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;
