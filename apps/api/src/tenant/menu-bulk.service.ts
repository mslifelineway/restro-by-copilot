import { HttpStatus, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors';
import { RequestCtx } from '../common/request-context';
import { DbService } from '../db/db.service';

const HEADERS = [
  'itemId', 'category', 'taxCode', 'name', 'description', 'dietaryType', 'isAvailable',
  'sku', 'variantName', 'basePrice', 'isDefault',
] as const;
const MAX_ROWS = 1000;
const MAX_PRICE = 9223372036854775807n;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_PATTERN = /^(0|[1-9]\d{0,18})$/;
const FORMULA_PATTERN = /^[=+\-@\t\r]/;

type CsvRow = Record<(typeof HEADERS)[number], string>;
type MenuItemFields = Pick<CsvRow, 'category' | 'taxCode' | 'name' | 'description' | 'dietaryType' | 'isAvailable' | 'sku'>;
type ImportGroup = { key: string; itemId: string; fields: MenuItemFields; variants: Array<{ name: string; price: string; isDefault: boolean; row: number }> };

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let afterQuote = false;

  for (let i = input.charCodeAt(0) === 0xfeff ? 1 : 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; afterQuote = true; }
      } else {
        field += char;
      }
      continue;
    }

    if (afterQuote && char !== ',' && char !== '\r' && char !== '\n') {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_MENU_CSV', 'Unexpected character after a quoted CSV field');
    }
    if (char === '"' && field.length === 0 && !afterQuote) {
      quoted = true;
    } else if (char === ',' || char === '\r' || char === '\n') {
      row.push(field);
      field = '';
      afterQuote = false;
      if (char !== ',') {
        if (char === '\r' && input[i + 1] === '\n') i++;
        if (row.some((cell) => cell.length > 0)) rows.push(row);
        row = [];
      }
    } else {
      if (char === '"') throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_MENU_CSV', 'Quotes inside CSV fields must be escaped');
      field += char;
    }
  }

  if (quoted) throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_MENU_CSV', 'CSV contains an unterminated quoted field');
  row.push(field);
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function csvCell(value: string) {
  const safe = FORMULA_PATTERN.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

function normalizeText(value: string) {
  if (value.startsWith("'") && FORMULA_PATTERN.test(value.slice(1))) return value.slice(1);
  return value;
}

@Injectable()
export class MenuBulkService {
  constructor(private db: DbService, private audit: AuditService) {}

  private outletId(ctx: RequestCtx) {
    if (!ctx.outletId) throw new AppException(HttpStatus.BAD_REQUEST, 'OUTLET_REQUIRED', 'Select an outlet to manage menu data');
    return ctx.outletId;
  }

  async exportCsv(ctx: RequestCtx) {
    const outletId = this.outletId(ctx);
    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const { rows } = await c.query(
        `SELECT m.id AS "itemId", cat.name AS category, tax.code AS "taxCode", m.name,
                COALESCE(m.description, '') AS description, m.dietary_type AS "dietaryType",
                m.is_available AS "isAvailable", COALESCE(m.sku, '') AS sku,
                COALESCE(v.name, '') AS "variantName", COALESCE(v.base_price::text, '') AS "basePrice",
                CASE WHEN v.id IS NULL THEN '' ELSE v.is_default::text END AS "isDefault"
           FROM menu_items m
           JOIN categories cat ON cat.id = m.category_id AND cat.deleted_at IS NULL
           JOIN tax_slabs tax ON tax.id = m.tax_slab_id AND tax.deleted_at IS NULL
           LEFT JOIN variants v ON v.menu_item_id = m.id AND v.deleted_at IS NULL
          WHERE m.deleted_at IS NULL AND cat.outlet_id = $1
          ORDER BY cat.sort_order, cat.name, m.name, v.name`,
        [outletId],
      );
      const lines = [
        HEADERS.join(','),
        ...rows.map((row) => HEADERS.map((header) => csvCell(
          header === 'isAvailable' || header === 'isDefault'
            ? String(row[header])
            : String(row[header] ?? ''),
        )).join(',')),
      ];
      return { csv: lines.join('\r\n'), itemCount: new Set(rows.map((row) => row.itemId)).size };
    });
  }

  async importCsv(ctx: RequestCtx, input: string) {
    const outletId = this.outletId(ctx);
    const matrix = parseCsv(input);
    if (matrix.length < 2) throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_MENU_CSV', 'CSV must contain a header and at least one data row');
    if (matrix.length - 1 > MAX_ROWS) throw new AppException(HttpStatus.BAD_REQUEST, 'MENU_CSV_TOO_LARGE', `CSV may contain at most ${MAX_ROWS} data rows`);
    if (matrix[0].length !== HEADERS.length || matrix[0].some((header, index) => header !== HEADERS[index])) {
      throw new AppException(HttpStatus.BAD_REQUEST, 'INVALID_MENU_CSV_HEADER', `CSV header must be: ${HEADERS.join(',')}`);
    }

    const errors: Array<{ row: number; field: string; message: string }> = [];
    const groups = new Map<string, ImportGroup>();
    for (let index = 1; index < matrix.length; index++) {
      const cells = matrix[index];
      const rowNumber = index + 1;
      if (cells.length !== HEADERS.length) {
        errors.push({ row: rowNumber, field: 'row', message: `Expected ${HEADERS.length} columns, received ${cells.length}` });
        continue;
      }
      const row = Object.fromEntries(HEADERS.map((header, column) => [header, normalizeText(cells[column])])) as CsvRow;
      const fields: MenuItemFields = {
        category: row.category.trim(),
        taxCode: row.taxCode.trim().toUpperCase(),
        name: row.name.trim(),
        description: row.description,
        dietaryType: row.dietaryType.trim(),
        isAvailable: row.isAvailable.trim().toLowerCase(),
        sku: row.sku.trim(),
      };
      if (row.itemId && !UUID_PATTERN.test(row.itemId)) errors.push({ row: rowNumber, field: 'itemId', message: 'Must be a UUID' });
      if (!fields.category) errors.push({ row: rowNumber, field: 'category', message: 'Category is required' });
      if (!fields.taxCode) errors.push({ row: rowNumber, field: 'taxCode', message: 'Tax code is required' });
      if (fields.name.length < 2 || fields.name.length > 120) errors.push({ row: rowNumber, field: 'name', message: 'Must be between 2 and 120 characters' });
      if (fields.description.length > 1000) errors.push({ row: rowNumber, field: 'description', message: 'Must be at most 1000 characters' });
      if (!['VEG', 'NON_VEG', 'EGG'].includes(fields.dietaryType)) errors.push({ row: rowNumber, field: 'dietaryType', message: 'Must be VEG, NON_VEG, or EGG' });
      if (!['true', 'false'].includes(fields.isAvailable)) errors.push({ row: rowNumber, field: 'isAvailable', message: 'Must be true or false' });
      if (fields.sku.length > 80) errors.push({ row: rowNumber, field: 'sku', message: 'Must be at most 80 characters' });
      if (!row.itemId && !fields.sku) errors.push({ row: rowNumber, field: 'sku', message: 'SKU is required when itemId is empty' });

      const hasVariant = row.variantName.trim().length > 0 || row.basePrice.trim().length > 0;
      if (hasVariant && !row.variantName.trim()) errors.push({ row: rowNumber, field: 'variantName', message: 'Variant name is required when a price is provided' });
      if (row.variantName.trim().length > 80) errors.push({ row: rowNumber, field: 'variantName', message: 'Must be at most 80 characters' });
      if (hasVariant && !PRICE_PATTERN.test(row.basePrice.trim())) errors.push({ row: rowNumber, field: 'basePrice', message: 'Must be a non-negative integer paise amount' });
      if (hasVariant && BigInt(PRICE_PATTERN.test(row.basePrice.trim()) ? row.basePrice.trim() : '0') > MAX_PRICE) {
        errors.push({ row: rowNumber, field: 'basePrice', message: 'Exceeds the supported integer range' });
      }
      if (!['true', 'false', ''].includes(row.isDefault.trim().toLowerCase())) errors.push({ row: rowNumber, field: 'isDefault', message: 'Must be true or false' });
      if (!hasVariant && row.isDefault.trim()) errors.push({ row: rowNumber, field: 'isDefault', message: 'Must be empty when the row has no variant' });

      const key = row.itemId ? `id:${row.itemId.toLowerCase()}` : `sku:${fields.sku.toLowerCase()}`;
      const prior = groups.get(key);
      if (prior) {
        if (JSON.stringify(prior.fields) !== JSON.stringify(fields)) {
          errors.push({ row: rowNumber, field: 'item', message: 'Item fields must match across rows for the same item' });
        }
        if (hasVariant && prior.variants.some((variant) => variant.name.toLowerCase() === row.variantName.trim().toLowerCase())) {
          errors.push({ row: rowNumber, field: 'variantName', message: 'Variant names must be unique within an item' });
        }
        if (hasVariant && row.isDefault.trim().toLowerCase() === 'true' && prior.variants.some((variant) => variant.isDefault)) {
          errors.push({ row: rowNumber, field: 'isDefault', message: 'An item may have only one default variant' });
        }
        if (hasVariant) prior.variants.push({
          name: row.variantName.trim(),
          price: row.basePrice.trim(),
          isDefault: row.isDefault.trim().toLowerCase() === 'true',
          row: rowNumber,
        });
      } else {
        groups.set(key, {
          key,
          itemId: row.itemId,
          fields,
          variants: hasVariant ? [{
            name: row.variantName.trim(),
            price: row.basePrice.trim(),
            isDefault: row.isDefault.trim().toLowerCase() === 'true',
            row: rowNumber,
          }] : [],
        });
      }
    }
    if (errors.length) throw new AppException(HttpStatus.BAD_REQUEST, 'MENU_CSV_VALIDATION_FAILED', 'Menu CSV contains invalid rows', errors);

    return this.db.tx({ tenantId: ctx.tenantId!, outletId }, async (c) => {
      const result = { created: 0, updated: 0, variantsCreated: 0, variantsUpdated: 0 };
      for (const group of groups.values()) {
        const category = (await c.query(
          `SELECT id FROM categories WHERE outlet_id = $1 AND deleted_at IS NULL AND lower(name) = lower($2)`,
          [outletId, group.fields.category],
        )).rows[0];
        if (!category) this.referenceError(group.variants[0]?.row ?? 2, 'category', `Category "${group.fields.category}" is not available at this outlet`);
        const tax = (await c.query(
          `SELECT id FROM tax_slabs WHERE deleted_at IS NULL AND upper(code) = $1`,
          [group.fields.taxCode],
        )).rows[0];
        if (!tax) this.referenceError(group.variants[0]?.row ?? 2, 'taxCode', `Tax slab "${group.fields.taxCode}" was not found`);

        let current;
        if (group.itemId) {
          current = (await c.query(
            `SELECT m.id FROM menu_items m JOIN categories cat ON cat.id = m.category_id
              WHERE m.id = $1 AND m.deleted_at IS NULL AND cat.outlet_id = $2 AND cat.deleted_at IS NULL`,
            [group.itemId, outletId],
          )).rows[0];
        }
        if (!current && group.fields.sku) {
          current = (await c.query(
            `SELECT m.id FROM menu_items m JOIN categories cat ON cat.id = m.category_id
              WHERE lower(m.sku) = lower($1) AND m.deleted_at IS NULL AND cat.outlet_id = $2 AND cat.deleted_at IS NULL`,
            [group.fields.sku, outletId],
          )).rows[0];
        }

        let itemId: string;
        if (current) {
          itemId = current.id;
          try {
            await c.query(
              `UPDATE menu_items SET category_id = $2, tax_slab_id = $3, name = $4, description = $5,
                     dietary_type = $6, is_available = $7, sku = $8 WHERE id = $1`,
              [itemId, category.id, tax.id, group.fields.name, group.fields.description || null,
                group.fields.dietaryType, group.fields.isAvailable === 'true', group.fields.sku || null],
            );
          } catch (error) {
            if ((error as { code?: string }).code === '23505') this.skuConflict();
            throw error;
          }
          result.updated++;
        } else {
          try {
            const inserted = await c.query(
              `INSERT INTO menu_items (tenant_id, category_id, tax_slab_id, name, description, dietary_type, is_available, sku)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
              [ctx.tenantId, category.id, tax.id, group.fields.name, group.fields.description || null,
                group.fields.dietaryType, group.fields.isAvailable === 'true', group.fields.sku || null],
            );
            itemId = inserted.rows[0].id;
          } catch (error) {
            if ((error as { code?: string }).code === '23505') this.skuConflict();
            throw error;
          }
          result.created++;
        }

        if (group.variants.length) {
          await c.query('UPDATE variants SET is_default = false WHERE menu_item_id = $1 AND deleted_at IS NULL', [itemId]);
          let defaultVariantId: string | undefined;
          for (const variant of group.variants) {
            const existing = (await c.query(
              `SELECT id FROM variants WHERE menu_item_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL`,
              [itemId, variant.name],
            )).rows[0];
            if (existing) {
              await c.query('UPDATE variants SET name = $2, base_price = $3::bigint, is_default = false WHERE id = $1', [existing.id, variant.name, variant.price]);
              result.variantsUpdated++;
              if (variant.isDefault) defaultVariantId = existing.id;
            } else {
              const inserted = await c.query(
                `INSERT INTO variants (tenant_id, menu_item_id, name, base_price, is_default)
                 VALUES ($1,$2,$3,$4::bigint,false) RETURNING id`,
                [ctx.tenantId, itemId, variant.name, variant.price],
              );
              result.variantsCreated++;
              if (variant.isDefault) defaultVariantId = inserted.rows[0].id;
            }
          }
          if (defaultVariantId) await c.query('UPDATE variants SET is_default = true WHERE id = $1', [defaultVariantId]);
        }
        await this.audit.log(c, {
          tenantId: ctx.tenantId,
          actorId: ctx.userId,
          actorKind: 'tenant_user',
          action: 'menu.bulk_import',
          entity: 'menu_item',
          entityId: itemId,
          meta: { variantCount: group.variants.length, outcome: current ? 'updated' : 'created' },
        });
      }
      return result;
    });
  }

  private referenceError(row: number, field: string, message: string): never {
    throw new AppException(HttpStatus.BAD_REQUEST, 'MENU_CSV_REFERENCE_NOT_FOUND', message, [{ row, field, message }]);
  }

  private skuConflict(): never {
    throw new AppException(HttpStatus.CONFLICT, 'MENU_SKU_TAKEN', 'A menu item with this SKU already exists at another outlet');
  }
}
