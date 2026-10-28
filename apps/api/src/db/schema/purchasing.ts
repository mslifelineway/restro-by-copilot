import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const suppliers = pgTable('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const purchaseOrders = pgTable('purchase_orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  supplierId: uuid('supplier_id').notNull(),
  status: text('status').notNull().default('ORDERED'),
  notes: text('notes').notNull().default(''),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const purchaseOrderLines = pgTable('purchase_order_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  purchaseOrderId: uuid('purchase_order_id').notNull(),
  inventoryItemId: uuid('inventory_item_id').notNull(),
  orderedQuantityMilli: bigint('ordered_quantity_milli', { mode: 'bigint' }).notNull(),
  receivedQuantityMilli: bigint('received_quantity_milli', { mode: 'bigint' }).notNull().default(0n),
  unitCostPaise: bigint('unit_cost_paise', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseReceipts = pgTable('purchase_receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  purchaseOrderId: uuid('purchase_order_id').notNull(),
  receivedBy: uuid('received_by').notNull(),
  reference: text('reference'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export const purchaseReceiptLines = pgTable('purchase_receipt_lines', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  receiptId: uuid('receipt_id').notNull(),
  purchaseOrderLineId: uuid('purchase_order_line_id').notNull(),
  inventoryItemId: uuid('inventory_item_id').notNull(),
  quantityMilli: bigint('quantity_milli', { mode: 'bigint' }).notNull(),
  unitCostPaise: bigint('unit_cost_paise', { mode: 'bigint' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
