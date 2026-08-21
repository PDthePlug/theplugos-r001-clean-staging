# Release status and source-of-truth boundary

- **Status:** HOLD — implementation foundation, not production-ready
- **Release authority:** This document plus the accepted ADRs, ordered
  migrations, and environment-specific evidence records
- **Last reconciled source:** the R003 native Cashier Hub authority foundation
  plus source-only order-transition, cash-capture, cash-collection,
  pending-order-cancellation, cash-shift-close, inventory-receipt, native
  Kitchen, and native station-entry additions
- **Production mutation authority:** explicitly withheld

## What is true today

The browser application is an owner-authenticated cloud-foundation shell. It
can create an R001 business foundation and read owner-scoped business, branch,
and staff-directory facts. It does not act as a staff authority or directly
mutate operational tables.

The first operational slice is an Android-native Cashier Hub foundation. Its
design is local-first: SQLCipher holds the local ledger, Android Keystore holds
device keys, a signed authorization bundle establishes one branch authority,
and cloud receivers replicate durable Hub events. Source-only R004/R005 add
order-transition authority and a cash-shift/cash-capture path. The source-only
native Kitchen workflow can request the already-authorized
`PLACED -> PREPARING -> READY` transitions through the Hub, but it does not
demonstrate remote Kitchen, printer, notification, or physical delivery. No
migration or Edge receiver is **deployed**.

The source-only Cashier collection workflow can request the existing
`READY -> COLLECTED` transition only after the local cash-capture fact is
present. It does not demonstrate physical handover, receipt printing, remote
delivery, or cloud acknowledgement.

The source-only Manager cash-shift-close workflow can record an explicit
physical count and Hub-derived variance after pending orders are resolved. It
does not demonstrate cash-up approval, bank deposit, printing, physical
custody transfer, or cloud acknowledgement.

The source-only Manager inventory-receipt workflow can record a physical
counted quantity for active signed branch products. It does not demonstrate a
supplier, purchase order, invoice, cost, payment, allocation, stock adjustment,
or cloud acknowledgement.

The source-only native pending-order-cancellation workflow exposes only the
already-authorized `PENDING` cancellation transitions for Cashier/Manager
roles. It does not demonstrate a refund, cash reversal, return, or cloud
acknowledgement.

The Android host now has a source-only native station-entry and local
session-end path that does not borrow an Owner browser session. This does not
constitute a cloud logout, a hardware acceptance result, or a production
release claim.

No claim of production readiness, live multi-device operation, payment
settlement, completed order collection, kitchen delivery, printer delivery, or
cloud acknowledgement is valid until the gates below have recorded evidence.

## Environment boundary

| Environment | Current classification | Allowed action |
|---|---|---|
| Production `iwbbwcaylpulcpvbfkdx` | R001 foundation; read-only inspection only | Preserve data; do not apply R002/R003 or deploy receivers |
| Legacy staging `dpqtgfxovmiwzkiuzoya` | Paused contaminated rehearsal evidence | Preserve for comparison; do not resume, reset, overwrite, or treat as a release target without a separate review |
| Clean staging `nuufscrmkfoukndfmwcc` | Not available for this delivery constraint | Do not use, deploy to, or mutate while delivery proceeds local-first without staging |

## Required gates before a production release

1. Create an isolated clean staging project and prove the R001 clone and
   restore path.
2. Resolve the four legacy credential records through an owner-controlled
   reset or separately reviewed conversion; rehearse R002 in staging.
3. Apply and validate R003 only on the accepted R002 staging baseline,
   including real Supabase RLS, Edge Function, and service-role checks.
4. Build and exercise the Android host on physical API 24+ hardware with
   provisioned issuer keys and cloud receiver configuration.
5. Prove atomic orders, stock reservations/reversals, durable acknowledgement,
   branch isolation, revoke/expiry safe-stop, and restart recovery.
6. Add complete payment, shift/cashup, kitchen-client, and operational
   workflows before presenting them as available product features.
7. Complete accessibility, observability, backup/restore, incident, and pilot
   acceptance with evidence tied to exact source and migration hashes.

## Documentation rule

The historical files under `docs/certification/` are not release evidence.
They describe previous prototype targets and can contain optimistic or
simulated claims. Each is marked as superseded. A release decision must cite
current, reproducible build, hardware, staging, and pilot evidence instead.

## Never do from this source tree

- Run a file from `supabase/quarantine/` as a database input.
- Apply R002 or R003 directly to production.
- Re-enable the browser IndexedDB/event/certificate/sync kernels for
  operational authority.
- Declare a local event delivered merely because connectivity returned.
- Put a staff PIN, cloud secret, signing key, device session, or authorization
  envelope in browser storage, logs, or the Capacitor bridge.
