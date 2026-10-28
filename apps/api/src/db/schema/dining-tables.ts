import { integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const diningTables = pgTable('dining_tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  mergedOrderId: uuid('merged_order_id'),
  code: text('code').notNull(),
  name: text('name').notNull(),
  section: text('section').notNull().default(''),
  capacity: integer('capacity').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  state: text('state').notNull().default('AVAILABLE'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});
