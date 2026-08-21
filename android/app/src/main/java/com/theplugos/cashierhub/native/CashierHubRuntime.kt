package com.theplugos.cashierhub.native

import android.content.Context
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Native source of operational truth. It never synthesizes a branch, device,
 * transport, or cloud acknowledgement. An empty Hub is intentionally unusable.
 */
class CashierHubRuntime(context: Context) {
    private val keys = HubKeyManager(context.applicationContext)
    private val database = HubDatabase(context.applicationContext, keys)
    private val verifier = HubCommandVerifier(database, ::nowIso)
    private val router = HubCommandRouter(database)
    private val cloudSync = HubCloudSyncClient(database, ::activeAuthorizationBundleForCloud, ::signCloudProtocol)
    private val cloudAuthority by lazy { HubCloudAuthorityClient(this) }
    private val cloudExecutor = Executors.newSingleThreadScheduledExecutor()
    private val observers = CopyOnWriteArraySet<(HubSnapshot) -> Unit>()

    @Volatile
    private var foregroundServiceRunning = false

    @Volatile
    private var localTransportRunning = false

    @Volatile
    private var localTransport: AuthenticatedLocalWebSocketTransport? = null

    @Volatile
    private var cloudMaintenance: ScheduledFuture<*>? = null

    @Volatile
    private var lastRenewalAttemptAtMs: Long = 0

    @Volatile
    private var closed = false

    fun snapshot(): HubSnapshot {
        if (closed) return closedSnapshot()
        return try {
            val bundle = database.activeAuthorizationBundle()
            val readiness = readiness(bundle)
            val hubNode = if (readiness.availability == HubAvailability.READY && bundle != null) {
                listOf(
                    HubDevice(
                        id = bundle.hubDeviceId,
                        name = "Cashier Hub",
                        role = "ADMINISTRATOR",
                        // The Hub's encrypted ledger can remain authoritative
                        // for its own native station even when a paired-device
                        // listener cannot bind.  Do not falsely claim that
                        // peer LAN transport is available in that condition.
                        status = if (localTransportRunning) "ACTIVE" else "DEGRADED",
                        connectionType = if (localTransportRunning) "LAN_WIFI" else "UNAVAILABLE",
                        queuedEvents = database.outboxDepth(),
                        // A snapshot request is not a heartbeat. The Hub has
                        // no invented liveness timestamp until a real health
                        // monitor records one.
                        lastHeartbeat = null,
                        certFingerprint = keys.localTlsCertificateFingerprint(),
                        businessId = bundle.businessId,
                        branchId = bundle.branchId,
                        isHub = true
                    )
                )
            } else {
                emptyList()
            }
            HubSnapshot(
                health = readiness,
                devices = hubNode + if (readiness.availability == HubAvailability.READY) database.pairedDevices() else emptyList(),
                outbox = if (readiness.availability == HubAvailability.READY) database.outbox() else emptyList(),
                inbox = emptyList()
            )
        } catch (_: Exception) {
            HubSnapshot(
                health = HubHealth(
                    mode = "NATIVE_HUB_REQUIRED",
                    availability = HubAvailability.ERROR,
                    localPeerCount = 0,
                    packetLossRate = null,
                    latencyMs = null,
                    outboxDepth = 0,
                    inboxDepth = 0,
                    lastSyncTimestamp = null,
                    cloudStatus = CloudStatus.UNKNOWN,
                    activeTransport = "UNAVAILABLE",
                    message = "The encrypted local Hub ledger could not be opened. No operational command has been accepted."
                )
            )
        }
    }

    fun startForegroundService() {
        if (closed) return
        foregroundServiceRunning = true
        // After a process restart, the last verified bundle is still encrypted
        // in SQLCipher. Restart its listener only if the persisted bundle still
        // validates against this device's Keystore TLS certificate; otherwise
        // leave the Hub unavailable rather than fabricating continuity.
        runCatching { startVerifiedLocalTransport() }
        startCloudMaintenance()
        notifyObservers()
    }

