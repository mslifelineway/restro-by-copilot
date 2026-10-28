import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export type KotPrintPayload = {
  ticketNumber: string;
  orderId: string;
  orderType: string;
  tableName: string | null;
  createdAt: string;
  items: Array<{
    itemName: string;
    variantName: string;
    quantity: number;
    notes: string;
    addOns: Array<{ name: string; price: string }>;
  }>;
};

export const printerStations = pgTable('printer_stations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});

export const printJobs = pgTable('print_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  outletId: uuid('outlet_id').notNull(),
  kotTicketId: uuid('kot_ticket_id').notNull(),
  printerStationId: uuid('printer_station_id').notNull(),
  payload: jsonb('payload').$type<KotPrintPayload>().notNull(),
  status: text('status').notNull().default('QUEUED'),
  claimedBy: uuid('claimed_by'),
  leaseUntil: timestamp('lease_until', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  printedAt: timestamp('printed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
});
