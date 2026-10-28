ALTER TABLE invoices
  ADD COLUMN service_charge_cgst_rate integer NOT NULL DEFAULT 0 CHECK (service_charge_cgst_rate BETWEEN 0 AND 10000),
  ADD COLUMN service_charge_sgst_rate integer NOT NULL DEFAULT 0 CHECK (service_charge_sgst_rate BETWEEN 0 AND 10000),
  ADD COLUMN service_charge_igst_rate integer NOT NULL DEFAULT 0 CHECK (service_charge_igst_rate BETWEEN 0 AND 10000),
  ADD COLUMN service_charge_cgst_amount bigint NOT NULL DEFAULT 0 CHECK (service_charge_cgst_amount >= 0),
  ADD COLUMN service_charge_sgst_amount bigint NOT NULL DEFAULT 0 CHECK (service_charge_sgst_amount >= 0),
  ADD COLUMN service_charge_igst_amount bigint NOT NULL DEFAULT 0 CHECK (service_charge_igst_amount >= 0);