    fun stopForegroundService() {
        if (closed) return
        foregroundServiceRunning = false
        stopCloudMaintenance()
        stopVerifiedLocalTransport(notify = false)
        notifyObservers()
    }

    fun submit(commandJson: JSONObject): HubReceipt = submit(OperationalCommand.fromJson(commandJson))

    /**
     * The native bridge accepts only a non-secret command request. It derives
     * the Hub device, active native staff session, timestamp, sequence, and
     * signature inside SQLCipher/Android Keystore rather than trusting a web
     * caller to provide any of those authority facts.
     */
    @Synchronized
    internal fun submitNativeCommandRequest(commandId: String, type: String, payload: JSONObject): HubReceipt {
        if (type !in NATIVE_BRIDGE_COMMAND_TYPES) {
            throw HubCommandRejectedException("Command $type is not implemented by this Hub release.")
        }
        HubPayloadSafety.rejectSensitiveValues(payload)
        val bundle = database.activeAuthorizationBundle()
            ?: throw HubUnavailableException("The Hub has not been enrolled with an authorization bundle.")
        val readiness = readiness(bundle)
        if (readiness.availability != HubAvailability.READY) throw HubUnavailableException(readiness.message)
        val issuedAt = nowIso()
        val nativeSession = database.activeNativeStaffSession(bundle.hubDeviceId, issuedAt)
            ?: throw HubUnavailableException("A fresh native staff sign-in is required before this Hub can submit an operational command.")
        if (nativeSession.revocationVersion != bundle.revocationVersion) {
            throw HubUnavailableException("The active native staff session was issued under an obsolete authorization bundle.")
        }
        val intent = database.prepareNativeCommandIntent(
            commandId = commandId,
            deviceId = bundle.hubDeviceId,
            staffSessionId = nativeSession.sessionId,
            type = type,
            payload = payload,
            issuedAt = issuedAt
        )
        val command = OperationalCommand(
            commandId = intent.commandId,
            type = intent.type,
            issuedAt = intent.issuedAt,
            deviceId = intent.deviceId,
            staffSessionId = intent.staffSessionId,
            sequence = intent.sequence,
            payloadBase64 = intent.payloadBase64,
            payload = intent.payload,
            signature = HubWireEncoding.encode(keys.sign(commandBytes(intent)))
        )
        return submit(command)
    }

    /** Called only after the native HTTPS PIN flow has verified and installed
     * a signed bundle containing this exact session. */
    internal fun activateNativeStaffSession(staffSessionId: String) {
        val bundle = database.activeAuthorizationBundle()
            ?: throw HubUnavailableException("The Hub has not been enrolled with an authorization bundle.")
        val session = database.staffSession(staffSessionId)
            ?: throw HubCommandRejectedException("The verified native staff session is not present in this Hub bundle.")
        if (session.deviceId != bundle.hubDeviceId || session.revocationVersion != bundle.revocationVersion) {
            throw HubCommandRejectedException("The verified native staff session is not bound to this Hub authority.")
        }
        database.activateNativeStaffSession(staffSessionId, bundle.hubDeviceId, nowIso())
        notifyObservers()
    }

    @Synchronized
    private fun submit(command: OperationalCommand): HubReceipt {
        val bundle = database.activeAuthorizationBundle()
            ?: throw HubUnavailableException("The Hub has not been enrolled with an authorization bundle.")
        val readiness = readiness(bundle)
        if (readiness.availability != HubAvailability.READY) throw HubUnavailableException(readiness.message)
        val context = verifier.verify(command)
        database.duplicateReceipt(command, context)?.let { duplicate ->
            // A duplicate changes no local state, but retrying cloud delivery
            // is useful if the original local commit is still queued.
            requestCloudSync()
            notifyObservers()
            return duplicate
        }
        val routed = router.route(command, context)
        val receipt = database.commit(command, context, routed.events, routed.projections, nowIso())
        // Local peer delivery is implemented by the TLS transport only after this
        // transaction succeeds. No UI result is sent before this point.
        if (receipt.outcome == "APPLIED") {
            // Peer delivery is a best-effort notification of an already durable
            // event. A slow or disconnected terminal must not invalidate the
            // committed local receipt or prevent cloud replication.
            runCatching {
                database.events(receipt.eventIds).forEach { event ->
                    localTransport?.broadcastCommittedEvent(event)
                }
            }
        }
        requestCloudSync()
        notifyObservers()
        return receipt
    }

