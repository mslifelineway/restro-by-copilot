CREATE TABLE sync_change_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  last_sequence bigint NOT NULL CHECK (last_sequence >= 0)
);
INSERT INTO sync_change_counters (tenant_id, last_sequence)
SELECT tenant_id, max(sequence) FROM sync_changes GROUP BY tenant_id;
GRANT SELECT, INSERT, UPDATE ON sync_change_counters TO rms_app;
ALTER TABLE sync_change_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_change_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sync_change_counters
  USING (tenant_id = app_tenant_id() OR app_is_platform())
  WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform());

ALTER TABLE sync_changes DROP CONSTRAINT sync_changes_pkey;
ALTER TABLE sync_changes ADD PRIMARY KEY (tenant_id, sequence);
ALTER TABLE sync_changes ALTER COLUMN sequence DROP DEFAULT;
REVOKE USAGE, SELECT ON SEQUENCE sync_changes_sequence_seq FROM rms_app;

CREATE OR REPLACE FUNCTION record_sync_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb;
  row_tenant uuid;
  row_outlet uuid;
  row_id uuid;
  next_sequence bigint;
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

  INSERT INTO sync_change_counters (tenant_id, last_sequence)
  VALUES (row_tenant, 1)
  ON CONFLICT (tenant_id) DO UPDATE
    SET last_sequence = sync_change_counters.last_sequence + 1
  RETURNING last_sequence INTO next_sequence;

  INSERT INTO sync_changes (sequence, tenant_id, outlet_id, entity_type, entity_id, payload)
  VALUES (next_sequence, row_tenant, row_outlet, TG_TABLE_NAME, row_id, row_data);
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
