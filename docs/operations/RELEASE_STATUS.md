# Release status and source-of-truth boundary

- **Status:** HOLD — implementation foundation, not production-ready
- **Release authority:** This document plus the accepted ADRs, ordered
  migrations, and environment-specific evidence records
- **Last reconciled source:** the R003 native Cashier Hub authority foundation
- **Production mutation authority:** explicitly withheld

## What is true today

The browser application is an owner-authenticated cloud-foundation shell. It
can create an R001 business foundation and read owner-scoped business, branch,
and staff-directory facts. It does not act as a staff authority or directly
mutate operational tables.

The first operational slice is an Android-native Cashier Hub foundation. Its
design is local-first: SQLCipher holds the local ledger, Android Keystore holds
device keys, a signed authorization bundle establishes one branch authority,
and cloud receivers replicate durable Hub events. The source contains the R003
migration and Edge receiver implementation, but they are **not deployed**.

No claim of production readiness, live multi-device operation, payment
settlement, completed order collection, kitchen delivery, printer delivery, or
cloud acknowledgement is valid until the gates below have recorded evidence.

## Environment boundary

| Environment | Current classification | Allowed action |
|---|---|---|
| Production `iwbbwcaylpulcpvbfkdx` | R001 foundation; read-only inspection only | Preserve data; do not apply R002/R003 or deploy receivers |
| Legacy staging `dpqtgfxovmiwzkiuzoya` | Paused contaminated rehearsal evidence | Preserve for comparison; do not resume, reset, overwrite, or treat as a release target without a separate review |
| Clean staging `nuufscrmkfoukndfmwcc` | Empty Free-plan replacement | Use only for the verified R001 clone runbook; do not apply R002/R003 or deploy receivers until the clone gate passes |

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
