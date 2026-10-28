-- P1 M16: cashier shift cash accountability and payment-to-shift attribution.
CREATE UNIQUE INDEX users_tenant_id_id ON users (tenant_id, id);

CREATE TABLE cashier_shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  opening_cash bigint NOT NULL CHECK (opening_cash >= 0),
  expected_cash bigint,
  counted_cash bigint,
  variance bigint,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  CHECK (
    (status = 'OPEN' AND closed_at IS NULL AND expected_cash IS NULL AND counted_cash IS NULL AND variance IS NULL)
    OR
    (status = 'CLOSED' AND closed_at IS NOT NULL AND expected_cash IS NOT NULL AND counted_cash IS NOT NULL AND variance IS NOT NULL)
  ),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX cashier_shifts_one_open
  ON cashier_shifts (tenant_id, outlet_id, user_id) WHERE status = 'OPEN' AND deleted_at IS NULL;
CREATE INDEX cashier_shifts_outlet_opened
  ON cashier_shifts (tenant_id, outlet_id, opened_at DESC);
CREATE TRIGGER cashier_shifts_touch BEFORE UPDATE ON cashier_shifts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

ALTER TABLE invoice_payments ADD COLUMN shift_id uuid;
ALTER TABLE invoice_payments ADD CONSTRAINT invoice_payments_shift_fk
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shifts(tenant_id, id);
CREATE INDEX invoice_payments_shift ON invoice_payments (tenant_id, shift_id, created_at) WHERE shift_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON cashier_shifts TO rms_app;
ALTER TABLE cashier_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cashier_shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON cashier_shifts
  USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform());
