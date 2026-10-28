# RMS POS client

This is the P1 POS workflow and offline-sync spike. It uses Expo SDK 58,
React Native, op-sqlite, and Expo SecureStore.

## Setup

1. Register an active device in Restaurant Admin and note its device ID and assigned outlet ID.
2. Run the API and use the tenant's slug, a tenant-user login, the registered device ID, and its outlet ID.
3. Start the development client with `pnpm --filter @rms/pos start`.
4. Build a native development client before using the app. op-sqlite and SecureStore are native modules and are
   not available in Expo Go. Use `pnpm --filter @rms/pos android` or `pnpm --filter @rms/pos ios` where the
   corresponding native toolchain is installed.

The default development API origin is `http://10.0.2.2:3100`, which addresses the host API from an Android
emulator. For a physical device, enter the API host's reachable LAN address. Production builds require HTTPS.

## Current capabilities and limits

- Tenant login includes the registered device ID; API requests are scoped to that device's outlet.
- Online order entry loads the outlet catalog and table availability, creates orders, sends KOTs, finalizes invoices,
  applies optional percentage or fixed discounts, records non-taxable tips, and records split payments in integer paise.
  Configured outlet service charges and nearest-rupee rounding are applied by the API. Cash payments require an open cashier shift.
- Ready orders of the same type can be merged into one bill at the same outlet. Bills can be split into two checks by
  item quantity; every unbilled quantity must be assigned exactly once, each check can have its own discount and tip,
  and each resulting invoice is independently payable.
- Active dine-in orders can be transferred to an available or reserved table; table assignments stay outlet-scoped and
  the old table is released only when no other active order remains.
- A dine-in order can join/unjoin additional available tables, and an active order can be assigned to an active user
  with an outlet role. Table joins, waiter changes, and transfers are audited and use idempotency keys.
- Write requests send idempotency keys; a key is reused for a retry during the current app session.
- A separate demo local order and its outbox event are committed together in SQLite.
- Manual sync uploads pending events in batches and stores pull changes and their cursor transactionally.
- Rejected outbox events and server-provided reasons remain visible for follow-up.
- The server inbox is for manual review; uploading an event does not create a live order or payment.
- Offline orders remain manual-review events and are not projected into live orders or payments. Production-grade
  offline order creation/authorization and reconciliation remain out of scope for this spike.
- The client does not yet print tickets or invoices directly; printer dispatch is validated separately through the
  server queue and printer package. Restaurant admins can reprint invoices through the browser print dialog.

## Checks

Run `pnpm --filter @rms/pos typecheck`. Native build/device and physical printer testing require Android Studio/SDK
or Xcode, an installed development client, and a connected device/printer.
