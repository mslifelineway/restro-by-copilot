-- P1 M4: tenant menu catalog, modifier groups, and outlet price overrides.
CREATE UNIQUE INDEX categories_tenant_id_id ON categories (tenant_id, id);
CREATE UNIQUE INDEX tax_slabs_tenant_id_id ON tax_slabs (tenant_id, id);

CREATE TABLE menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  category_id uuid NOT NULL,
  tax_slab_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  dietary_type text NOT NULL CHECK (dietary_type IN ('VEG','NON_VEG','EGG')),
  is_available boolean NOT NULL DEFAULT true,
  sku text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, category_id) REFERENCES categories(tenant_id, id),
  FOREIGN KEY (tenant_id, tax_slab_id) REFERENCES tax_slabs(tenant_id, id)
);
CREATE UNIQUE INDEX menu_items_tenant_sku ON menu_items(tenant_id, lower(sku)) WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX menu_items_tenant_category ON menu_items(tenant_id, category_id, name) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX menu_items_tenant_id_id ON menu_items(tenant_id, id);
CREATE TRIGGER menu_items_touch BEFORE UPDATE ON menu_items FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  menu_item_id uuid NOT NULL,
  name text NOT NULL,
  base_price bigint NOT NULL CHECK (base_price >= 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items(tenant_id, id)
);
CREATE UNIQUE INDEX variants_item_name ON variants(tenant_id, menu_item_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX variants_one_default ON variants(tenant_id, menu_item_id) WHERE is_default AND deleted_at IS NULL;
CREATE UNIQUE INDEX variants_tenant_id_id ON variants(tenant_id, id);
CREATE TRIGGER variants_touch BEFORE UPDATE ON variants FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE add_on_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  name text NOT NULL,
  min_selection integer NOT NULL DEFAULT 0 CHECK (min_selection >= 0),
  max_selection integer NOT NULL CHECK (max_selection > 0),
  is_mandatory boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  CHECK (min_selection <= max_selection),
  CHECK (is_mandatory = (min_selection > 0))
);
CREATE UNIQUE INDEX add_on_groups_tenant_name ON add_on_groups(tenant_id, lower(name)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX add_on_groups_tenant_id_id ON add_on_groups(tenant_id, id);
CREATE TRIGGER add_on_groups_touch BEFORE UPDATE ON add_on_groups FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE add_ons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  add_on_group_id uuid NOT NULL,
  name text NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  FOREIGN KEY (tenant_id, add_on_group_id) REFERENCES add_on_groups(tenant_id, id)
);
CREATE UNIQUE INDEX add_ons_group_name ON add_ons(tenant_id, add_on_group_id, lower(name)) WHERE deleted_at IS NULL;
CREATE TRIGGER add_ons_touch BEFORE UPDATE ON add_ons FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE item_add_on_groups (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  menu_item_id uuid NOT NULL,
  add_on_group_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (menu_item_id, add_on_group_id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_items(tenant_id, id),
  FOREIGN KEY (tenant_id, add_on_group_id) REFERENCES add_on_groups(tenant_id, id)
);

CREATE TABLE outlet_variant_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  price bigint NOT NULL CHECK (price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants(tenant_id, id),
  UNIQUE (outlet_id, variant_id)
);
CREATE TRIGGER outlet_variant_prices_touch BEFORE UPDATE ON outlet_variant_prices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE channel_variant_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  outlet_id uuid NOT NULL,
  variant_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('DINE_IN','TAKEAWAY','DELIVERY')),
  price bigint NOT NULL CHECK (price >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlets(tenant_id, id),
  FOREIGN KEY (tenant_id, variant_id) REFERENCES variants(tenant_id, id),
  UNIQUE (outlet_id, variant_id, channel)
);
CREATE TRIGGER channel_variant_prices_touch BEFORE UPDATE ON channel_variant_prices FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON menu_items, variants, add_on_groups, add_ons,
  item_add_on_groups, outlet_variant_prices, channel_variant_prices TO rms_app;

ALTER TABLE menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE menu_items FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON menu_items
  USING (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM categories c
       WHERE c.tenant_id = menu_items.tenant_id
         AND c.id = menu_items.category_id
         AND c.outlet_id = app_outlet_id()
    )) OR app_is_platform()
  )
  WITH CHECK (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM categories c
       WHERE c.tenant_id = menu_items.tenant_id
         AND c.id = menu_items.category_id
         AND c.outlet_id = app_outlet_id()
    )) OR app_is_platform()
  );

ALTER TABLE variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE variants FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON variants
  USING (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM menu_items m
       WHERE m.tenant_id = variants.tenant_id
         AND m.id = variants.menu_item_id
         AND m.deleted_at IS NULL
    )) OR app_is_platform()
  )
  WITH CHECK (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM menu_items m
       WHERE m.tenant_id = variants.tenant_id
         AND m.id = variants.menu_item_id
         AND m.deleted_at IS NULL
    )) OR app_is_platform()
  );

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['add_on_groups','add_ons'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (tenant_id = app_tenant_id() OR app_is_platform())
      WITH CHECK (tenant_id = app_tenant_id() OR app_is_platform())$p$, t);
  END LOOP;
END $$;

ALTER TABLE item_add_on_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE item_add_on_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY outlet_isolation ON item_add_on_groups
  USING (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM menu_items m
       WHERE m.tenant_id = item_add_on_groups.tenant_id
         AND m.id = item_add_on_groups.menu_item_id
    )) OR app_is_platform()
  )
  WITH CHECK (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM menu_items m
       WHERE m.tenant_id = item_add_on_groups.tenant_id
         AND m.id = item_add_on_groups.menu_item_id
    )) OR app_is_platform()
  );

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['outlet_variant_prices','channel_variant_prices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY outlet_isolation ON %I
      USING ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())
      WITH CHECK ((tenant_id = app_tenant_id() AND outlet_id = app_outlet_id()) OR app_is_platform())$p$, t);
  END LOOP;
END $$;
