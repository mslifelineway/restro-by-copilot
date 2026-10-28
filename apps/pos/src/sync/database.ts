import { open, type DB, type Transaction } from '@op-engineering/op-sqlite';
import * as Crypto from 'expo-crypto';
import type { SyncEventInput, SyncPullChange, SyncPushResult } from '@rms/shared';

export type LocalOrder = { id: string; itemName: string; quantity: number; createdAt: string };
export type OutboxRow = {
  eventId: string;
  deviceSeq: string;
  eventType: string;
  status: 'PENDING' | 'ACKNOWLEDGED' | 'REJECTED';
  reason: string | null;
  occurredAt: string;
};

let connection: DB | null = null;
const MAX_DEVICE_SEQUENCE = 9223372036854775807n;

async function database() {
  if (connection) return connection;
  const db = open({ name: 'rms-pos.sqlite' });
  await db.execute('PRAGMA foreign_keys = ON');
  await db.execute(`CREATE TABLE IF NOT EXISTS sync_state (
    device_id TEXT NOT NULL,
    outlet_id TEXT NOT NULL,
    last_device_seq TEXT NOT NULL DEFAULT '0',
    cursor TEXT NOT NULL DEFAULT '0',
    server_offset_ms INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, outlet_id)
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS local_orders (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL,
    outlet_id TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    created_at TEXT NOT NULL
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS outbox_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL,
    outlet_id TEXT NOT NULL,
    device_seq TEXT NOT NULL,
    event_type TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACKNOWLEDGED', 'REJECTED')),
    server_reason TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (device_id, outlet_id, device_seq)
  )`);
  await db.execute('CREATE INDEX IF NOT EXISTS outbox_pending ON outbox_events (device_id, outlet_id, status, device_seq)');
  await db.execute(`CREATE TABLE IF NOT EXISTS master_data (
    device_id TEXT NOT NULL,
    outlet_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    sequence TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    deleted_at TEXT,
    PRIMARY KEY (device_id, outlet_id, entity_type, entity_id)
  )`);
  connection = db;
  return db;
}

export async function initializeSyncDatabase() {
  await database();
}

function text(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid local database value for ${key}`);
  return value;
}

function cursorValue(value: string) {
  if (!/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > MAX_DEVICE_SEQUENCE) {
    throw new Error('The sync server returned an invalid cursor');
  }
  return BigInt(value);
}

async function syncState(tx: Transaction, deviceId: string, outletId: string) {
  await tx.execute(
    `INSERT INTO sync_state (device_id, outlet_id) VALUES (?, ?)
     ON CONFLICT (device_id, outlet_id) DO NOTHING`,
    [deviceId, outletId],
  );
  const result = await tx.execute(
    'SELECT last_device_seq AS sequence, cursor, server_offset_ms AS offset FROM sync_state WHERE device_id = ? AND outlet_id = ?',
    [deviceId, outletId],
  );
  if (!result.rows[0]) throw new Error('Unable to read local sync state');
  return result.rows[0];
}

export async function queueLocalOrder(deviceId: string, outletId: string, itemName: string, quantity: number) {
  const name = itemName.trim();
  if (!name || name.length > 100) throw new Error('Item name must contain 1 to 100 characters');
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) throw new Error('Quantity must be a whole number from 1 to 1000');
  const db = await database();
  const orderId = Crypto.randomUUID();
  const eventId = Crypto.randomUUID();
  const createdAt = new Date().toISOString();
  let event: SyncEventInput | null = null;
  await db.transaction(async (tx) => {
    const state = await syncState(tx, deviceId, outletId);
    const nextSequence = BigInt(text(state, 'sequence')) + 1n;
    if (nextSequence > MAX_DEVICE_SEQUENCE) throw new Error('This device has exhausted its supported sync sequence');
    const deviceSeq = nextSequence.toString();
    const occurredAt = new Date(Date.now() + Number(state.offset ?? 0)).toISOString();
    const payload = { orderId, itemName: name, quantity };
    await tx.execute(
      'INSERT INTO local_orders (id, device_id, outlet_id, item_name, quantity, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [orderId, deviceId, outletId, name, quantity, createdAt],
    );
    await tx.execute(
      `INSERT INTO outbox_events
        (event_id, device_id, outlet_id, device_seq, event_type, occurred_at, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [eventId, deviceId, outletId, deviceSeq, 'POS_ORDER_CREATED', occurredAt, JSON.stringify(payload), createdAt],
    );
    await tx.execute(
      'UPDATE sync_state SET last_device_seq = ? WHERE device_id = ? AND outlet_id = ?',
      [deviceSeq, deviceId, outletId],
    );
    event = { deviceSeq, eventId, eventType: 'POS_ORDER_CREATED', occurredAt, payload };
  });
  if (!event) throw new Error('Local order transaction completed without an outbox event');
  return { order: { id: orderId, itemName: name, quantity, createdAt }, event };
}

