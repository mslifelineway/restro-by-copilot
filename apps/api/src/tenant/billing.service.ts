import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { PermissionService } from '../auth/permission.service';
import { DbService } from '../db/db.service';
import { invoices, invoiceLines, invoicePayments, invoiceRefunds, invoiceVoids } from '../db/schema/billing';
import { diningTables } from '../db/schema/dining-tables';
import { orders, orderItems } from '../db/schema/orders';

const MAX_BIGINT = 9223372036854775807n;
type PaymentMethod = 'CASH' | 'CARD' | 'UPI' | 'OTHER';
type TaxMode = 'INTRA_STATE' | 'INTER_STATE';
type DiscountInput = { type: 'PERCENTAGE' | 'FIXED'; value: string };
type CheckAdjustment = { discount?: DiscountInput; tipAmount?: string };
type SplitCheck = CheckAdjustment & { items: Array<{ orderItemId: string; quantity: number }> };
type BillingSettingsInput = {
  serviceChargeMode: 'NONE' | 'FIXED' | 'PERCENTAGE';
  serviceChargeValue: string;
  serviceChargeTaxCode?: string | null;
};

type OrderLine = {
  id: string;
  orderId: string;
  itemName: string;
  variantName: string;
  quantity: number;
  unitPrice: string;
  addOns: Array<{ id: string; name: string; price: string }>;
  taxCode: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  status: string;
};

function roundDivide(numerator: bigint, denominator: bigint) {
  return (numerator + denominator / 2n) / denominator;
}

function parsePercentage(value: string) {
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_PERCENTAGE', 'Enter a percentage with up to two decimal places');
  const basisPoints = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  if (basisPoints < 1n || basisPoints > 10000n) {
    throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_PERCENTAGE', 'Percentage must be greater than zero and no more than 100');
  }
  return basisPoints;
}

function parsePaise(value: string, field: string, allowZero = true) {
  if (!/^(0|[1-9]\d{0,18})$/.test(value) || (!allowZero && value === '0')) {
    throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_MONEY_AMOUNT', `${field} must be a whole amount in paise`);
  }
  const amount = BigInt(value);
  if (amount > MAX_BIGINT) {
    throw new AppException(HttpStatus.BAD_REQUEST, 'INVOICE_AMOUNT_TOO_LARGE', `${field} exceeds the supported integer amount range`);
  }
  return amount;
}

function allocateProportionally(amount: bigint, weights: bigint[]) {
  if (!weights.length) return [];
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const effectiveWeights = totalWeight === 0n ? weights.map(() => 1n) : weights;
  const denominator = effectiveWeights.reduce((sum, weight) => sum + weight, 0n);
  const shares = effectiveWeights.map((weight, index) => {
    const numerator = amount * weight;
    return { index, amount: numerator / denominator, remainder: numerator % denominator };
  });
  let remainder = amount - shares.reduce((sum, share) => sum + share.amount, 0n);
  const order = [...shares].sort((a, b) => a.remainder === b.remainder
    ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; remainder > 0n; index += 1, remainder -= 1n) {
    order[index].amount += 1n;
  }
  return shares.sort((a, b) => a.index - b.index).map((share) => share.amount);
}

function nearestRupee(amount: bigint) {
  const remainder = amount % 100n;
  const adjustment = remainder >= 50n ? 100n - remainder : -remainder;
  return { amount: amount + adjustment, adjustment };
}

function percentageText(basisPoints: bigint) {
  return `${basisPoints / 100n}.${String(basisPoints % 100n).padStart(2, '0')}`;
}

