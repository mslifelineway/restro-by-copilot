import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const inventoryItems = pgTable('inventory_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  name: text('name').notNull(),
  baseUnit: text('base_unit').notNull(),
  reorderLevelMilli: bigint('reorder_level_milli', { mode: 'bigint' }).notNull().default(0n),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const stockLedger = pgTable('stock_ledger', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  inventoryItemId: uuid('inventory_item_id').notNull(),
  quantityDeltaMilli: bigint('quantity_delta_milli', { mode: 'bigint' }).notNull(),
  reason: text('reason').notNull(),
  reference: text('reference'),
  sourceKey: text('source_key'),
  recordedBy: uuid('recorded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const menuRecipes = pgTable('menu_recipes', {
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  menuItemId: uuid('menu_item_id').notNull(),
  inventoryItemId: uuid('inventory_item_id').notNull(),
  quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});
