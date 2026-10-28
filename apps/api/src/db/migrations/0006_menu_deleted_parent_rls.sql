-- Keep dependent menu rows hidden when their category or parent item is soft-deleted.
DROP POLICY outlet_isolation ON menu_items;
CREATE POLICY outlet_isolation ON menu_items
  USING (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM categories c
       WHERE c.tenant_id = menu_items.tenant_id
         AND c.id = menu_items.category_id
         AND c.outlet_id = app_outlet_id()
         AND c.deleted_at IS NULL
    )) OR app_is_platform()
  )
  WITH CHECK (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM categories c
       WHERE c.tenant_id = menu_items.tenant_id
         AND c.id = menu_items.category_id
         AND c.outlet_id = app_outlet_id()
         AND c.deleted_at IS NULL
    )) OR app_is_platform()
  );

DROP POLICY outlet_isolation ON item_add_on_groups;
CREATE POLICY outlet_isolation ON item_add_on_groups
  USING (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM menu_items m
       WHERE m.tenant_id = item_add_on_groups.tenant_id
         AND m.id = item_add_on_groups.menu_item_id
         AND m.deleted_at IS NULL
    )) OR app_is_platform()
  )
  WITH CHECK (
    (tenant_id = app_tenant_id() AND EXISTS (
      SELECT 1 FROM menu_items m
       WHERE m.tenant_id = item_add_on_groups.tenant_id
         AND m.id = item_add_on_groups.menu_item_id
         AND m.deleted_at IS NULL
    )) OR app_is_platform()
  );
