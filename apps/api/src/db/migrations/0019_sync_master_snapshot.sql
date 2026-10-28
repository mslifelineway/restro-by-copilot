CREATE TEMP TABLE sync_initial_changes ON COMMIT DROP AS
SELECT tenant_id, NULL::uuid AS outlet_id, 'tax_slabs'::text AS entity_type, id AS entity_id, to_jsonb(tax_slabs) AS payload FROM tax_slabs
UNION ALL
SELECT tenant_id, outlet_id, 'categories', id, to_jsonb(categories) FROM categories
UNION ALL
SELECT m.tenant_id, c.outlet_id, 'menu_items', m.id, to_jsonb(m) FROM menu_items m JOIN categories c ON c.id = m.category_id
UNION ALL
SELECT v.tenant_id, c.outlet_id, 'variants', v.id, to_jsonb(v)
  FROM variants v JOIN menu_items m ON m.id = v.menu_item_id JOIN categories c ON c.id = m.category_id
UNION ALL
SELECT tenant_id, NULL::uuid, 'add_on_groups', id, to_jsonb(add_on_groups) FROM add_on_groups
UNION ALL
SELECT tenant_id, NULL::uuid, 'add_ons', id, to_jsonb(add_ons) FROM add_ons
UNION ALL
SELECT g.tenant_id, c.outlet_id, 'item_add_on_groups', g.add_on_group_id, to_jsonb(g)
  FROM item_add_on_groups g JOIN menu_items m ON m.id = g.menu_item_id JOIN categories c ON c.id = m.category_id
UNION ALL
SELECT tenant_id, outlet_id, 'outlet_variant_prices', id, to_jsonb(outlet_variant_prices) FROM outlet_variant_prices
UNION ALL
SELECT tenant_id, outlet_id, 'channel_variant_prices', id, to_jsonb(channel_variant_prices) FROM channel_variant_prices
UNION ALL
SELECT tenant_id, outlet_id, 'dining_tables', id, to_jsonb(dining_tables) FROM dining_tables
UNION ALL
SELECT tenant_id, outlet_id, 'inventory_items', id, to_jsonb(inventory_items) FROM inventory_items
UNION ALL
SELECT r.tenant_id, c.outlet_id, 'menu_recipes', r.inventory_item_id, to_jsonb(r)
  FROM menu_recipes r JOIN menu_items m ON m.id = r.menu_item_id JOIN categories c ON c.id = m.category_id;

INSERT INTO sync_change_counters (tenant_id, last_sequence)
SELECT DISTINCT tenant_id, 0 FROM sync_initial_changes
ON CONFLICT (tenant_id) DO NOTHING;

WITH numbered AS (
  SELECT r.*, c.last_sequence + row_number() OVER (
    PARTITION BY r.tenant_id ORDER BY r.entity_type, r.entity_id, r.outlet_id NULLS FIRST
  ) AS next_sequence
  FROM sync_initial_changes r JOIN sync_change_counters c USING (tenant_id)
)
INSERT INTO sync_changes (sequence, tenant_id, outlet_id, entity_type, entity_id, payload)
SELECT next_sequence, tenant_id, outlet_id, entity_type, entity_id, payload FROM numbered;

UPDATE sync_change_counters c
   SET last_sequence = c.last_sequence + totals.count
  FROM (SELECT tenant_id, count(*)::bigint AS count FROM sync_initial_changes GROUP BY tenant_id) totals
 WHERE c.tenant_id = totals.tenant_id;
