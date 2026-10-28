-- P1 M10: outlet inventory catalog, append-only stock ledger, and menu BOM.
CREATE TABLE inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  name text NOT NULL,
  base_unit text NOT NULL CHECK (base_unit IN ('KG', 'G', 'L', 'ML', 'EA', 'UNIT')),
  reorder_level_milli bigint NOT NULL DEFAULT 0 CHECK (reorder_level_milli >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);
CREATE UNIQUE INDEX inventory_items_outlet_name
  ON inventory_items (tenant_id, outlet_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX inventory_items_tenant_id_id ON inventory_items (tenant_id, id);
CREATE TRIGGER inventory_items_touch BEFORE UPDATE ON inventory_items
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE stock_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_delta_milli bigint NOT NULL CHECK (quantity_delta_milli <> 0),
  reason text NOT NULL CHECK (reason IN ('RECEIPT', 'ADJUSTMENT', 'WASTE', 'CONSUMPTION', 'RETURN')),
  reference text,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id)
);
CREATE INDEX stock_ledger_balance ON stock_ledger (tenant_id, outlet_id, inventory_item_id, created_at);

CREATE TABLE menu_recipes (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  menu_item_id uuid NOT NULL,
  inventory_item_id uuid NOT NULL,
  quantity_milli bigint NOT NULL CHECK (quantity_milli > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (menu_item_id, inventory_item_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items(tenant_id, id),
  FOREIGN KEY (tenant_id, inventory_item_id) REFERENCES inventory_items(tenant_id, id)
);
CREATE TRIGGER menu_recipes_touch BEFORE UPDATE ON menu_recipes
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_items, menu_recipes TO rms_app;
GRANT SELECT, INSERT ON stock_ledger TO rms_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['inventory_items','stock_ledger','menu_recipes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON stock_ledger FROM rms_app;
