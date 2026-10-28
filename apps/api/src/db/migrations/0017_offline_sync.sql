CREATE TABLE sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  device_id uuid NOT NULL REFERENCES devices(id),
  device_seq bigint NOT NULL CHECK (device_seq > 0),
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  clock_skew_seconds integer NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'RESOLVED', 'REJECTED')),
  resolution_note text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  UNIQUE (tenant_id, device_id, device_seq),
  UNIQUE (tenant_id, device_id, event_id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id)
);
CREATE INDEX sync_events_inbox ON sync_events (tenant_id, outlet_id, status, received_at DESC);
GRANT SELECT, INSERT, UPDATE ON sync_events TO rms_app;
ALTER TABLE sync_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_events FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON sync_events
  USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
  WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform());

CREATE TABLE sync_changes (
  sequence bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_changes_outlet_cursor ON sync_changes (tenant_id, outlet_id, sequence);
GRANT SELECT, INSERT ON sync_changes TO rms_app;
GRANT USAGE, SELECT ON SEQUENCE sync_changes_sequence_seq TO rms_app;
ALTER TABLE sync_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON sync_changes
  USING (tenant_id = app_tenant_id() AND (outlet_id IS NULL OR outlet_id = app_outlet_id()))
  WITH CHECK (tenant_id = app_tenant_id() AND (outlet_id IS NULL OR outlet_id = app_outlet_id()));

CREATE FUNCTION record_sync_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  row_tenant uuid;
  row_outlet uuid;
  row_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_data := to_jsonb(OLD);
    row_data := jsonb_set(row_data, '{deleted_at}', to_jsonb(clock_timestamp()), true);
  ELSE
    row_data := to_jsonb(NEW);
  END IF;
  row_tenant := (row_data->>'tenant_id')::uuid;
  row_outlet := NULLIF(row_data->>'outlet_id', '')::uuid;
  row_id := COALESCE(
    NULLIF(row_data->>'id', '')::uuid,
    NULLIF(row_data->>'menu_item_id', '')::uuid,
    NULLIF(row_data->>'category_id', '')::uuid
  );

  IF TG_TABLE_NAME = 'menu_items' THEN
    SELECT outlet_id INTO row_outlet FROM categories WHERE id = (row_data->>'category_id')::uuid;
  ELSIF TG_TABLE_NAME = 'variants' THEN
    SELECT c.outlet_id INTO row_outlet FROM menu_items m JOIN categories c ON c.id = m.category_id
     WHERE m.id = (row_data->>'menu_item_id')::uuid;
  ELSIF TG_TABLE_NAME = 'item_add_on_groups' THEN
    SELECT c.outlet_id INTO row_outlet FROM menu_items m JOIN categories c ON c.id = m.category_id
     WHERE m.id = (row_data->>'menu_item_id')::uuid;
  ELSIF TG_TABLE_NAME = 'menu_recipes' THEN
    SELECT c.outlet_id INTO row_outlet FROM menu_items m JOIN categories c ON c.id = m.category_id
     WHERE m.id = (row_data->>'menu_item_id')::uuid;
  END IF;

  INSERT INTO sync_changes (tenant_id, outlet_id, entity_type, entity_id, payload)
  VALUES (row_tenant, row_outlet, TG_TABLE_NAME, row_id, row_data);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'tax_slabs','categories','menu_items','variants','add_on_groups','add_ons',
    'item_add_on_groups','outlet_variant_prices','channel_variant_prices',
    'dining_tables','inventory_items','menu_recipes'
  ] LOOP
    EXECUTE format('CREATE TRIGGER sync_change_capture AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION record_sync_change()', t);
  END LOOP;
END $$;
