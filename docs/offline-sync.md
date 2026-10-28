# Offline-first sync design (P0 deliverable — design only, implementation in P1/P2)

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
- **Push**: `POST /v1/sync/push` — batch of outbox events, each with `idempotency_key = device_id:device_seq`.
  Response per event: `applied | duplicate | rejected(reason)`. Rejected events surface in a manual-resolve UI.
- **Pull**: `GET /v1/sync/pull?since=<cursor>` — cursor = server-side monotonic change sequence
  (per tenant+outlet), not a timestamp. Returns upserts/tombstones (`deleted_at`) for master data.
- Tables that participate carry `tenant_id, outlet_id, updated_at, deleted_at, version` (already the convention).

## Conflict rules
| Data | Rule |
|---|---|
| Orders / bills / payments | Append-only events; no merge needed |
| Menu / price / tax | Server wins; device read-only |
| Stock | Ledger entries merge; balance is recomputed, never overwritten |
| Same table edited by two devices | Table lease (server-granted, TTL) + conflict alert if lease lost while offline |

## Invoice numbering offline
Server allocates each device a **block** of invoice numbers per (outlet, financial-year, series), e.g. 1001–1100,
refilled when <20% remain. Gaps from unused blocks are recorded and reportable (GST audit trail).

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

## Open items for P1
1. Hub election and LAN discovery.
2. Cursor storage shape (per-table sequence vs global change feed).
3. Final choice: WatermelonDB vs op-sqlite (see spikes).
