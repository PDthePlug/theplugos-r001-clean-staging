# Android Cashier Hub: build and security boundary

- **Status:** Implementation foundation; native project has not yet been compiled in this workspace
- **Applies to:** `android/` native host, `ThePlugOSLocalHub` Capacitor bridge, local encrypted ledger
- **Authority:** ADR-003 and the Local-First Operational Command Contract

## What is implemented here

The committed Android host contains a Capacitor-native bridge and an inactive,
fail-closed Cashier Hub service. The service has no default branch, device,
certificate, queue, or cloud state. Until a server-verified authorization bundle
is installed, it reports `NATIVE_HUB_REQUIRED` and will not open a local transport
or accept a command. Bundle verification source is present in
`HubEnrollmentCoordinator`, but no browser API can install a bundle and no cloud
enrollment receiver is deployed yet.

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

Use the repository's pinned Node 22.22.2/npm 11.9.0 toolchain and a supported
Android Studio/SDK setup. Capacitor 8 supports Android API 24+; this host sets a
minimum SDK of 24. Install the Capacitor dependencies before syncing the Android
platform:

```bash
npm install @capacitor/core@^8.5.0 @capacitor/android@^8.5.0
npm install --save-dev @capacitor/cli@^8.5.0
npm run build
npx cap sync android
npx cap open android
```

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

The current R002 RPC set is not deployed. No production R002 action or native
enrollment is permitted until the R001 staging clone and R002 rehearsal gates
are completed and accepted.

## Verification needed outside this workspace

- Build with the pinned Node toolchain and Android SDK.
- Run SQLCipher open/restart/rollback tests on a physical API 24+ Android device.
- Run paired-device challenge/signature verification on separate Cashier and
  Kitchen devices.
- Prove local Cashier-to-Kitchen delivery during WAN loss, then cloud outbox
  acknowledgement and exactly-once retry.
- Validate the stopped/expired/revoked authorization-bundle safe-stop behavior.
