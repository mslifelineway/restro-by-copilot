-- Invoice corrections are represented by append-only compensating records.
CREATE UNIQUE INDEX invoice_payments_tenant_id_id ON invoice_payments (tenant_id, id);

CREATE TABLE invoice_voids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  reason text NOT NULL,
  voided_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  UNIQUE (tenant_id, invoice_id)
);

CREATE TABLE invoice_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  shift_id uuid,
  method text NOT NULL CHECK (method IN ('CASH', 'CARD', 'UPI', 'OTHER')),
  amount bigint NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  reference text,
  refunded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES invoice_payments(tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id) REFERENCES cashier_shifts(tenant_id, id)
);
CREATE INDEX invoice_refunds_invoice ON invoice_refunds (tenant_id, invoice_id, created_at);
CREATE INDEX invoice_refunds_payment ON invoice_refunds (tenant_id, payment_id, created_at);
CREATE INDEX invoice_refunds_shift ON invoice_refunds (tenant_id, shift_id, created_at) WHERE shift_id IS NOT NULL;

GRANT SELECT, INSERT ON invoice_voids, invoice_refunds TO rms_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_voids','invoice_refunds'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;
