-- P1 M5: immutable tax-inclusive invoices, transactional gapless numbering, and append-only payments.
CREATE UNIQUE INDEX order_items_tenant_id_id ON order_items (tenant_id, id);

CREATE TABLE invoice_counters (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  financial_year text NOT NULL,
  series text NOT NULL,
  last_number bigint NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, outlet_id, financial_year, series),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);
CREATE TRIGGER invoice_counters_touch BEFORE UPDATE ON invoice_counters
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  order_id uuid NOT NULL,
  invoice_number text NOT NULL,
  financial_year text NOT NULL,
  series text NOT NULL,
  tenant_name text NOT NULL,
  outlet_name text NOT NULL,
  outlet_gstin text,
  taxable_amount bigint NOT NULL CHECK (taxable_amount >= 0),
  cgst_amount bigint NOT NULL CHECK (cgst_amount >= 0),
  sgst_amount bigint NOT NULL CHECK (sgst_amount >= 0),
  igst_amount bigint NOT NULL CHECK (igst_amount >= 0),
  total_tax bigint NOT NULL CHECK (total_tax >= 0),
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  finalized_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders(tenant_id, id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, outlet_id, invoice_number),
  UNIQUE (tenant_id, order_id)
);
CREATE INDEX invoices_outlet_date ON invoices (tenant_id, outlet_id, created_at DESC);
CREATE TRIGGER invoices_touch BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  order_item_id uuid NOT NULL,
  item_name text NOT NULL,
  variant_name text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000),
  unit_price bigint NOT NULL CHECK (unit_price >= 0),
  add_ons jsonb NOT NULL DEFAULT '[]',
  tax_code text NOT NULL,
  cgst_rate integer NOT NULL CHECK (cgst_rate BETWEEN 0 AND 10000),
  sgst_rate integer NOT NULL CHECK (sgst_rate BETWEEN 0 AND 10000),
  igst_rate integer NOT NULL CHECK (igst_rate BETWEEN 0 AND 10000),
  taxable_amount bigint NOT NULL CHECK (taxable_amount >= 0),
  cgst_amount bigint NOT NULL CHECK (cgst_amount >= 0),
  sgst_amount bigint NOT NULL CHECK (sgst_amount >= 0),
  igst_amount bigint NOT NULL CHECK (igst_amount >= 0),
  total_tax bigint NOT NULL CHECK (total_tax >= 0),
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, order_item_id) REFERENCES order_items(tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);
CREATE INDEX invoice_lines_invoice ON invoice_lines (tenant_id, invoice_id);

CREATE TABLE invoice_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  method text NOT NULL CHECK (method IN ('CASH', 'CARD', 'UPI', 'OTHER')),
  amount bigint NOT NULL CHECK (amount > 0),
  reference text,
  received_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoices(tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);
CREATE INDEX invoice_payments_invoice ON invoice_payments (tenant_id, invoice_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_counters TO rms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO rms_app;
GRANT SELECT, INSERT ON invoice_lines, invoice_payments TO rms_app;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['invoice_counters','invoices','invoice_lines','invoice_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;

REVOKE UPDATE, DELETE ON invoices, invoice_lines, invoice_payments FROM rms_app;
