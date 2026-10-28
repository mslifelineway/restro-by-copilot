-- P1 M7: outlet printer stations, category routing, and durable client-dispatched print jobs.
CREATE UNIQUE INDEX categories_tenant_outlet_id_id ON categories (tenant_id, outlet_id, id);
ALTER TABLE order_items ADD COLUMN category_id uuid;
UPDATE order_items oi
   SET category_id = m.category_id
  FROM menu_items m
 WHERE m.id = oi.menu_item_id;
ALTER TABLE order_items ALTER COLUMN category_id SET NOT NULL;
ALTER TABLE order_items ADD CONSTRAINT order_items_category_fk
  FOREIGN KEY (tenant_id, outlet_id, category_id) REFERENCES categories(tenant_id, outlet_id, id);

CREATE TABLE printer_stations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  UNIQUE (tenant_id, outlet_id, id)
);
CREATE UNIQUE INDEX printer_stations_outlet_code
  ON printer_stations (tenant_id, outlet_id, lower(code)) WHERE deleted_at IS NULL;
CREATE TRIGGER printer_stations_touch BEFORE UPDATE ON printer_stations
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE printer_station_categories (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  printer_station_id uuid NOT NULL,
  category_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (printer_station_id, category_id),
  UNIQUE (tenant_id, outlet_id, category_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, printer_station_id) REFERENCES printer_stations(tenant_id, outlet_id, id),
  FOREIGN KEY (tenant_id, outlet_id, category_id) REFERENCES categories(tenant_id, outlet_id, id)
);

CREATE TABLE print_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  kot_ticket_id uuid NOT NULL,
  printer_station_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'CLAIMED', 'PRINTED', 'FAILED')),
  claimed_by uuid REFERENCES users(id),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  printed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, kot_ticket_id) REFERENCES kot_tickets(tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id, printer_station_id) REFERENCES printer_stations(tenant_id, outlet_id, id),
  UNIQUE (tenant_id, kot_ticket_id, printer_station_id)
);
CREATE INDEX print_jobs_claimable ON print_jobs (tenant_id, outlet_id, printer_station_id, created_at)
  WHERE status IN ('QUEUED', 'CLAIMED') AND deleted_at IS NULL;
CREATE TRIGGER print_jobs_touch BEFORE UPDATE ON print_jobs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON printer_stations, printer_station_categories, print_jobs TO rms_app;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['printer_stations','printer_station_categories','print_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;
