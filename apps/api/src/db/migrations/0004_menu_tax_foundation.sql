-- P1 M4 foundation: tenant tax slabs and outlet-scoped menu categories.
CREATE OR REPLACE FUNCTION app_outlet_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.outlet_id', true), '')::uuid $$;

ALTER TABLE outlets ADD CONSTRAINT outlets_tenant_id_id_unique UNIQUE (tenant_id, id);

CREATE TABLE tax_slabs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  code text NOT NULL,
  cgst_rate integer NOT NULL CHECK (cgst_rate BETWEEN 0 AND 10000),
  sgst_rate integer NOT NULL CHECK (sgst_rate BETWEEN 0 AND 10000),
  igst_rate integer NOT NULL CHECK (igst_rate BETWEEN 0 AND 10000),
  effective_from timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK (cgst_rate + sgst_rate = igst_rate)
);
CREATE UNIQUE INDEX tax_slabs_tenant_code ON tax_slabs (tenant_id, lower(code)) WHERE deleted_at IS NULL;
CREATE TRIGGER tax_slabs_touch BEFORE UPDATE ON tax_slabs FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);
CREATE UNIQUE INDEX categories_outlet_name ON categories (tenant_id, outlet_id, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX categories_outlet_order ON categories (tenant_id, outlet_id, sort_order, name) WHERE deleted_at IS NULL;
CREATE TRIGGER categories_touch BEFORE UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON tax_slabs, categories TO rms_app;

ALTER TABLE tax_slabs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_slabs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tax_slabs
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON categories
  USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform());