    @Synchronized
    internal fun installVerifiedAuthorizationBundle(bundle: VerifiedAuthorizationBundle) {
        // The caller is responsible for server-signature verification against a
        // pinned issuer key before reaching this internal method.
        // Check the rebase barrier before stopping peer transport. Otherwise a
        // rejected replacement could unnecessarily take an already-authorized
        // local shop connection offline.
        database.requireEmptyOperationalOutboxForBundleInstall()
        val priorBundle = database.activeAuthorizationBundle()
        stopVerifiedLocalTransport(notify = false)
        try {
            database.installVerifiedAuthorizationBundle(bundle)
        } catch (error: Exception) {
            if (priorBundle != null && foregroundServiceRunning && !HubTime.isExpired(priorBundle.expiresAt, nowIso())) {
                runCatching { startVerifiedLocalTransport() }
            }
            throw error
        }
        notifyObservers()
    }

    internal fun enrollmentProof(): HubEnrollmentProof = HubEnrollmentProof(
        signingPublicKeyBase64 = keys.signingPublicKeyBase64(),
        tlsCertificateBase64 = keys.localTlsCertificateBase64(),
        tlsCertificateSha256 = keys.localTlsCertificateFingerprint()
    )

    /** Native HTTPS callers may sign only protocol bytes; the private key is
     * never exposed to Capacitor or JavaScript. */
    internal fun signCloudProtocol(bytes: ByteArray): String = HubWireEncoding.encode(keys.sign(bytes))

    internal fun activeAuthorizationBundleForCloud(): ActiveAuthorizationBundle? = database.activeAuthorizationBundle()

    internal fun hasPendingOperationalOutboxForAuthorityChange(): Boolean = database.outboxDepth() > 0

    internal fun hubDeviceIdForCloud(): String = keys.hubDeviceId()

    internal fun nativeStaffDirectory(): List<StaffDirectoryRecord> = database.staffDirectory()

    internal fun nativeOperatorContext(): NativeOperatorContext {
        val bundle = database.activeAuthorizationBundle()
            ?: throw HubUnavailableException("The Hub has not been enrolled with an authorization bundle.")
        val health = readiness(bundle)
        if (health.availability != HubAvailability.READY) throw HubUnavailableException(health.message)
        return database.nativeOperatorContext(bundle.hubDeviceId, nowIso())
            ?: throw HubUnavailableException("A fresh native staff sign-in is required before this station can show operational data.")
    }

    internal fun enrollFromNativeScreen(pairingCode: CharArray, hubName: String): EnrollmentInstallResult =
        cloudAuthority.enrollCashierHub(pairingCode, hubName)

    internal fun beginStaffSessionFromNativeScreen(staffId: String, pin: CharArray): EnrollmentInstallResult =
        cloudAuthority.startNativeStaffSession(staffId, pin)