export async function pendingEvents(deviceId: string, outletId: string): Promise<SyncEventInput[]> {
  const db = await database();
  const result = await db.execute(
    `SELECT device_seq AS "deviceSeq", event_id AS "eventId", event_type AS "eventType",
            occurred_at AS "occurredAt", payload_json AS "payload"
       FROM outbox_events
      WHERE device_id = ? AND outlet_id = ? AND status = 'PENDING'
      ORDER BY CAST(device_seq AS INTEGER) LIMIT 100`,
    [deviceId, outletId],
  );
  return result.rows.map((row) => ({
    deviceSeq: text(row, 'deviceSeq'),
    eventId: text(row, 'eventId'),
    eventType: text(row, 'eventType'),
    occurredAt: text(row, 'occurredAt'),
    payload: JSON.parse(text(row, 'payload')) as Record<string, unknown>,
  }));
}

export async function recordPushResults(
  deviceId: string,
  outletId: string,
  events: SyncEventInput[],
  results: SyncPushResult[],
  serverTime: string,
) {
  if (!Array.isArray(results) || results.some((result) => !result || typeof result !== 'object')) {
    throw new Error('The sync server returned invalid event results; the outbox was left unchanged');
  }
  const resultById = new Map(results.map((result) => [result.eventId, result]));
  if (resultById.size !== events.length || events.some((event) => {
    const result = resultById.get(event.eventId);
    return !result || result.deviceSeq !== event.deviceSeq;
  })) {
    throw new Error('The sync server returned a mismatched event result; the outbox was left unchanged');
  }
  if (results.some((result) => !['RECEIVED', 'DUPLICATE', 'REJECTED'].includes(result.status))) {
    throw new Error('The sync server returned an unsupported event status; the outbox was left unchanged');
  }
  const serverTimestamp = Date.parse(serverTime);
  if (!Number.isFinite(serverTimestamp)) throw new Error('The sync server returned an invalid clock value');
  const db = await database();
  await db.transaction(async (tx) => {
    for (const result of results) {
      await tx.execute(
        `UPDATE outbox_events
            SET status = ?, server_reason = ?
          WHERE device_id = ? AND outlet_id = ? AND device_seq = ? AND event_id = ?`,
        [result.status === 'REJECTED' ? 'REJECTED' : 'ACKNOWLEDGED', result.reason ?? null,
          deviceId, outletId, result.deviceSeq, result.eventId],
      );
    }
    await tx.execute(
      'UPDATE sync_state SET server_offset_ms = ? WHERE device_id = ? AND outlet_id = ?',
      [Math.round(serverTimestamp - Date.now()), deviceId, outletId],
    );
  });
}

export async function currentCursor(deviceId: string, outletId: string) {
  const db = await database();
  await db.execute(
    'INSERT INTO sync_state (device_id, outlet_id) VALUES (?, ?) ON CONFLICT (device_id, outlet_id) DO NOTHING',
    [deviceId, outletId],
  );
  const result = await db.execute(
    'SELECT cursor FROM sync_state WHERE device_id = ? AND outlet_id = ?',
    [deviceId, outletId],
  );
  if (!result.rows[0]) throw new Error('Unable to read the local sync cursor');
  return text(result.rows[0], 'cursor');
}

