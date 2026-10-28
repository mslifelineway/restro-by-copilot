ALTER TABLE invoices
  ADD COLUMN discount_type text CHECK (discount_type IN ('PERCENTAGE', 'FIXED')),
  ADD COLUMN discount_value bigint NOT NULL DEFAULT 0 CHECK (discount_value >= 0),
  ADD COLUMN discount_amount bigint NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  ADD COLUMN service_charge_amount bigint NOT NULL DEFAULT 0 CHECK (service_charge_amount >= 0),
  ADD COLUMN service_charge_taxable_amount bigint NOT NULL DEFAULT 0 CHECK (service_charge_taxable_amount >= 0),
  ADD COLUMN service_charge_tax bigint NOT NULL DEFAULT 0 CHECK (service_charge_tax >= 0),
  ADD COLUMN service_charge_tax_code text,
  ADD COLUMN tip_amount bigint NOT NULL DEFAULT 0 CHECK (tip_amount >= 0),
  ADD COLUMN round_off_amount bigint NOT NULL DEFAULT 0 CHECK (round_off_amount BETWEEN -49 AND 50);

ALTER TABLE invoice_lines
  ADD COLUMN discount_amount bigint NOT NULL DEFAULT 0 CHECK (discount_amount >= 0);

CREATE TABLE outlet_billing_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  service_charge_mode text NOT NULL DEFAULT 'NONE'
    CHECK (service_charge_mode IN ('NONE', 'FIXED', 'PERCENTAGE')),
  service_charge_value bigint NOT NULL DEFAULT 0 CHECK (service_charge_value >= 0),
  service_charge_tax_slab_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, service_charge_tax_slab_id) REFERENCES tax_slabs(tenant_id, id),
  UNIQUE (tenant_id, outlet_id),
  CHECK (
    (service_charge_mode = 'NONE' AND service_charge_value = 0 AND service_charge_tax_slab_id IS NULL)
    OR (service_charge_mode = 'FIXED' AND service_charge_value > 0)
    OR (service_charge_mode = 'PERCENTAGE' AND service_charge_value BETWEEN 1 AND 10000)
  )
);
CREATE TRIGGER outlet_billing_settings_touch BEFORE UPDATE ON outlet_billing_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON outlet_billing_settings TO rms_app;
ALTER TABLE outlet_billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlet_billing_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON outlet_billing_settings
  USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform());
