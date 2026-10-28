CREATE TABLE cashier_shift_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  shift_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount bigint NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shifts(tenant_id, id)
);
CREATE INDEX cashier_shift_adjustments_shift ON cashier_shift_adjustments (tenant_id, shift_id, created_at);

GRANT SELECT, INSERT ON cashier_shift_adjustments TO rms_app;
ALTER TABLE cashier_shift_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashier_shift_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON cashier_shift_adjustments
  USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform());
