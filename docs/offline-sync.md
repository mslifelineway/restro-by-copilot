# Offline-first sync design and server API

Source: Master Product Document v2.0, section 7. This file records the decisions P0 locks so the
schema and APIs built in P1 do not need to change.

## Principles
- Every write on a POS/waiter device lands in local SQLite first and in an **outbox** in the same local transaction.
- Server is master for menu, price, tax, entitlements, roles. Devices are read-only for these.
- Orders, KOTs, bills and payments are **append-only events**; conflicts are rare by construction.

## Identifiers and ordering
- Client-generated **UUIDs** for all device-created rows (already the PK type in every table).
- Each device keeps a monotonically increasing `device_seq`; events carry `(device_id, device_seq)` for
  idempotent replay. The server rejects duplicates of the same pair (idempotency).
- Device clock skew: on every sync the server returns `server_time`; the device stores `offset = server - local`
  and stamps `occurred_at = local + offset`. The server also stores `received_at` and flags events whose
  skew exceeds 5 minutes.

## Protocol
- **Push**: `POST /v1/sync/push` accepts at most 100 events. Each event contains a client UUID, monotonic
  `device_seq`, event type, occurrence timestamp, and JSON payload (maximum 64 KiB). The API verifies that the
  signed-in session belongs to an active device registered to the selected outlet. It stores events in a durable
  inbox; it does **not** apply event payloads to live orders/payments. Exact replays return `DUPLICATE`, conflicting
  sequence/UUID reuse or malformed event values return `REJECTED`, and newly stored events return `RECEIVED`.
  Clock skew over 5 minutes is flagged in the response and inbox. Operators can inspect `/v1/sync/events` and
  mark a received event `RESOLVED` or `REJECTED` with a required note. Resolution is a manual disposition, not
  automatic projection into business records.
- **Pull**: `GET /v1/sync/pull?since=<cursor>` returns up to 200 versioned master-data changes and a continuation
  cursor. The cursor is a monotonic integer scoped to the tenant change stream, serialized transactionally so a
  higher cursor cannot commit before a lower cursor. Outlet changes and tenant-wide tax/modifier changes are
  filtered to the selected outlet. The feed includes upserts and soft-delete tombstones for menu, tax, modifiers,
  floor tables, inventory items, and recipes. Existing records are seeded into the feed by migration.
- Tables that participate carry `tenant_id, outlet_id, updated_at, deleted_at, version` (already the convention).

## Conflict rules
| Data | Rule |
|---|---|
| Orders / bills / payments | Append-only events; no merge needed |
| Menu / price / tax | Server wins; device read-only |
| Stock | Ledger entries merge; balance is recomputed, never overwritten |
| Same table edited by two devices | Table lease (server-granted, TTL) + conflict alert if lease lost while offline |

## Invoice numbering
Invoice numbers are assigned only when an invoice is finalized online, transactionally and without gaps per
(outlet, financial-year, series). Offline devices may queue orders and payment events, but must wait for server
confirmation before presenting a finalized numbered invoice. No invoice-number blocks are preallocated to devices.

## LAN mode
Devices in one outlet talk to a local hub (POS server on the cashier tablet/mini-PC) when the internet is down:
waiter -> hub -> KDS/printer over LAN WebSocket. The hub is the sync client for the outlet while offline and
pushes the merged outbox when connectivity returns. Hub election/fallback is a P2 spike.

## Safety limits offline
- Signed role/permission snapshot cached on device (TTL). Limits (max discount %, max refund) enforced locally.
- Over-limit actions are queued as **pending approvals** and resolved on reconnect.
- Entitlement flags cached with TTL; kill switch applies on next sync.
- Staff PIN: hashed, device-bound, lockout; audit events queue in the outbox.

## Test strategy
Network-chaos tests in CI (packet loss, flapping, long outage), duplicate-delivery tests, clock-skew tests.

## POS client status

The initial `apps/pos` client slice uses **op-sqlite**. It supports tenant login on an active, registered
device; creates a local demo order and outbox event in one SQLite transaction; uploads pending events in
server-sized batches; preserves rejected events and their reasons; and stores pulled master-data changes and
the cursor transactionally. Sync is manual. Uploaded events remain in the durable review inbox and are not
projected into live orders or payments.

This is a sync proof-of-concept, not the finished POS workflow. Catalog-backed order entry, business-event
projection, conflict/reconciliation actions, offline permission snapshots, and LAN mode remain incomplete.
Native verification requires an Expo development build and Android/iOS tooling; no emulator or test tablet has
been used to validate the SQLite write-latency target.

## Remaining offline-sync work
1. Complete catalog-backed POS workflows and operator conflict/reconciliation actions. Do not automatically
   apply uploaded events to live business records; the durable inbox is an explicit product decision.
2. Add and validate offline permission/entitlement snapshots and safety limits before enabling sensitive
   offline actions.
3. Hub election and LAN discovery remain a P2 spike, not part of this server API slice.