function deletedAt(payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = (payload as Record<string, unknown>).deleted_at;
  return typeof value === 'string' ? value : null;
}

export async function applyPullChanges(
  deviceId: string,
  outletId: string,
  changes: SyncPullChange[],
  cursor: string,
  serverTime: string,
) {
  if (!Array.isArray(changes) || changes.some((change) => !change || typeof change !== 'object'
    || typeof change.sequence !== 'string' || typeof change.entityType !== 'string'
    || typeof change.entityId !== 'string')) {
    throw new Error('The sync server returned an invalid master-data page');
  }
  const nextCursor = cursorValue(cursor);
  const serverTimestamp = Date.parse(serverTime);
  if (!Number.isFinite(serverTimestamp)) throw new Error('The sync server returned an invalid clock value');
  const db = await database();
  await db.transaction(async (tx) => {
    const state = await tx.execute(
      'SELECT cursor FROM sync_state WHERE device_id = ? AND outlet_id = ?',
      [deviceId, outletId],
    );
    if (!state.rows[0]) throw new Error('Unable to read local sync state before applying changes');
    const previousCursor = cursorValue(text(state.rows[0], 'cursor'));
    if (nextCursor < previousCursor) throw new Error('The sync server returned an older cursor');
    let previousSequence = previousCursor;
    for (const change of changes) {
      const sequence = cursorValue(change.sequence);
      if (sequence <= previousSequence || sequence > nextCursor) {
        throw new Error('The sync server returned changes outside the requested cursor range');
      }
      previousSequence = sequence;
      const payload = JSON.stringify(change.payload);
      if (payload === undefined) throw new Error('The sync server returned a non-serializable master-data payload');
      await tx.execute(
        `INSERT INTO master_data (device_id, outlet_id, entity_type, entity_id, sequence, payload_json, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id, outlet_id, entity_type, entity_id) DO UPDATE SET
           sequence = excluded.sequence, payload_json = excluded.payload_json, deleted_at = excluded.deleted_at`,
        [deviceId, outletId, change.entityType, change.entityId, change.sequence,
          payload, deletedAt(change.payload)],
      );
    }
    await tx.execute(
      `UPDATE sync_state SET cursor = ?, server_offset_ms = ?
        WHERE device_id = ? AND outlet_id = ?`,
      [cursor, Math.round(serverTimestamp - Date.now()), deviceId, outletId],
    );
  });
}

export async function localSnapshot(deviceId: string, outletId: string) {
  const db = await database();
  const [orders, outbox, master] = await Promise.all([
    db.execute(
      `SELECT id, item_name AS itemName, quantity, created_at AS createdAt
         FROM local_orders WHERE device_id = ? AND outlet_id = ? ORDER BY created_at DESC LIMIT 20`,
      [deviceId, outletId],
    ),
    db.execute(
      `SELECT event_id AS eventId, device_seq AS deviceSeq, event_type AS eventType, status,
              server_reason AS reason, occurred_at AS occurredAt
         FROM outbox_events WHERE device_id = ? AND outlet_id = ?
        ORDER BY CAST(device_seq AS INTEGER) DESC LIMIT 50`,
      [deviceId, outletId],
    ),
    db.execute(
      'SELECT count(*) AS count FROM master_data WHERE device_id = ? AND outlet_id = ? AND deleted_at IS NULL',
      [deviceId, outletId],
    ),
  ]);
  const masterCount = master.rows[0]?.count;
  return {
    orders: orders.rows.map((row) => ({
      id: text(row, 'id'), itemName: text(row, 'itemName'),
      quantity: Number(row.quantity), createdAt: text(row, 'createdAt'),
    })) as LocalOrder[],
    outbox: outbox.rows.map((row) => ({
      eventId: text(row, 'eventId'), deviceSeq: text(row, 'deviceSeq'),
      eventType: text(row, 'eventType'),
      status: text(row, 'status') as OutboxRow['status'],
      reason: typeof row.reason === 'string' ? row.reason : null,
      occurredAt: text(row, 'occurredAt'),
    })) as OutboxRow[],
    masterCount: typeof masterCount === 'number' ? masterCount : 0,
  };
}
