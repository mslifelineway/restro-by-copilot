-- P1 M6: outlet-scoped dining tables and floor state.
CREATE TABLE dining_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  section text NOT NULL DEFAULT '',
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  state text NOT NULL DEFAULT 'AVAILABLE'
    CHECK (state IN ('AVAILABLE', 'IN_USE', 'RESERVED', 'UNAVAILABLE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);

CREATE UNIQUE INDEX dining_tables_outlet_code
  ON dining_tables (tenant_id, outlet_id, lower(code)) WHERE deleted_at IS NULL;
CREATE INDEX dining_tables_floor_order
  ON dining_tables (tenant_id, outlet_id, section, sort_order, code) WHERE deleted_at IS NULL;
CREATE TRIGGER dining_tables_touch BEFORE UPDATE ON dining_tables
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON dining_tables TO rms_app;
ALTER TABLE dining_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE dining_tables FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON dining_tables
  USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform());
