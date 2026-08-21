# Android Cashier Hub: build and security boundary

- **Status:** Implementation foundation; native source, wrapper, and package
  lock are committed, but no Android build or physical-device evidence has been
  produced in this workspace
- **Applies to:** `android/` native host, `ThePlugOSLocalHub` Capacitor bridge, local encrypted ledger
- **Authority:** ADR-003 and the Local-First Operational Command Contract

## What is implemented here

The committed Android host contains a Capacitor-native bridge and an inactive,
fail-closed Cashier Hub service. The service has no default branch, device,
certificate, queue, or cloud state. Until a server-verified authorization bundle
is installed, it reports `NATIVE_HUB_REQUIRED` and will not open a local transport
or accept a command. Bundle verification is native-only in
`HubEnrollmentCoordinator`; the source also contains cloud enrollment receivers,
but neither the R003 migration nor those receivers are deployed.

When provisioned, the host is designed to provide:

- a non-exportable P-256 signing key and a separate self-signed local-TLS
  certificate key in Android Keystore;
- a random SQLCipher database passphrase wrapped by an Android Keystore AES-GCM
  key (the raw passphrase is never stored at rest);
- a SQLCipher database with command receipts, immutable events, projections,
  audit records, paired-device facts, staff sessions, and cloud outbox records;
- a signed branch catalog/VAT snapshot installed into configuration projections
  without deleting previously committed local operational history;
- a foreground service that restarts a previously verified TLS listener only
  when its persisted bundle still matches this device's Keystore certificate;
- raw-byte ECDSA bundle verification against a BuildConfig-pinned public issuer
  key map; and
- a custom Capacitor plugin named `ThePlugOSLocalHub` matching the web bridge.

The native local WebSocket transport is intentionally not started until enrollment
supplies verified server-side authority and a signed binding to the locally held
TLS certificate. TLS private material is never included in a cloud bundle. A
signed challenge is still required per terminal once it starts; a LAN address or
device ID is never authority.

## Build prerequisites

Use the repository's pinned Node 22.22.2/npm 11.9.0 toolchain, **JDK 21**, and a
supported Android Studio/SDK setup. Capacitor 8.5 requires Android API 24+ and a
Java 21 toolchain; this host sets API 24/36/36. `@capacitor/core`,
`@capacitor/android`, and `@capacitor/cli` are exact locked dependencies, and the
Android Gradle wrapper is committed. From a clean checkout:

```bash
npm ci
npm run android:sync
npm run android:assemble:debug
# or: npm run android:open
```

`android:sync` intentionally rebuilds the web bundle before Capacitor copies it
into the Android host. `android:assemble:debug` invokes the committed Gradle
wrapper, rather than relying on a globally installed Gradle. A release build
must pass the issuer public-key map and cloud function URL through Gradle
properties; an empty value fails closed by design.

The Gradle host declares the current SQLCipher Android community package
(`net.zetetic:sqlcipher-android:4.17.0`) and AndroidX SQLite (`2.6.2`). It uses
`System.loadLibrary("sqlcipher")` before opening the ledger database.

The foreground service declares both `dataSync` and `connectedDevice` types and
their Android 14+ companion permissions. This is necessary for the local Hub
listener; it is not a permission to discover, pair, or trust arbitrary LAN
devices.

## Non-negotiable enrollment sequence

1. The cloud enrollment receiver verifies an owner/manager authority and the
   Hub device proof-of-possession.
2. It creates or renews a signed, expiry-bound authorization bundle that names
   exactly one business and branch, the Hub device, permitted staff/roles,
   revocation version, and the SHA-256 fingerprint of that Hub's local TLS
   certificate.
3. The Hub verifies the issuer signature against its pinned issuer key before it
   writes the bundle into SQLCipher.
4. Only after the bundle is active and unexpired, the certificate fingerprint
   matches Android Keystore, and the foreground service is live may the Hub
   accept a native-station command or open authenticated local transport. A
   paired terminal additionally requires that listener to have started
   successfully. If it cannot bind, the Hub reports paired transport as
   unavailable while retaining its valid, encrypted local authority; it never
   fabricates peer connectivity or cloud acknowledgement.

The exact wire and renewal contract is documented in
`docs/architecture/NATIVE_HUB_ENROLLMENT_AND_SYNC_PROTOCOL.md`.

The current R002/R003 database and Edge source is not deployed. No production
R002/R003 action or native enrollment is permitted until the clean R001 staging
clone and R002/R003 rehearsal gates are completed and accepted.

## Verification needed outside this workspace

- Build with the pinned Node/npm toolchain, JDK 21, and Android SDK through the
  committed Gradle wrapper.
- Run SQLCipher open/restart/rollback tests on a physical API 24+ Android device.
- Run paired-device challenge/signature verification on separate Cashier and
  Kitchen devices.
- Prove local Cashier-to-Kitchen delivery during WAN loss, then cloud outbox
  acknowledgement and exactly-once retry.
- Validate the stopped/expired/revoked authorization-bundle safe-stop behavior.
