import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';

@Injectable()
export class ReportsService {
  constructor(private db: DbService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to view sales reports');
    return ctx.outletId;
  }

  async dailySales(ctx: RequestCtx, requestedDate?: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const outlet = await c.query(
        `SELECT COALESCE(o.timezone, t.timezone) AS timezone
           FROM outlets o JOIN tenants t ON t.id = o.tenant_id
          WHERE o.id = $1 AND o.deleted_at IS NULL LIMIT 1`,
        [outletId],
      );
      if (!outlet.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
      const timezone = outlet.rows[0].timezone as string;
      const date = requestedDate ?? new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date());
      const parsed = new Date(`${date}T00:00:00.000Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_REPORT_DATE', 'Report date must be a valid calendar date in YYYY-MM-DD format');
      }
      const range = `created_at >= ($2::date::timestamp AT TIME ZONE $3)
                     AND created_at < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)`;
      const totals = await c.query(
        `SELECT count(*)::int AS "invoiceCount",
                COALESCE(sum(total_amount), 0)::text AS "grossSalesPaise",
                COALESCE(sum(total_tax), 0)::text AS "taxPaise",
                COALESCE(sum(discount_amount), 0)::text AS "discountPaise",
                COALESCE(sum(service_charge_amount), 0)::text AS "serviceChargePaise",
                COALESCE(sum(tip_amount), 0)::text AS "tipPaise",
                COALESCE(sum(round_off_amount), 0)::text AS "roundOffPaise"
           FROM invoices
          WHERE outlet_id = $1 AND deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.invoice_id = invoices.id)
            AND ${range}`,
        [outletId, date, timezone],
      );
      const items = await c.query(
        `SELECT l.item_name AS "itemName", COALESCE(cat.name, 'Deleted category') AS "categoryName",
                sum(l.quantity)::int AS quantity, sum(l.total_amount)::text AS "salesPaise"
           FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
           JOIN order_items oi ON oi.id = l.order_item_id
           LEFT JOIN categories cat ON cat.id = oi.category_id
          WHERE i.outlet_id = $1 AND i.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.invoice_id = i.id)
            AND i.created_at >= ($2::date::timestamp AT TIME ZONE $3)
            AND i.created_at < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
          GROUP BY l.item_name, cat.name ORDER BY sum(l.total_amount) DESC, l.item_name`,
        [outletId, date, timezone],
      );
      const tax = await c.query(
        `SELECT "taxCode", "cgstRate", "sgstRate", "igstRate",
                sum("taxablePaise")::text AS "taxablePaise", sum("cgstPaise")::text AS "cgstPaise",
                sum("sgstPaise")::text AS "sgstPaise", sum("igstPaise")::text AS "igstPaise",
                sum("taxPaise")::text AS "taxPaise"
           FROM (
             SELECT l.tax_code AS "taxCode", l.cgst_rate AS "cgstRate", l.sgst_rate AS "sgstRate",
                    l.igst_rate AS "igstRate", l.taxable_amount AS "taxablePaise",
                    l.cgst_amount AS "cgstPaise", l.sgst_amount AS "sgstPaise",
                    l.igst_amount AS "igstPaise", l.total_tax AS "taxPaise"
               FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
              WHERE i.outlet_id = $1 AND i.deleted_at IS NULL
                AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.invoice_id = i.id)
                AND i.created_at >= ($2::date::timestamp AT TIME ZONE $3)
                AND i.created_at < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
             UNION ALL
             SELECT i.service_charge_tax_code, i.service_charge_cgst_rate, i.service_charge_sgst_rate,
                    i.service_charge_igst_rate, i.service_charge_taxable_amount,
                    i.service_charge_cgst_amount, i.service_charge_sgst_amount,
                    i.service_charge_igst_amount, i.service_charge_tax
               FROM invoices i
              WHERE i.outlet_id = $1 AND i.deleted_at IS NULL AND i.service_charge_tax_code IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM invoice_voids v WHERE v.invoice_id = i.id)
                AND i.created_at >= ($2::date::timestamp AT TIME ZONE $3)
                AND i.created_at < (($2::date + INTERVAL '1 day')::timestamp AT TIME ZONE $3)
           ) tax_rows
          GROUP BY "taxCode", "cgstRate", "sgstRate", "igstRate"
          ORDER BY "taxCode", "cgstRate", "sgstRate", "igstRate"`,
        [outletId, date, timezone],
      );
      const payments = await c.query(
        `SELECT movement.method, sum(movement.amount)::text AS "netPaise"
           FROM (
             SELECT method, amount FROM invoice_payments
              WHERE outlet_id = $1 AND ${range}
             UNION ALL
             SELECT method, -amount FROM invoice_refunds
              WHERE outlet_id = $1 AND ${range}
           ) movement
          GROUP BY movement.method ORDER BY movement.method`,
        [outletId, date, timezone],
      );
      const cashiers = await c.query(
        `SELECT movement.user_id AS "userId", u.name AS "cashierName",
                sum(movement.amount)::text AS "netSalesPaise"
           FROM (
             SELECT received_by AS user_id, amount FROM invoice_payments
              WHERE outlet_id = $1 AND ${range}
             UNION ALL
             SELECT refunded_by AS user_id, -amount FROM invoice_refunds
              WHERE outlet_id = $1 AND ${range}
           ) movement
           JOIN users u ON u.id = movement.user_id
          GROUP BY movement.user_id, u.name ORDER BY sum(movement.amount) DESC, u.name`,
        [outletId, date, timezone],
      );
      return {
        date,
        timezone,
        totals: totals.rows[0],
        items: items.rows,
        tax: tax.rows,
        payments: payments.rows,
        cashiers: cashiers.rows,
      };
    });
  }
}
