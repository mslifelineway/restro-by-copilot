# P0 tech spikes — status

| Spike | Status | Outcome |
|---|---|---|
| ORM + RLS | **Done** | Drizzle works on the RLS-scoped transaction client. Decision and gotchas: `docs/adr/0002-orm-drizzle.md`. Proof: `apps/api/test/spike-drizzle-rls.e2e-spec.ts`. |
| Printer bridge (ESC/POS) | **Software done, hardware NOT validated** | `packages/printer`: ESC/POS builder (text, alignment, bold, size, QR, cut, cash-drawer pulse), ordered print spooler with retry/backoff and dead-letter queue, LAN transport (TCP 9100). Tested against a fake TCP printer only. **Still needed:** run the same bytes on 2+ real printers (58 mm and 80 mm, one LAN and one Bluetooth), confirm cut/drawer/QR behaviour per model, find a way to print the rupee sign (raster/image or model-specific code page — currently printed as `Rs.`), and build the Bluetooth/USB transport inside the React Native app. |
| POS framework (React Native + WatermelonDB / op-sqlite) | **Not started** | Needs an Android SDK/emulator and a test tablet. Suggested first slice: one-screen app that writes locally, queues an outbox row, and pushes to a stub `/api/v1/sync/push`; measure local write latency against the 300 ms budget. |
| Offline sync design | **Done (design)** | `docs/offline-sync.md`. |