    /**
     * This is deliberately internal: only the native enrollment flow can
     * activate the listener after it verifies the signed authorization bundle
     * and its binding to the Keystore-held TLS certificate. A Capacitor/web
     * caller never receives an API to start a LAN listener.
     */
    @Synchronized
    internal fun startVerifiedLocalTransport() {
        check(!closed) { "The Cashier Hub runtime is closed." }
        val bundle = database.activeAuthorizationBundle()
            ?: throw HubUnavailableException("The Hub has not been enrolled with an authorization bundle.")
        if (HubTime.isExpired(bundle.expiresAt, nowIso())) {
            throw HubUnavailableException("The local authorization bundle has expired. Reconnect the Hub for renewal before starting local transport.")
        }
        val tlsBinding = try {
            LocalTlsBinding.fromJson(bundle.tlsMaterialJson)
        } catch (_: Exception) {
            throw HubUnavailableException("The verified enrollment bundle does not contain a valid local TLS certificate binding.")
        }
        if (tlsBinding.hubTlsCertificateSha256 != keys.localTlsCertificateFingerprint()) {
            throw HubUnavailableException("The verified enrollment bundle is not bound to this Hub's local TLS certificate.")
        }
        if (!foregroundServiceRunning) {
            throw HubUnavailableException("The Cashier Hub foreground service is not running.")
        }

        stopVerifiedLocalTransport(notify = false)
        val transport = AuthenticatedLocalWebSocketTransport(verifier, ::submit)
        try {
            transport.start(keys.localTlsServerContext())
            localTransport = transport
            localTransportRunning = true
        } catch (_: Exception) {
            transport.stop()
            localTransport = null
            localTransportRunning = false
            notifyObservers()
            throw HubUnavailableException("The verified local TLS transport could not start. No operational command has been accepted.")
        }
        notifyObservers()
    }

    @Synchronized
    internal fun stopVerifiedLocalTransport(notify: Boolean = true) {
        localTransportRunning = false
        val transport = localTransport
        localTransport = null
        runCatching { transport?.stop() }
        if (notify && !closed) notifyObservers()
    }

    fun addObserver(observer: (HubSnapshot) -> Unit): () -> Unit {
        observers += observer
        observer(snapshot())
        return { observers -= observer }
    }

    fun close() {
        if (closed) return
        foregroundServiceRunning = false
        stopCloudMaintenance()
        stopVerifiedLocalTransport(notify = false)
        closed = true
        cloudExecutor.shutdownNow()
        database.close()
        notifyObservers()
    }

    private fun readiness(bundle: ActiveAuthorizationBundle?): HubHealth {
        if (bundle == null) {
            return unavailable("This device has no verified branch authorization bundle. Enroll the Cashier Hub online before opening a local station.")
        }
        if (HubTime.isExpired(bundle.expiresAt, nowIso())) {
            return unavailable("The branch authorization bundle has expired. The Hub is in safe-stop until it renews online.")
        }
        val tlsBinding = try {
            LocalTlsBinding.fromJson(bundle.tlsMaterialJson)
        } catch (_: Exception) {
            return unavailable("The verified enrollment bundle does not contain a valid local TLS certificate binding. The Hub will not start a cleartext LAN transport.")
        }
        if (tlsBinding.hubTlsCertificateSha256 != keys.localTlsCertificateFingerprint()) {
            return unavailable("The verified enrollment bundle is not bound to this device's local TLS certificate.")
        }
        if (!foregroundServiceRunning) {
            return unavailable("The Cashier Hub foreground service is not running.")
        }
        val cloud = cloudSync.currentSnapshot()
        val peerTransportMessage = if (localTransportRunning) {
            "Authenticated paired-terminal transport is active."
        } else {
            "Authenticated paired-terminal transport is unavailable; this Hub's own native station remains available."
        }
        return HubHealth(
            mode = "LOCAL_HUB_PRIMARY",
            availability = HubAvailability.READY,
            localPeerCount = localTransport?.connectedPeerCount() ?: 0,
            packetLossRate = null,
            latencyMs = null,
            outboxDepth = database.outboxDepth(),
            inboxDepth = 0,
            lastSyncTimestamp = cloud.lastAcknowledgement,
            cloudStatus = cloud.status,
            activeTransport = if (localTransportRunning) "LAN_WIFI" else "UNAVAILABLE",
            message = "Native Hub authority is active. $peerTransportMessage ${cloud.message}"
        )
    }

