import { bigint, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const cashierShifts = pgTable('cashier_shifts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  userId: uuid('user_id').notNull(),
  status: text('status').notNull().default('OPEN'),
  openingCash: bigint('opening_cash', { mode: 'bigint' }).notNull(),
  expectedCash: bigint('expected_cash', { mode: 'bigint' }),
  countedCash: bigint('counted_cash', { mode: 'bigint' }),
  variance: bigint('variance', { mode: 'bigint' }),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const cashierShiftAdjustments = pgTable('cashier_shift_adjustments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  shiftId: uuid('shift_id').notNull(),
  direction: text('direction').notNull(),
  amount: bigint('amount', { mode: 'bigint' }).notNull(),
  reason: text('reason').notNull(),
  recordedBy: uuid('recorded_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