function financialYear(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const start = month >= 4 ? year : year - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

@Injectable()
export class BillingService {
  constructor(private db: DbService, private audit: AuditService, private permissions: PermissionService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage billing');
    return ctx.outletId;
  }

  async getSettings(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT service_charge_mode AS "serviceChargeMode",
                service_charge_value::text AS "serviceChargeStoredValue",
                ts.code AS "serviceChargeTaxCode"
           FROM outlet_billing_settings s
           LEFT JOIN tax_slabs ts ON ts.tenant_id = s.tenant_id AND ts.id = s.service_charge_tax_slab_id
          WHERE s.tenant_id = $1 AND s.outlet_id = $2 AND s.deleted_at IS NULL`,
        [ctx.tenantId, outletId],
      );
      const taxSlabs = await c.query(
        `SELECT code, cgst_rate AS "cgstRate", sgst_rate AS "sgstRate", igst_rate AS "igstRate"
           FROM tax_slabs
          WHERE tenant_id = $1 AND deleted_at IS NULL
          ORDER BY code`,
        [ctx.tenantId],
      );
      const setting = rows[0] ?? {
        serviceChargeMode: 'NONE', serviceChargeStoredValue: '0', serviceChargeTaxCode: null,
      };
      const storedValue = BigInt(setting.serviceChargeStoredValue);
      return {
        serviceChargeMode: setting.serviceChargeMode,
        serviceChargeValue: setting.serviceChargeMode === 'PERCENTAGE'
          ? percentageText(storedValue) : storedValue.toString(),
        serviceChargeTaxCode: setting.serviceChargeTaxCode,
        taxSlabs: taxSlabs.rows,
      };
    });
  }

  async setSettings(ctx: RequestCtx, input: BillingSettingsInput) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      let value = 0n;
      let taxSlabId: string | null = null;
      if (input.serviceChargeMode === 'NONE') {
        if (input.serviceChargeValue !== '0' || input.serviceChargeTaxCode) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_BILLING_SETTINGS', 'Disabled service charge settings must have zero value and no tax code');
        }
      } else {
        value = input.serviceChargeMode === 'PERCENTAGE'
          ? parsePercentage(input.serviceChargeValue)
          : parsePaise(input.serviceChargeValue, 'Service charge', false);
        if (input.serviceChargeTaxCode) {
          const result = await c.query(
            `SELECT id FROM tax_slabs
              WHERE tenant_id = $1 AND lower(code) = lower($2) AND deleted_at IS NULL
              FOR SHARE`,
            [ctx.tenantId, input.serviceChargeTaxCode],
          );
          if (!result.rowCount) {
            throw new AppException(HttpStatus.BAD_REQUEST, 'SERVICE_CHARGE_TAX_SLAB_NOT_FOUND', 'Choose an active tax slab for the service charge');
          }
          taxSlabId = result.rows[0].id as string;
        }
      }
      const setting = (await c.query(
        `INSERT INTO outlet_billing_settings
           (tenant_id, outlet_id, service_charge_mode, service_charge_value, service_charge_tax_slab_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, outlet_id) DO UPDATE
           SET service_charge_mode = EXCLUDED.service_charge_mode,
               service_charge_value = EXCLUDED.service_charge_value,
               service_charge_tax_slab_id = EXCLUDED.service_charge_tax_slab_id,
               deleted_at = NULL
         RETURNING id`,
        [ctx.tenantId, outletId, input.serviceChargeMode, value.toString(), taxSlabId],
      )).rows[0];
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'billing.settings.update', entity: 'outlet_billing_settings', entityId: setting.id,
        meta: { outletId, serviceChargeMode: input.serviceChargeMode, serviceChargeValue: value.toString(), serviceChargeTaxCode: input.serviceChargeTaxCode ?? null },
      });
      return {
        serviceChargeMode: input.serviceChargeMode,
        serviceChargeValue: input.serviceChargeMode === 'PERCENTAGE' ? percentageText(value) : value.toString(),
        serviceChargeTaxCode: input.serviceChargeTaxCode ?? null,
      };
    });
  }

  async finalize(ctx: RequestCtx, orderId: string, series: string, taxMode: TaxMode, adjustment: CheckAdjustment) {
    const result = await this.finalizeChecks(ctx, orderId, undefined, series, taxMode, [adjustment]);
    return result.invoices[0];
  }

  async splitInvoices(ctx: RequestCtx, orderId: string, checks: SplitCheck[], series: string, taxMode: TaxMode) {
    if (checks.length < 2) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'SPLIT_REQUIRES_MULTIPLE_CHECKS', 'A split bill must contain at least two checks');
    }
    return this.finalizeChecks(ctx, orderId, checks, series, taxMode);
  }

  async mergeOrders(ctx: RequestCtx, primaryOrderId: string, requestedOrderIds: string[]) {
    const outletId = this.outletId(ctx);
    if (!requestedOrderIds.includes(primaryOrderId) || new Set(requestedOrderIds).size !== requestedOrderIds.length) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_BILL_MERGE', 'Include the primary order once in the merge order list');
    }
    if (requestedOrderIds.length < 2) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'BILL_MERGE_REQUIRES_MULTIPLE_ORDERS', 'Select at least two orders to merge');
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      for (const id of [...requestedOrderIds].sort()) {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [id]);
      }
      const { rows } = await c.query(
        `SELECT id, order_type AS "orderType", status, billing_group_id AS "billingGroupId"
           FROM orders
          WHERE id = ANY($1::uuid[]) AND outlet_id = $2 AND deleted_at IS NULL
          ORDER BY id FOR UPDATE`,
        [requestedOrderIds, outletId],
      );
      if (rows.length !== requestedOrderIds.length) {
        throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'One or more orders were not found at this outlet');
      }
      if (rows.some((order: { billingGroupId: string | null }) => order.billingGroupId !== null)) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_ALREADY_MERGED', 'An order already belongs to a billing merge');
      }
      if (rows.some((order: { status: string }) => order.status !== 'READY')) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_READY', 'Only ready, unbilled orders can be merged');
      }
      const unreadyItems = await c.query(
        `SELECT 1 FROM order_items
          WHERE order_id = ANY($1::uuid[]) AND outlet_id = $2 AND deleted_at IS NULL
            AND status NOT IN ('READY', 'SERVED')
          LIMIT 1`,
        [requestedOrderIds, outletId],
      );
      if (unreadyItems.rowCount) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_ITEMS_NOT_READY', 'Every item must be ready before orders can be merged');
      }
      if (new Set(rows.map((order: { orderType: string }) => order.orderType)).size !== 1) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'ORDER_TYPE_MISMATCH', 'Orders with different order types cannot be merged');
      }
      const priorInvoices = await c.query(
        'SELECT 1 FROM invoices WHERE order_id = ANY($1::uuid[]) AND outlet_id = $2 AND deleted_at IS NULL LIMIT 1',
        [requestedOrderIds, outletId],
      );
      if (priorInvoices.rowCount) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_ALREADY_BILLED', 'Orders with finalized invoices cannot be merged');
      }
      const groupId = randomUUID();
      await c.query(
        `UPDATE orders
            SET billing_group_id = $1, billing_group_primary = (id = $2)
          WHERE id = ANY($3::uuid[]) AND outlet_id = $4`,
        [groupId, primaryOrderId, requestedOrderIds, outletId],
      );
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'billing.orders.merge', entity: 'order', entityId: primaryOrderId,
        meta: { billingGroupId: groupId, orderIds: requestedOrderIds },
      });
      return { billingGroupId: groupId, primaryOrderId, orderIds: requestedOrderIds };
    });
  }

  private async finalizeChecks(
    ctx: RequestCtx, orderId: string, splitChecks: SplitCheck[] | undefined, series: string, taxMode: TaxMode,
    finalAdjustments: CheckAdjustment[] = [],
  ) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [orderId]);
      const tx = drizzle(c);
      const [order] = await tx.select({
        id: orders.id, status: orders.status, tableId: orders.tableId,
        billingGroupId: orders.billingGroupId,
      }).from(orders).where(and(
        eq(orders.id, orderId), eq(orders.outletId, outletId), isNull(orders.deletedAt),
      )).for('update').limit(1);
      if (!order) throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      if (order.billingGroupId) {
        await c.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('billing-group:' || $1, 0))",
          [order.billingGroupId],
        );
      }

      const { rows: groupRows } = order.billingGroupId
        ? await c.query(
          `SELECT id, status, table_id AS "tableId", billing_group_primary AS "isPrimary"
             FROM orders
            WHERE billing_group_id = $1 AND outlet_id = $2 AND deleted_at IS NULL
            ORDER BY id FOR UPDATE`,
          [order.billingGroupId, outletId],
        )
        : { rows: [{ id: order.id, status: order.status, tableId: order.tableId, isPrimary: true }] };
      if (!groupRows.length) {
        throw new AppException(HttpStatus.NOT_FOUND, 'ORDER_NOT_FOUND', 'Order not found');
      }
      if (groupRows.some((row: { status: string }) => row.status !== 'READY')) {
        const orderIds = groupRows.map((row: { id: string }) => row.id);
        const priorInvoice = await c.query(
          'SELECT 1 FROM invoices WHERE order_id = ANY($1::uuid[]) AND outlet_id = $2 AND deleted_at IS NULL LIMIT 1',
          [orderIds, outletId],
        );
        if (priorInvoice.rowCount) {
          throw new AppException(HttpStatus.CONFLICT, 'ORDER_ALREADY_INVOICED', 'This order has no unbilled quantities');
        }
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_NOT_READY', 'All orders in the bill must be ready before invoicing');
      }
      const primaryOrder = groupRows.find((row: { isPrimary: boolean }) => row.isPrimary);
      if (!primaryOrder) throw new Error('Billing group has no primary order');
      const orderIds = groupRows.map((row: { id: string }) => row.id);

      const outletInfo = (await c.query(
        `SELECT t.name AS "tenantName", o.name AS "outletName", o.gstin AS "outletGstin",
                COALESCE(o.timezone, t.timezone) AS timezone
           FROM outlets o JOIN tenants t ON t.id = o.tenant_id
          WHERE o.id = $1 AND o.deleted_at IS NULL`,
        [outletId],
      )).rows[0];
      if (!outletInfo) throw new AppException(HttpStatus.NOT_FOUND, 'OUTLET_NOT_FOUND', 'Outlet not found');
      const { rows: orderLines } = await c.query(
        `SELECT oi.id, oi.order_id AS "orderId", oi.item_name AS "itemName",
                oi.variant_name AS "variantName", oi.quantity,
                unit_price::text AS "unitPrice", add_ons AS "addOns", tax_code AS "taxCode",
                oi.cgst_rate AS "cgstRate", oi.sgst_rate AS "sgstRate",
                oi.igst_rate AS "igstRate", oi.status,
                (oi.quantity - COALESCE((
                  SELECT sum(il.quantity) FROM invoice_lines il
                  JOIN invoices i ON i.id = il.invoice_id AND i.deleted_at IS NULL
                  WHERE il.order_item_id = oi.id
                ), 0))::int AS "remainingQuantity"
           FROM order_items oi
          WHERE oi.order_id = ANY($1::uuid[]) AND oi.outlet_id = $2 AND oi.deleted_at IS NULL
          ORDER BY oi.created_at, oi.id
          FOR UPDATE`,
        [orderIds, outletId],
      );
      const typedLines = orderLines as Array<OrderLine & { remainingQuantity: number }>;
      if (!typedLines.length || typedLines.some((line) => !['READY', 'SERVED'].includes(line.status))) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_ITEMS_NOT_READY', 'All order items must be ready before invoicing');
      }
      const remainingLines = typedLines.filter((line) => line.remainingQuantity > 0);
      if (!remainingLines.length) {
        throw new AppException(HttpStatus.CONFLICT, 'ORDER_ALREADY_INVOICED', 'No unbilled order quantities remain');
      }
      const remainingById = new Map(remainingLines.map((line) => [line.id, line.remainingQuantity]));
      let allocations: Array<Array<{ line: typeof remainingLines[number]; quantity: number }>>;
      if (!splitChecks) {
        allocations = [remainingLines.map((line) => ({ line, quantity: line.remainingQuantity }))];
      } else {
        const totalsByItem = new Map<string, number>();
        allocations = splitChecks.map((check) => {
          if (!check.items.length || new Set(check.items.map((item) => item.orderItemId)).size !== check.items.length) {
            throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_BILL_SPLIT', 'Each check must contain unique order items');
          }
          return check.items.map((item) => {
            const remaining = remainingById.get(item.orderItemId);
            if (remaining === undefined || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > remaining) {
              throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_BILL_SPLIT_QUANTITY', 'Split quantity exceeds the unbilled order quantity');
            }
            totalsByItem.set(item.orderItemId, (totalsByItem.get(item.orderItemId) ?? 0) + item.quantity);
            return { line: remainingLines.find((line) => line.id === item.orderItemId)!, quantity: item.quantity };
          });
        });
        if (remainingLines.some((line) => totalsByItem.get(line.id) !== line.remainingQuantity)) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'INCOMPLETE_BILL_SPLIT', 'Every remaining item quantity must be assigned to exactly one check');
        }
      }

      const adjustments = splitChecks ?? finalAdjustments;
      const hasDiscount = adjustments.some((adjustment) => adjustment.discount !== undefined);
      const discountLimits = hasDiscount
        ? await this.permissions.has(ctx.tenantId!, ctx.userId, 'discount:apply', outletId)
        : undefined;
      if (hasDiscount && !discountLimits) {
        throw new AppException(HttpStatus.FORBIDDEN, 'PERMISSION_DENIED', 'You do not have permission to apply a discount', { permission: 'discount:apply' });
      }
      const configuredMaxPercent = discountLimits?.maxPercent;
      let maxDiscountBps: bigint | null = null;
      if (configuredMaxPercent !== undefined) {
        const maxPercentNumber = Number(configuredMaxPercent);
        if (!Number.isFinite(maxPercentNumber) || maxPercentNumber < 0 || maxPercentNumber > 100) {
          throw new AppException(HttpStatus.INTERNAL_SERVER_ERROR, 'INVALID_DISCOUNT_PERMISSION_LIMIT', 'The configured discount limit is invalid');
        }
        maxDiscountBps = BigInt(Math.floor(maxPercentNumber * 100 + 1e-8));
      }
      const preparedChecks = allocations.map((check, index) => {
        const adjustment = adjustments[index] ?? {};
        const lines = check.map(({ line, quantity }) => {
          const unitGross = BigInt(line.unitPrice) + line.addOns.reduce((sum, addOn) => sum + BigInt(addOn.price), 0n);
          return { line, quantity, gross: unitGross * BigInt(quantity) };
        });
        const gross = lines.reduce((sum, line) => sum + line.gross, 0n);
        let discountAmount = 0n;
        let discountValue = 0n;
        const discountType = adjustment.discount?.type ?? null;
        if (adjustment.discount) {
          if (discountType === 'PERCENTAGE') {
            discountValue = parsePercentage(adjustment.discount.value);
            discountAmount = roundDivide(gross * discountValue, 10000n);
          } else {
            discountValue = parsePaise(adjustment.discount.value, 'Discount', false);
            discountAmount = discountValue;
            if (discountAmount > gross) {
              throw new AppException(HttpStatus.BAD_REQUEST, 'DISCOUNT_EXCEEDS_SUBTOTAL', 'Discount cannot exceed the item subtotal');
            }
          }
          if (maxDiscountBps !== null && (
            (discountType === 'PERCENTAGE' && discountValue > maxDiscountBps)
            || (discountType === 'FIXED' && discountAmount * 10000n > gross * maxDiscountBps)
          )) {
            throw new AppException(HttpStatus.FORBIDDEN, 'DISCOUNT_LIMIT_EXCEEDED', 'Discount exceeds your permitted maximum', {
              maxPercent: configuredMaxPercent,
            });
          }
        }
        const discounts = allocateProportionally(discountAmount, lines.map((line) => line.gross));
        const tipAmount = parsePaise(adjustment.tipAmount ?? '0', 'Tip');
        return {
          lines: lines.map((line, lineIndex) => ({
            ...line, discountAmount: discounts[lineIndex], netGross: line.gross - discounts[lineIndex],
          })),
          gross: gross - discountAmount,
          discountType,
          discountValue,
          discountAmount,
          tipAmount,
        };
      });

      const billingSetting = (await c.query(
        `SELECT service_charge_mode AS "serviceChargeMode",
                service_charge_value::text AS "serviceChargeValue",
                service_charge_tax_slab_id AS "serviceChargeTaxSlabId"
           FROM outlet_billing_settings
          WHERE tenant_id = $1 AND outlet_id = $2 AND deleted_at IS NULL`,
        [ctx.tenantId, outletId],
      )).rows[0] ?? { serviceChargeMode: 'NONE', serviceChargeValue: '0', serviceChargeTaxSlabId: null };
      let serviceChargeTaxRates = { cgstRate: 0, sgstRate: 0, igstRate: 0 };
      let serviceChargeTaxCode: string | null = null;
      if (billingSetting.serviceChargeTaxSlabId) {
        const slab = await c.query(
          `SELECT code, cgst_rate AS "cgstRate", sgst_rate AS "sgstRate", igst_rate AS "igstRate"
             FROM tax_slabs
            WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [ctx.tenantId, billingSetting.serviceChargeTaxSlabId],
        );
        if (!slab.rowCount) {
          throw new AppException(HttpStatus.CONFLICT, 'SERVICE_CHARGE_TAX_SLAB_NOT_FOUND', 'The configured service charge tax slab is no longer active');
        }
        serviceChargeTaxRates = slab.rows[0];
        serviceChargeTaxCode = slab.rows[0].code as string;
      }
      const serviceChargeValue = BigInt(billingSetting.serviceChargeValue);
      const serviceChargeBasis = preparedChecks.reduce((sum, check) => sum + check.gross, 0n);
      const serviceChargeGross = billingSetting.serviceChargeMode === 'FIXED'
        ? serviceChargeValue
        : billingSetting.serviceChargeMode === 'PERCENTAGE'
          ? roundDivide(serviceChargeBasis * serviceChargeValue, 10000n) : 0n;
      const serviceChargeShares = allocateProportionally(
        serviceChargeGross, preparedChecks.map((check) => check.gross),
      );
      const fy = financialYear(new Date(), outletInfo.timezone);
      const createdInvoices = [];
      for (const [checkIndex, check] of preparedChecks.entries()) {
        const totals = {
          taxable: 0n, cgst: 0n, sgst: 0n, igst: 0n, tax: 0n, gross: 0n,
          discount: check.discountAmount, serviceCharge: serviceChargeShares[checkIndex],
          serviceChargeTaxable: 0n, serviceChargeTax: 0n,
          serviceChargeCgst: 0n, serviceChargeSgst: 0n, serviceChargeIgst: 0n,
          tip: check.tipAmount, roundOff: 0n,
        };
        const prepared = check.lines.map(({ line, quantity, discountAmount, netGross }) => {
          const tax = roundDivide(netGross * BigInt(line.igstRate), 10000n + BigInt(line.igstRate));
          const cgst = taxMode === 'INTRA_STATE' && line.igstRate
            ? roundDivide(tax * BigInt(line.cgstRate), BigInt(line.igstRate)) : 0n;
          const sgst = taxMode === 'INTRA_STATE' ? tax - cgst : 0n;
          const igst = taxMode === 'INTER_STATE' ? tax : 0n;
          const taxable = netGross - tax;
          totals.taxable += taxable;
          totals.cgst += cgst;
          totals.sgst += sgst;
          totals.igst += igst;
          totals.tax += tax;
          return { ...line, quantity, discountAmount, taxable, cgst, sgst, igst, tax, gross: netGross };
        });
        const serviceTax = serviceChargeTaxCode
          ? roundDivide(
            totals.serviceCharge * BigInt(serviceChargeTaxRates.igstRate),
            10000n + BigInt(serviceChargeTaxRates.igstRate),
          )
          : 0n;
        const serviceCgst = taxMode === 'INTRA_STATE' && serviceChargeTaxRates.igstRate
          ? roundDivide(serviceTax * BigInt(serviceChargeTaxRates.cgstRate), BigInt(serviceChargeTaxRates.igstRate)) : 0n;
        const serviceSgst = taxMode === 'INTRA_STATE' ? serviceTax - serviceCgst : 0n;
        const serviceIgst = taxMode === 'INTER_STATE' ? serviceTax : 0n;
        totals.serviceChargeTax = serviceTax;
        totals.serviceChargeCgst = serviceCgst;
        totals.serviceChargeSgst = serviceSgst;
        totals.serviceChargeIgst = serviceIgst;
        totals.serviceChargeTaxable = serviceChargeTaxCode
          ? totals.serviceCharge - serviceTax : 0n;
        totals.taxable += totals.serviceChargeTaxable;
        totals.tax += serviceTax;
        totals.cgst += serviceCgst;
        totals.sgst += serviceSgst;
        totals.igst += serviceIgst;
        const unroundedTotal = check.gross + totals.serviceCharge + totals.tip;
        const rounded = nearestRupee(unroundedTotal);
        totals.roundOff = rounded.adjustment;
        totals.gross = rounded.amount;
        if (Object.values(totals).some((amount) => amount > MAX_BIGINT)) {
          throw new AppException(HttpStatus.BAD_REQUEST, 'INVOICE_AMOUNT_TOO_LARGE', 'Invoice exceeds the supported integer amount range');
        }
        await c.query(
          `INSERT INTO invoice_counters (tenant_id, outlet_id, financial_year, series, last_number)
           VALUES ($1,$2,$3,$4,0) ON CONFLICT (tenant_id, outlet_id, financial_year, series) DO NOTHING`,
          [ctx.tenantId, outletId, fy, series],
        );
        const counter = (await c.query(
          `UPDATE invoice_counters SET last_number = last_number + 1
            WHERE tenant_id = $1 AND outlet_id = $2 AND financial_year = $3 AND series = $4
            RETURNING last_number::text AS number`,
          [ctx.tenantId, outletId, fy, series],
        )).rows[0];
        const invoiceNumber = `${fy}/${series}/${String(counter.number).padStart(6, '0')}`;
        const [invoice] = await tx.insert(invoices).values({
          tenantId: ctx.tenantId!, outletId, orderId: primaryOrder.id,
          invoiceNumber, financialYear: fy, series,
          tenantName: outletInfo.tenantName, outletName: outletInfo.outletName, outletGstin: outletInfo.outletGstin,
          taxableAmount: totals.taxable, cgstAmount: totals.cgst, sgstAmount: totals.sgst,
          igstAmount: totals.igst, totalTax: totals.tax,
          discountType: check.discountType, discountValue: check.discountValue, discountAmount: totals.discount,
          serviceChargeAmount: totals.serviceCharge, serviceChargeTaxableAmount: totals.serviceChargeTaxable,
          serviceChargeTax: totals.serviceChargeTax, serviceChargeTaxCode,
          serviceChargeCgstRate: serviceChargeTaxCode ? serviceChargeTaxRates.cgstRate : 0,
          serviceChargeSgstRate: serviceChargeTaxCode ? serviceChargeTaxRates.sgstRate : 0,
          serviceChargeIgstRate: serviceChargeTaxCode ? serviceChargeTaxRates.igstRate : 0,
          serviceChargeCgstAmount: totals.serviceChargeCgst,
          serviceChargeSgstAmount: totals.serviceChargeSgst,
          serviceChargeIgstAmount: totals.serviceChargeIgst,
          tipAmount: totals.tip, roundOffAmount: totals.roundOff,
          totalAmount: totals.gross, finalizedBy: ctx.userId,
        }).returning({ id: invoices.id });
        for (const line of prepared) {
          await tx.insert(invoiceLines).values({
            tenantId: ctx.tenantId!, outletId, invoiceId: invoice.id, orderItemId: line.id,
            itemName: line.itemName, variantName: line.variantName, quantity: line.quantity,
            unitPrice: BigInt(line.unitPrice), addOns: line.addOns, taxCode: line.taxCode,
            cgstRate: line.cgstRate, sgstRate: line.sgstRate, igstRate: line.igstRate,
            discountAmount: line.discountAmount,
            taxableAmount: line.taxable, cgstAmount: line.cgst, sgstAmount: line.sgst,
            igstAmount: line.igst, totalTax: line.tax, totalAmount: line.gross,
          });
        }
        await this.audit.log(c, {
          tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
          action: 'billing.invoice.finalize', entity: 'invoice', entityId: invoice.id,
          meta: {
            orderId: primaryOrder.id, sourceOrderIds: orderIds, invoiceNumber,
            totalAmount: totals.gross.toString(), discountAmount: totals.discount.toString(),
            serviceChargeAmount: totals.serviceCharge.toString(), tipAmount: totals.tip.toString(),
            roundOffAmount: totals.roundOff.toString(), taxMode,
          },
        });
        createdInvoices.push({
          id: invoice.id, invoiceNumber, financialYear: fy, series, taxMode,
          taxableAmount: totals.taxable.toString(), cgstAmount: totals.cgst.toString(),
          sgstAmount: totals.sgst.toString(), igstAmount: totals.igst.toString(),
          totalTax: totals.tax.toString(), discountAmount: totals.discount.toString(),
          serviceChargeAmount: totals.serviceCharge.toString(), serviceChargeTax: totals.serviceChargeTax.toString(),
          tipAmount: totals.tip.toString(), roundOffAmount: totals.roundOff.toString(),
          totalAmount: totals.gross.toString(), paymentStatus: 'UNPAID',
        });
      }
      await tx.update(orders).set({ status: 'COMPLETED' }).where(inArray(orders.id, orderIds));
      const joinedTables = await tx.select({ id: diningTables.id }).from(diningTables).where(and(
        inArray(diningTables.mergedOrderId, orderIds), eq(diningTables.outletId, outletId),
      ));
      const tableIds = [...new Set([...groupRows
        .map((row: { tableId: string | null }) => row.tableId)
        .filter((tableId: string | null): tableId is string => tableId !== null),
        ...joinedTables.map((table) => table.id),
      ])];
      for (const tableId of tableIds) {
        const activeOrder = await c.query(
          `SELECT 1 FROM orders o
            WHERE o.outlet_id = $2 AND o.id <> ALL($3::uuid[])
              AND (o.table_id = $1 OR EXISTS (
                SELECT 1 FROM dining_tables dt WHERE dt.id = $1 AND dt.merged_order_id = o.id
              ))
              AND o.status IN ('OPEN', 'HELD', 'IN_PROGRESS', 'READY') AND o.deleted_at IS NULL
            LIMIT 1`,
          [tableId, outletId, orderIds],
        );
        if (!activeOrder.rowCount) {
          await tx.update(diningTables).set({ state: 'AVAILABLE', mergedOrderId: null }).where(and(
            eq(diningTables.id, tableId), eq(diningTables.outletId, outletId),
          ));
        }
      }
      return { billingGroupId: order.billingGroupId, primaryOrderId: primaryOrder.id, invoices: createdInvoices };
    });
  }

  async get(ctx: RequestCtx, invoiceId: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const invoice = await c.query(
        `SELECT i.id, i.order_id AS "orderId", i.invoice_number AS "invoiceNumber",
                i.financial_year AS "financialYear", i.series,
                i.tenant_name AS "tenantName", i.outlet_name AS "outletName", i.outlet_gstin AS "outletGstin",
                i.taxable_amount::text AS "taxableAmount", i.cgst_amount::text AS "cgstAmount",
                i.sgst_amount::text AS "sgstAmount", i.igst_amount::text AS "igstAmount",
                i.total_tax::text AS "totalTax", i.discount_type AS "discountType",
                i.discount_value::text AS "discountValue", i.discount_amount::text AS "discountAmount",
                i.service_charge_amount::text AS "serviceChargeAmount",
                i.service_charge_taxable_amount::text AS "serviceChargeTaxableAmount",
                i.service_charge_tax::text AS "serviceChargeTax",
                i.service_charge_tax_code AS "serviceChargeTaxCode",
                i.service_charge_cgst_rate AS "serviceChargeCgstRate",
                i.service_charge_sgst_rate AS "serviceChargeSgstRate",
                i.service_charge_igst_rate AS "serviceChargeIgstRate",
                i.service_charge_cgst_amount::text AS "serviceChargeCgstAmount",
                i.service_charge_sgst_amount::text AS "serviceChargeSgstAmount",
                i.service_charge_igst_amount::text AS "serviceChargeIgstAmount",
                i.tip_amount::text AS "tipAmount", i.round_off_amount::text AS "roundOffAmount",
                i.total_amount::text AS "totalAmount",
                (COALESCE((SELECT sum(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0)
                  - COALESCE((SELECT sum(r.amount) FROM invoice_refunds r WHERE r.invoice_id = i.id), 0))::text AS "paidAmount",
                (i.total_amount
                  - COALESCE((SELECT sum(p.amount) FROM invoice_payments p WHERE p.invoice_id = i.id), 0)
                  + COALESCE((SELECT sum(r.amount) FROM invoice_refunds r WHERE r.invoice_id = i.id), 0))::text AS "balanceAmount",
                EXISTS (SELECT 1 FROM invoice_voids v WHERE v.invoice_id = i.id) AS "isVoided",
                i.created_at AS "createdAt"
           FROM invoices i
          WHERE i.id = $1 AND i.outlet_id = $2 AND i.deleted_at IS NULL
          `,
        [invoiceId, outletId],
      );
      if (!invoice.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const lines = await c.query(
        `SELECT il.id, oi.order_id AS "sourceOrderId", il.item_name AS "itemName",
                il.variant_name AS "variantName", il.quantity,
                il.unit_price::text AS "unitPrice", il.add_ons AS "addOns", il.tax_code AS "taxCode",
                il.cgst_rate AS "cgstRate", il.sgst_rate AS "sgstRate", il.igst_rate AS "igstRate",
                il.discount_amount::text AS "discountAmount",
                il.taxable_amount::text AS "taxableAmount", il.cgst_amount::text AS "cgstAmount",
                il.sgst_amount::text AS "sgstAmount", il.igst_amount::text AS "igstAmount",
                il.total_tax::text AS "totalTax", il.total_amount::text AS "totalAmount"
           FROM invoice_lines il
           JOIN order_items oi ON oi.id = il.order_item_id
          WHERE il.invoice_id = $1 AND il.outlet_id = $2
          ORDER BY il.created_at, il.id`,
        [invoiceId, outletId],
      );
      const payments = await c.query(
        `SELECT p.id, p.method, p.amount::text AS amount,
                COALESCE((SELECT sum(r.amount) FROM invoice_refunds r WHERE r.payment_id = p.id), 0)::text AS "refundedAmount",
                p.reference, p.created_at AS "createdAt"
           FROM invoice_payments p WHERE p.invoice_id = $1 AND p.outlet_id = $2 ORDER BY p.created_at, p.id`,
        [invoiceId, outletId],
      );
      const refunds = await c.query(
        `SELECT id, payment_id AS "paymentId", method, amount::text AS amount,
                reason, reference, created_at AS "createdAt"
           FROM invoice_refunds WHERE invoice_id = $1 AND outlet_id = $2 ORDER BY created_at, id`,
        [invoiceId, outletId],
      );
      const voidRecord = await c.query(
        `SELECT id, reason, created_at AS "createdAt"
           FROM invoice_voids WHERE invoice_id = $1 AND outlet_id = $2`,
        [invoiceId, outletId],
      );
      const paid = BigInt(invoice.rows[0].paidAmount);
      return {
        ...invoice.rows[0],
        paymentStatus: paid < 0n ? 'INVALID_BALANCE'
          : paid === 0n ? (refunds.rowCount ? 'REFUNDED' : 'UNPAID')
            : paid >= BigInt(invoice.rows[0].totalAmount) ? 'PAID' : 'PARTIALLY_PAID',
        lines: lines.rows,
        payments: payments.rows,
        refunds: refunds.rows,
        void: voidRecord.rows[0] ?? null,
      };
    });
  }

  async recordPayment(ctx: RequestCtx, invoiceId: string, method: PaymentMethod, amount: string, reference?: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [invoiceId]);
      const invoice = await c.query(
        `SELECT id, order_id AS "orderId", total_amount::text AS "totalAmount"
           FROM invoices WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL`,
        [invoiceId, outletId],
      );
      if (!invoice.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const voided = await c.query('SELECT 1 FROM invoice_voids WHERE invoice_id = $1', [invoiceId]);
      if (voided.rowCount) throw new AppException(HttpStatus.CONFLICT, 'INVOICE_VOIDED', 'A voided invoice cannot accept payments');
      const paid = (await c.query(
        `SELECT (COALESCE((SELECT sum(amount) FROM invoice_payments WHERE invoice_id = $1),0)
                  - COALESCE((SELECT sum(amount) FROM invoice_refunds WHERE invoice_id = $1),0))::text AS amount`,
        [invoiceId],
      )).rows[0].amount;
      const due = BigInt(invoice.rows[0].totalAmount) - BigInt(paid);
      const paymentAmount = BigInt(amount);
      if (paymentAmount > due) throw new AppException(HttpStatus.BAD_REQUEST, 'PAYMENT_EXCEEDS_BALANCE', 'Payment amount exceeds the invoice balance');
      let shiftId: string | null = null;
      if (method === 'CASH') {
        const shift = await c.query(
          `SELECT id FROM cashier_shifts
            WHERE outlet_id = $1 AND user_id = $2 AND status = 'OPEN' AND deleted_at IS NULL
            FOR UPDATE`,
          [outletId, ctx.userId],
        );
        if (!shift.rowCount) throw new AppException(HttpStatus.CONFLICT, 'CASHIER_SHIFT_REQUIRED', 'Open a cashier shift before recording a cash payment');
        shiftId = shift.rows[0].id;
      }
      const [payment] = await drizzle(c).insert(invoicePayments).values({
        tenantId: ctx.tenantId!, outletId, invoiceId, shiftId, method, amount: paymentAmount,
        reference: reference ?? null, receivedBy: ctx.userId,
      }).returning({ id: invoicePayments.id, method: invoicePayments.method, amount: sql<string>`${invoicePayments.amount}::text` });
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'billing.payment.record', entity: 'invoice_payment', entityId: payment.id,
        meta: { invoiceId, method, amount },
      });
      return payment;
    });
  }

  async void(ctx: RequestCtx, invoiceId: string, reason: string) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [invoiceId]);
      const invoice = await c.query(
        `SELECT id, total_amount::text AS "totalAmount"
           FROM invoices WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL`,
        [invoiceId, outletId],
      );
      if (!invoice.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'INVOICE_NOT_FOUND', 'Invoice not found');
      const existing = await c.query('SELECT id FROM invoice_voids WHERE invoice_id = $1', [invoiceId]);
      if (existing.rowCount) throw new AppException(HttpStatus.CONFLICT, 'INVOICE_ALREADY_VOIDED', 'Invoice is already voided');
      const captured = (await c.query(
        `SELECT (COALESCE((SELECT sum(amount) FROM invoice_payments WHERE invoice_id = $1),0)
                  - COALESCE((SELECT sum(amount) FROM invoice_refunds WHERE invoice_id = $1),0))::text AS amount`,
        [invoiceId],
      )).rows[0].amount;
      if (BigInt(captured) !== 0n) {
        throw new AppException(HttpStatus.CONFLICT, 'INVOICE_HAS_PAYMENTS', 'Refund all payments before voiding this invoice');
      }
      const [voidRecord] = await drizzle(c).insert(invoiceVoids).values({
        tenantId: ctx.tenantId!, outletId, invoiceId, reason, voidedBy: ctx.userId,
      }).returning({ id: invoiceVoids.id, createdAt: invoiceVoids.createdAt });
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'billing.invoice.void', entity: 'invoice', entityId: invoiceId,
        meta: { reason, totalAmount: invoice.rows[0].totalAmount },
      });
      return { ...voidRecord, invoiceId, reason };
    });
  }

  async refund(
    ctx: RequestCtx, invoiceId: string, paymentId: string, method: PaymentMethod,
    amount: string, reason: string, reference?: string,
  ) {
    const outletId = this.outletId(ctx);
    const refundAmount = BigInt(amount);
    if (refundAmount > MAX_BIGINT) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'REFUND_AMOUNT_TOO_LARGE', 'Refund exceeds the supported integer amount range');
    }
    const refundLimit = ctx.limits?.maxAmountPaise;
    if (refundLimit !== undefined) {
      if ((typeof refundLimit !== 'number' && typeof refundLimit !== 'string')
        || (typeof refundLimit === 'number' && !Number.isSafeInteger(refundLimit))) {
        throw new Error('Configured refund limit must be a safe integer or integer string');
      }
      if (refundAmount > BigInt(refundLimit)) {
        throw new AppException(HttpStatus.FORBIDDEN, 'REFUND_LIMIT_EXCEEDED', 'Refund amount exceeds your permitted refund limit', {
          maxAmountPaise: String(refundLimit),
        });
      }
    }
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [invoiceId]);
      const invoice = await c.query(
        'SELECT id FROM invoices WHERE id = $1 AND outlet_id = $2 AND deleted_at IS NULL',
        [invoiceId, outletId],
      );
      if (!invoice.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'INVOICE_NOT_FOUND', 'Invoice not found');
      if ((await c.query('SELECT 1 FROM invoice_voids WHERE invoice_id = $1', [invoiceId])).rowCount) {
        throw new AppException(HttpStatus.CONFLICT, 'INVOICE_VOIDED', 'A voided invoice cannot be refunded');
      }
      const payment = await c.query(
        `SELECT id, amount::text AS amount, method
           FROM invoice_payments WHERE id = $1 AND invoice_id = $2 AND outlet_id = $3`,
        [paymentId, invoiceId, outletId],
      );
      if (!payment.rowCount) throw new AppException(HttpStatus.NOT_FOUND, 'INVOICE_PAYMENT_NOT_FOUND', 'Payment not found for this invoice');
      const alreadyRefunded = (await c.query(
        'SELECT COALESCE(sum(amount), 0)::text AS amount FROM invoice_refunds WHERE payment_id = $1',
        [paymentId],
      )).rows[0].amount;
      if (refundAmount > BigInt(payment.rows[0].amount) - BigInt(alreadyRefunded)) {
        throw new AppException(HttpStatus.BAD_REQUEST, 'REFUND_EXCEEDS_PAYMENT', 'Refund amount exceeds the unrefunded payment amount');
      }
      if (payment.rows[0].method === 'CASH' && method !== 'CASH') {
        throw new AppException(HttpStatus.BAD_REQUEST, 'REFUND_METHOD_MISMATCH', 'Cash payments must be refunded in cash');
      }
      let shiftId: string | null = null;
      if (method === 'CASH') {
        const shift = await c.query(
          `SELECT id FROM cashier_shifts
            WHERE outlet_id = $1 AND user_id = $2 AND status = 'OPEN' AND deleted_at IS NULL
            FOR UPDATE`,
          [outletId, ctx.userId],
        );
        if (!shift.rowCount) throw new AppException(HttpStatus.CONFLICT, 'CASHIER_SHIFT_REQUIRED', 'Open a cashier shift before recording a cash refund');
        shiftId = shift.rows[0].id;
      }
      const [refundRecord] = await drizzle(c).insert(invoiceRefunds).values({
        tenantId: ctx.tenantId!, outletId, invoiceId, paymentId, shiftId, method,
        amount: refundAmount, reason, reference: reference ?? null, refundedBy: ctx.userId,
      }).returning({
        id: invoiceRefunds.id, amount: sql<string>`${invoiceRefunds.amount}::text`,
        method: invoiceRefunds.method, createdAt: invoiceRefunds.createdAt,
      });
      await this.audit.log(c, {
        tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'tenant_user',
        action: 'billing.payment.refund', entity: 'invoice_refund', entityId: refundRecord.id,
        meta: { invoiceId, paymentId, amount, method, reason, reference: reference ?? null },
      });
      return { ...refundRecord, invoiceId, paymentId, reason, reference: reference ?? null };
    });
  }
}