    private fun unavailable(message: String) = HubHealth(
        mode = "NATIVE_HUB_REQUIRED",
        availability = HubAvailability.UNAVAILABLE,
        localPeerCount = 0,
        packetLossRate = null,
        latencyMs = null,
        outboxDepth = 0,
        inboxDepth = 0,
        lastSyncTimestamp = null,
        cloudStatus = CloudStatus.UNKNOWN,
        activeTransport = "UNAVAILABLE",
        message = message
    )

    private fun closedSnapshot() = HubSnapshot(
        health = HubHealth(
            mode = "NATIVE_HUB_REQUIRED",
            availability = HubAvailability.UNAVAILABLE,
            localPeerCount = 0,
            packetLossRate = null,
            latencyMs = null,
            outboxDepth = 0,
            inboxDepth = 0,
            lastSyncTimestamp = null,
            cloudStatus = CloudStatus.UNKNOWN,
            activeTransport = "UNAVAILABLE",
            message = "The Cashier Hub runtime is closed. Restart the Android application before accepting local commands."
        )
    )

    private fun notifyObservers() {
        val current = snapshot()
        observers.forEach { observer -> observer(current) }
    }

    private fun nowIso(): String {
        return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date())
    }

    private fun startCloudMaintenance() {
        if (cloudMaintenance?.isCancelled == false && cloudMaintenance?.isDone == false) return
        cloudMaintenance = cloudExecutor.scheduleWithFixedDelay(
            {
                if (!closed && foregroundServiceRunning) {
                    runCatching { maintainCloudAuthorityAndSync() }
                    notifyObservers()
                }
            },
            0,
            CLOUD_MAINTENANCE_INTERVAL_SECONDS,
            TimeUnit.SECONDS
        )
    }

    private fun stopCloudMaintenance() {
        cloudMaintenance?.cancel(false)
        cloudMaintenance = null
    }

    private fun requestCloudSync() {
        if (closed || !foregroundServiceRunning) return
        cloudExecutor.execute {
            if (!closed && foregroundServiceRunning) {
                runCatching { cloudSync.syncOnce() }
                notifyObservers()
            }
        }
    }

    private fun maintainCloudAuthorityAndSync() {
        // Replication always precedes renewal. A catalog-bearing replacement
        // bundle is blocked while the outbox is non-empty, because installing
        // it first could overwrite a locally reserved stock balance.
        cloudSync.syncOnce()
        val active = activeAuthorizationBundleForCloud()
        if (active != null && database.outboxDepth() == 0 && cloudAuthority.isConfigured() && renewalDue(active.expiresAt)) {
            val now = System.currentTimeMillis()
            if (now - lastRenewalAttemptAtMs >= RENEWAL_RETRY_INTERVAL_MS) {
                lastRenewalAttemptAtMs = now
                cloudAuthority.renewAuthorizationBundle()
            }
        }
    }

    private fun renewalDue(expiresAt: String): Boolean {
        return try {
            HubTime.requireCanonicalUtc(expiresAt, "Authorization expiry")
            val expiry = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
                isLenient = false
                timeZone = TimeZone.getTimeZone("UTC")
            }.parse(expiresAt)?.time ?: return true
            expiry - System.currentTimeMillis() <= RENEWAL_LEAD_MS
        } catch (_: Exception) {
            true
        }
    }

    private companion object {
        val NATIVE_BRIDGE_COMMAND_TYPES = setOf("order.create", "order.status.transition")
        const val CLOUD_MAINTENANCE_INTERVAL_SECONDS = 30L
        const val RENEWAL_LEAD_MS = 30L * 60L * 1000L
        const val RENEWAL_RETRY_INTERVAL_MS = 5L * 60L * 1000L
    }

    private fun commandBytes(intent: NativeCommandIntent): ByteArray = listOf(
        intent.commandId,
        intent.type,
        intent.issuedAt,
        intent.deviceId,
        intent.staffSessionId,
        intent.sequence.toString(),
        intent.payloadBase64
    ).joinToString("\u001F").toByteArray(Charsets.UTF_8)

}
