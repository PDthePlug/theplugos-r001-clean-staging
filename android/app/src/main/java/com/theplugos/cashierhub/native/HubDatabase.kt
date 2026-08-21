package com.theplugos.cashierhub.native

import android.content.Context
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

data class ActiveAuthorizationBundle(
    val bundleId: String,
    val businessId: String,
    val branchId: String,
    val hubDeviceId: String,
    val expiresAt: String,
    val revocationVersion: Long,
    val tlsMaterialJson: String?
)

data class VerifiedAuthorizationBundle(
    val bundleId: String,
    val businessId: String,
    val branchId: String,
    val hubDeviceId: String,
    val issuerKeyId: String,
    val issuedAt: String,
    val expiresAt: String,
    val revocationVersion: Long,
    val payloadJson: String,
    val signature: String,
    val tlsMaterialJson: String?,
    val pairedDevices: List<BundlePairedDevice>,
    val staffDirectory: List<BundleStaffDirectoryEntry>,
    val staffSessions: List<BundleStaffSession>,
    val configuration: BundleConfigurationSnapshot
)

data class BundlePairedDevice(
    val deviceId: String,
    val name: String,
    val role: String,
    val publicKeyBase64: String,
    val connectionType: String
)

data class BundleStaffSession(
    val sessionId: String,
    val staffId: String,
    val deviceId: String,
    val role: String,
    val expiresAt: String,
    val revocationVersion: Long
)

/** Non-secret, signed roster used by the native-only fresh PIN surface. */
data class BundleStaffDirectoryEntry(
    val staffId: String,
    val name: String,
    val role: String
)

/**
 * Signed, branch-scoped operational facts needed before the Hub can validate
 * an offline command. These are configuration facts, not browser cache: a
 * renewal replaces only these projections while retained orders/events stay
 * immutable in the ledger.
 */
data class BundleConfigurationSnapshot(
    val vatEnabled: Boolean,
    val vatRate: Double,
    val catalogProducts: List<BundleCatalogProduct>
)

data class BundleCatalogProduct(
    val productId: String,
    val name: String,
    val category: String,
    val price: Double,
    val stockQuantity: Double,
    val unit: String,
    val branchId: String?,
    val status: String
)

data class PairedDeviceRecord(
    val deviceId: String,
    val name: String,
    val role: String,
    val publicKeyBase64: String,
    val businessId: String,
    val branchId: String,
    val status: String,
    val connectionType: String,
    val lastHeartbeat: String?,
    val revokedAt: String?
)

data class StaffSessionRecord(
    val sessionId: String,
    val staffId: String,
    val deviceId: String,
    val role: String,
    val expiresAt: String,
    val revocationVersion: Long,
    val lastSequence: Long,
    val revokedAt: String?
)

data class StaffDirectoryRecord(
    val staffId: String,
    val name: String,
    val role: String
)

/**
 * SQLCipher-backed local ledger. All state-changing operations use one
 * database transaction; notifications and network delivery occur afterward.
 */
class HubDatabase(private val context: Context, private val keys: HubKeyManager) {
    private val monitor = Any()
    private var database: SQLiteDatabase? = null

    init {
        System.loadLibrary("sqlcipher")
    }

    fun activeAuthorizationBundle(): ActiveAuthorizationBundle? = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT bundle_id, business_id, branch_id, hub_device_id, expires_at, revocation_version, tls_material_json FROM authorization_bundles WHERE active = 1 LIMIT 1",
            emptyArray()
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            ActiveAuthorizationBundle(
                bundleId = cursor.getString(0),
                businessId = cursor.getString(1),
                branchId = cursor.getString(2),
                hubDeviceId = cursor.getString(3),
                expiresAt = cursor.getString(4),
                revocationVersion = cursor.getLong(5),
                tlsMaterialJson = cursor.getString(6)
            )
        }
    }

    /** A catalog-bearing authority replacement is safe only after exact cloud
     * acknowledgement has drained every local operational event. */
    fun requireEmptyOperationalOutboxForBundleInstall() = synchronized(monitor) {
        if (hasUnacknowledgedOperationalEvents(open())) {
            throw HubUnavailableException(
                "DEFERRED_UNTIL_SYNC: The Hub has locally committed events awaiting cloud acknowledgement. " +
                    "Its signed catalog state cannot be replaced yet."
            )
        }
    }

    fun installVerifiedAuthorizationBundle(bundle: VerifiedAuthorizationBundle) = synchronized(monitor) {
        validateBundleFacts(bundle)
        val db = open()
        // A bundle carries a cloud catalog/stock snapshot. Replacing that
        // snapshot while a locally committed event still awaits an exact cloud
        // acknowledgement could erase or double-apply a reservation. The
        // caller must drain the durable outbox before any replacement bundle
        // is installed; the existing verified bundle remains authoritative.
        requireEmptyOperationalOutboxForBundleInstall()
        db.beginTransaction()
        try {
            // Renewing a bundle replaces server authority facts, but a session
            // that remains in the new signed bundle must retain its durable
            // command sequence. Resetting it would permit a later cloud event
            // sequence collision for an otherwise still-valid session.
            val priorSequenceBySession = buildMap {
                db.rawQuery("SELECT session_id, last_sequence FROM staff_sessions", emptyArray()).use { cursor ->
                    while (cursor.moveToNext()) put(cursor.getString(0), cursor.getLong(1))
                }
            }
            db.execSQL("UPDATE authorization_bundles SET active = 0 WHERE active = 1")
            db.execSQL("DELETE FROM authorization_bundles WHERE bundle_id = ?", arrayOf(bundle.bundleId))
            // A Hub has exactly one active branch authority. Retaining
            // terminal/session rows from the prior bundle would allow stale
            // local identity facts to survive a server-side revocation or
            // branch handover, so replace them in the same transaction.
            db.execSQL("DELETE FROM staff_sessions")
            db.execSQL("DELETE FROM staff_directory")
            db.execSQL("DELETE FROM paired_devices")
            db.execSQL(
                """
                INSERT INTO authorization_bundles
                (bundle_id, business_id, branch_id, hub_device_id, issuer_key_id, issued_at, expires_at, revocation_version, payload_json, signature, tls_material_json, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """.trimIndent(),
                arrayOf(
                    bundle.bundleId,
                    bundle.businessId,
                    bundle.branchId,
                    bundle.hubDeviceId,
                    bundle.issuerKeyId,
                    bundle.issuedAt,
                    bundle.expiresAt,
                    bundle.revocationVersion,
                    bundle.payloadJson,
                    bundle.signature,
                    bundle.tlsMaterialJson
                )
            )
            bundle.pairedDevices.forEach { device ->
                db.execSQL(
                    """
                    INSERT INTO paired_devices
                    (device_id, name, role, public_key_base64, business_id, branch_id, status, connection_type, last_heartbeat, revoked_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, NULL)
                    """.trimIndent(),
                    arrayOf(
                        device.deviceId,
                        device.name,
                        device.role,
                        device.publicKeyBase64,
                        bundle.businessId,
                        bundle.branchId,
                        device.connectionType
                    )
                )
            }
            bundle.staffSessions.forEach { session ->
                db.execSQL(
                    """
                    INSERT INTO staff_sessions
                    (session_id, staff_id, device_id, role, expires_at, revocation_version, last_sequence, revoked_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                    """.trimIndent(),
                    arrayOf(
                        session.sessionId,
                        session.staffId,
                        session.deviceId,
                        session.role,
                        session.expiresAt,
                        session.revocationVersion,
                        priorSequenceBySession[session.sessionId] ?: -1L
                    )
                )
            }
            // The selector is only a native UI convenience; it is never a
            // bearer credential. Remove it if the signed replacement no
            // longer contains that session.
            db.execSQL(
                "DELETE FROM active_native_staff_session WHERE staff_session_id NOT IN (SELECT session_id FROM staff_sessions)"
            )
            bundle.staffDirectory.forEach { staff ->
                db.execSQL(
                    "INSERT INTO staff_directory (staff_id, name, role) VALUES (?, ?, ?)",
                    arrayOf(staff.staffId, staff.name, staff.role)
                )
            }
            // Authorization renewal must remove stale catalog/configuration
            // facts, but it must never erase locally committed operational
            // projections such as orders. Those historical facts are retained
            // and later acknowledged independently through the cloud outbox.
            db.execSQL("DELETE FROM projections WHERE projection_name IN ('catalog_products', 'configuration')")
            bundle.configuration.catalogProducts.forEach { product ->
                val productJson = JSONObject()
                    .put("id", product.productId)
                    .put("name", product.name)
                    .put("category", product.category)
                    .put("price", product.price)
                    .put("stock", product.stockQuantity)
                    .put("unit", product.unit)
                    .put("branchId", product.branchId)
                    .put("status", product.status)
                    .put("businessId", bundle.businessId)
                db.execSQL(
                    "INSERT INTO projections (projection_name, projection_key, value_json, updated_at) VALUES (?, ?, ?, ?)",
                    arrayOf("catalog_products", product.productId, productJson.toString(), bundle.issuedAt)
                )
            }
            val vatJson = JSONObject()
                .put("enabled", bundle.configuration.vatEnabled)
                .put("rate", bundle.configuration.vatRate)
                .put("businessId", bundle.businessId)
                .put("branchId", bundle.branchId)
                .put("authorizationBundleId", bundle.bundleId)
            db.execSQL(
                "INSERT INTO projections (projection_name, projection_key, value_json, updated_at) VALUES ('configuration', 'vat', ?, ?)",
                arrayOf(vatJson.toString(), bundle.issuedAt)
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun pairedDevice(deviceId: String): PairedDeviceRecord? = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT device_id, name, role, public_key_base64, business_id, branch_id, status, connection_type, last_heartbeat, revoked_at FROM paired_devices WHERE device_id = ? LIMIT 1",
            arrayOf(deviceId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            PairedDeviceRecord(
                deviceId = cursor.getString(0),
                name = cursor.getString(1),
                role = cursor.getString(2),
                publicKeyBase64 = cursor.getString(3),
                businessId = cursor.getString(4),
                branchId = cursor.getString(5),
                status = cursor.getString(6),
                connectionType = cursor.getString(7),
                lastHeartbeat = cursor.getString(8),
                revokedAt = cursor.getString(9)
            )
        }
    }

    fun staffSession(sessionId: String): StaffSessionRecord? = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT session_id, staff_id, device_id, role, expires_at, revocation_version, last_sequence, revoked_at FROM staff_sessions WHERE session_id = ? LIMIT 1",
            arrayOf(sessionId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            StaffSessionRecord(
                sessionId = cursor.getString(0),
                staffId = cursor.getString(1),
                deviceId = cursor.getString(2),
                role = cursor.getString(3),
                expiresAt = cursor.getString(4),
                revocationVersion = cursor.getLong(5),
                lastSequence = cursor.getLong(6),
                revokedAt = cursor.getString(7)
            )
        }
    }

    fun staffDirectory(): List<StaffDirectoryRecord> = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT staff_id, name, role FROM staff_directory ORDER BY name, staff_id",
            emptyArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(StaffDirectoryRecord(cursor.getString(0), cursor.getString(1), cursor.getString(2)))
                }
            }
        }
    }

    /** Selects the session that a completed native PIN flow explicitly
     * activated. The opaque ID remains entirely inside SQLCipher. */
    fun activateNativeStaffSession(staffSessionId: String, hubDeviceId: String, activatedAt: String): StaffSessionRecord = synchronized(monitor) {
        HubTime.requireCanonicalUtc(activatedAt, "Native staff-session activation time")
        val session = staffSession(staffSessionId)
            ?: throw HubCommandRejectedException("The native sign-in session is not present in the current authorization bundle.")
        if (session.deviceId != hubDeviceId || session.revokedAt != null || HubTime.isExpired(session.expiresAt, activatedAt)) {
            throw HubCommandRejectedException("The native sign-in session is not valid for this Hub.")
        }
        val db = open()
        db.execSQL(
            """
            INSERT INTO active_native_staff_session (singleton, staff_session_id, activated_at)
            VALUES (1, ?, ?)
            ON CONFLICT(singleton) DO UPDATE SET
              staff_session_id = excluded.staff_session_id,
              activated_at = excluded.activated_at
            """.trimIndent(),
            arrayOf(session.sessionId, activatedAt)
        )
        session
    }

    fun activeNativeStaffSession(hubDeviceId: String, now: String): StaffSessionRecord? = synchronized(monitor) {
        HubTime.requireCanonicalUtc(now, "Current Hub time")
        val db = open()
        val session = db.rawQuery(
            """
            SELECT s.session_id, s.staff_id, s.device_id, s.role, s.expires_at,
                   s.revocation_version, s.last_sequence, s.revoked_at
            FROM active_native_staff_session active
            JOIN staff_sessions s ON s.session_id = active.staff_session_id
            WHERE active.singleton = 1
            LIMIT 1
            """.trimIndent(),
            emptyArray()
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            StaffSessionRecord(
                sessionId = cursor.getString(0),
                staffId = cursor.getString(1),
                deviceId = cursor.getString(2),
                role = cursor.getString(3),
                expiresAt = cursor.getString(4),
                revocationVersion = cursor.getLong(5),
                lastSequence = cursor.getLong(6),
                revokedAt = cursor.getString(7)
            )
        }
        if (session.deviceId == hubDeviceId && session.revokedAt == null && !HubTime.isExpired(session.expiresAt, now)) {
            return@synchronized session
        }
        db.execSQL("DELETE FROM active_native_staff_session WHERE singleton = 1")
        null
    }

    /** Returns only non-secret, signed configuration facts after an active
     * native staff selector has passed local expiry/revocation checks. */
    fun nativeOperatorContext(hubDeviceId: String, now: String): NativeOperatorContext? = synchronized(monitor) {
        val session = activeNativeStaffSession(hubDeviceId, now) ?: return@synchronized null
        val db = open()
        val staffName = db.rawQuery(
            "SELECT name FROM staff_directory WHERE staff_id = ? LIMIT 1",
            arrayOf(session.staffId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            cursor.getString(0).trim()
        }
        if (staffName.isEmpty()) return@synchronized null

        val vat = db.rawQuery(
            "SELECT value_json FROM projections WHERE projection_name = 'configuration' AND projection_key = 'vat' LIMIT 1",
            emptyArray()
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            val value = JSONObject(cursor.getString(0))
            val rate = value.optDouble("rate", Double.NaN)
            if (!rate.isFinite() || rate < 0.0 || rate > 100.0 || !value.has("enabled")) return@synchronized null
            Pair(value.optBoolean("enabled", false), rate)
        }

        val products = db.rawQuery(
            "SELECT value_json FROM projections WHERE projection_name = 'catalog_products' ORDER BY projection_key",
            emptyArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    val value = JSONObject(cursor.getString(0))
                    val productId = value.optString("id", "").trim()
                    val name = value.optString("name", "").trim()
                    val category = value.optString("category", "").trim()
                    val unit = value.optString("unit", "").trim()
                    val status = value.optString("status", "").trim()
                    val price = value.optDouble("price", Double.NaN)
                    val stock = value.optDouble("stock", Double.NaN)
                    try {
                        UUID.fromString(productId)
                    } catch (_: IllegalArgumentException) {
                        throw HubCommandRejectedException("The signed Hub catalog contains an invalid product ID.")
                    }
                    if (name.isEmpty() || category.isEmpty() || unit.isEmpty() || status !in setOf("ACTIVE", "ARCHIVED") ||
                        !price.isFinite() || price < 0.0 || !stock.isFinite() || stock < 0.0
                    ) {
                        throw HubCommandRejectedException("The signed Hub catalog contains invalid product facts.")
                    }
                    if (status == "ACTIVE") {
                        add(NativeCatalogProduct(productId, name, category, price, stock, unit, status))
                    }
                }
            }
        }
        NativeOperatorContext(staffName, session.role, vat.first, vat.second, products)
    }

    /**
     * Reserves the native command identity before the KeyStore signs it. A
     * crash or a lost plugin response can therefore retry the same exact
     * command; a new command cannot silently reuse this sequence.
     */
    fun prepareNativeCommandIntent(
        commandId: String,
        deviceId: String,
        staffSessionId: String,
        type: String,
        payload: JSONObject,
        issuedAt: String
    ): NativeCommandIntent = synchronized(monitor) {
        try {
            UUID.fromString(commandId)
        } catch (_: IllegalArgumentException) {
            throw HubCommandRejectedException("Native command ID must be a UUID.")
        }
        HubTime.requireCanonicalUtc(issuedAt, "Native command issue time")
        if (type.isBlank() || type.length > 120) throw HubCommandRejectedException("Native command type is invalid.")
        HubPayloadSafety.rejectSensitiveValues(payload)
        val payloadJson = payload.toString()
        val payloadBase64 = HubWireEncoding.encode(payloadJson.toByteArray(Charsets.UTF_8))
        val db = open()
        db.beginTransaction()
        try {
            val existing = readNativeCommandIntent(db, commandId)
            if (existing != null) {
                if (
                    existing.deviceId != deviceId ||
                    existing.staffSessionId != staffSessionId ||
                    existing.type != type ||
                    existing.payloadBase64 != payloadBase64
                ) {
                    throw HubCommandRejectedException("This native command ID is already bound to different request data.")
                }
                db.setTransactionSuccessful()
                return@synchronized existing
            }
            if (readReceipt(db, commandId) != null) {
                throw HubCommandRejectedException("This native command ID is already bound to an external command receipt.")
            }

            val session = staffSession(staffSessionId)
                ?: throw HubCommandRejectedException("The active native staff session no longer exists.")
            if (session.deviceId != deviceId || session.revokedAt != null) {
                throw HubCommandRejectedException("The active native staff session is not valid for this Hub.")
            }
            val reservedSequence = db.rawQuery(
                "SELECT COALESCE(MAX(sequence), -1) FROM native_command_intents WHERE staff_session_id = ?",
                arrayOf(staffSessionId)
            ).use { cursor ->
                cursor.moveToFirst()
                maxOf(session.lastSequence, cursor.getLong(0))
            }
            if (reservedSequence == Long.MAX_VALUE) throw HubCommandRejectedException("Native command sequence is exhausted.")
            val nextSequence = reservedSequence + 1
            db.execSQL(
                """
                INSERT INTO native_command_intents
                (command_id, device_id, staff_session_id, command_type, issued_at, sequence, payload_json, payload_base64, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf(commandId, deviceId, staffSessionId, type, issuedAt, nextSequence, payloadJson, payloadBase64, issuedAt)
            )
            val intent = NativeCommandIntent(
                commandId = commandId,
                deviceId = deviceId,
                staffSessionId = staffSessionId,
                type = type,
                issuedAt = issuedAt,
                sequence = nextSequence,
                payloadBase64 = payloadBase64,
                payload = JSONObject(payloadJson)
            )
            db.setTransactionSuccessful()
            intent
        } finally {
            db.endTransaction()
        }
    }

    /** Returns an existing receipt before routing an exact signed retry. This
     * avoids a projection-level duplicate check masking idempotency. */
    fun duplicateReceipt(command: OperationalCommand, context: VerifiedCommandContext): HubReceipt? = synchronized(monitor) {
        val existing = readReceipt(open(), command.commandId) ?: return@synchronized null
        if (existing.commandFingerprint.isBlank() ||
            !sameReceiptPrincipal(existing.receipt, command, context) ||
            existing.commandFingerprint != command.fingerprint()
        ) {
            throw HubCommandRejectedException("This command ID is already bound to a different signed command.")
        }
        existing.receipt.copy(outcome = "DUPLICATE")
    }

    fun commit(
        command: OperationalCommand,
        context: VerifiedCommandContext,
        events: List<HubEventDraft>,
        projections: List<ProjectionWrite>,
        committedAt: String
    ): HubReceipt = synchronized(monitor) {
        val db = open()
        db.beginTransaction()
        try {
            val commandFingerprint = command.fingerprint()
            readReceipt(db, command.commandId)?.let { existing ->
                if (existing.commandFingerprint.isBlank()) {
                    // A receipt created by an older, incompatible ledger
                    // schema cannot be safely matched to a retry. Refuse it
                    // rather than risking a second business effect.
                    throw HubCommandRejectedException("This command ID exists in an incompatible local receipt record. Reconcile the Hub before retrying it.")
                }
                if (!sameReceiptPrincipal(existing.receipt, command, context) || existing.commandFingerprint != commandFingerprint) {
                    throw HubCommandRejectedException("This command ID is already bound to a different signed command.")
                }
                db.setTransactionSuccessful()
                return@synchronized existing.receipt.copy(outcome = "DUPLICATE")
            }

            val staffSession = staffSession(command.staffSessionId)
                ?: throw HubCommandRejectedException("The staff session no longer exists.")
            if (command.sequence <= staffSession.lastSequence) {
                throw HubCommandRejectedException("The terminal command sequence has already been processed or is stale.")
            }

            val eventIds = mutableListOf<String>()
            val outboxIds = mutableListOf<String>()
            events.forEachIndexed { eventOrdinal, draft ->
                val eventId = UUID.randomUUID().toString()
                val outboxId = UUID.randomUUID().toString()
                eventIds += eventId
                outboxIds += outboxId

                db.execSQL(
                    """
                    INSERT INTO events
                    (event_id, command_id, aggregate_id, aggregate_type, action, business_id, branch_id, device_id, staff_id, staff_session_id, sequence, event_ordinal, occurred_at, schema_version, payload_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """.trimIndent(),
                    arrayOf(
                        eventId,
                        command.commandId,
                        draft.aggregateId,
                        draft.aggregateType,
                        draft.action,
                        context.businessId,
                        context.branchId,
                        context.deviceId,
                        context.staffId,
                        context.staffSessionId,
                        command.sequence,
                        eventOrdinal,
                        committedAt,
                        draft.schemaVersion,
                        draft.payload.toString()
                    )
                )
                db.execSQL(
                    "INSERT INTO cloud_outbox (outbox_id, event_id, command_id, business_id, branch_id, enqueued_at, attempts, status) VALUES (?, ?, ?, ?, ?, ?, 0, 'PENDING')",
                    arrayOf(outboxId, eventId, command.commandId, context.businessId, context.branchId, committedAt)
                )
            }

            projections.forEach { projection ->
                db.execSQL(
                    """
                    INSERT INTO projections (projection_name, projection_key, value_json, updated_at)
                    VALUES (?, ?, ?, ?)
                    ON CONFLICT(projection_name, projection_key)
                    DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
                    """.trimIndent(),
                    arrayOf(projection.name, projection.key, projection.value.toString(), committedAt)
                )
            }

            val receipt = HubReceipt(
                commandId = command.commandId,
                businessId = context.businessId,
                branchId = context.branchId,
                deviceId = context.deviceId,
                staffSessionId = context.staffSessionId,
                type = command.type,
                sequence = command.sequence,
                outcome = "APPLIED",
                committedAt = committedAt,
                eventIds = eventIds,
                outboxIds = outboxIds
            )
            db.execSQL(
                """
                INSERT INTO command_receipts
                (command_id, command_fingerprint, business_id, branch_id, device_id, staff_session_id, command_type, sequence, outcome, committed_at, event_ids_json, outbox_ids_json)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """.trimIndent(),
                arrayOf(
                    receipt.commandId,
                    commandFingerprint,
                    receipt.businessId,
                    receipt.branchId,
                    receipt.deviceId,
                    receipt.staffSessionId,
                    receipt.type,
                    receipt.sequence,
                    receipt.outcome,
                    receipt.committedAt,
                    JSONArray(receipt.eventIds).toString(),
                    JSONArray(receipt.outboxIds).toString()
                )
            )
            db.execSQL(
                "INSERT INTO audit_records (audit_id, command_id, business_id, branch_id, device_id, staff_id, staff_session_id, command_type, recorded_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'APPLIED')",
                arrayOf(UUID.randomUUID().toString(), command.commandId, context.businessId, context.branchId, context.deviceId, context.staffId, context.staffSessionId, command.type, committedAt)
            )
            db.execSQL(
                "UPDATE staff_sessions SET last_sequence = ? WHERE session_id = ?",
                arrayOf(command.sequence, context.staffSessionId)
            )
            db.setTransactionSuccessful()
            receipt
        } finally {
            db.endTransaction()
        }
    }

    fun outbox(): List<JSONObject> = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT event_id, command_id, enqueued_at, attempts, status FROM cloud_outbox WHERE status != 'ACKNOWLEDGED' ORDER BY enqueued_at ASC",
            emptyArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        JSONObject()
                            .put("eventId", cursor.getString(0))
                            .put("commandId", cursor.getString(1))
                            .put("timestamp", cursor.getString(2))
                            .put("attempts", cursor.getInt(3))
                            .put("status", cursor.getString(4))
                    )
                }
            }
        }
    }

    /**
     * Returns immutable event envelopes for a single signed cloud batch. The
     * rows remain durable until the cloud returns each exact event ID in its
     * acknowledgement; transport attempts alone never delete or acknowledge.
     */
    fun pendingCloudEvents(limit: Int): List<JSONObject> = synchronized(monitor) {
        val boundedLimit = limit.coerceIn(1, MAX_CLOUD_BATCH_EVENTS)
        val db = open()
        db.rawQuery(
            """
            SELECT e.event_id, e.command_id, e.aggregate_id, e.aggregate_type, e.action,
                   e.business_id, e.branch_id, e.device_id, e.staff_id, e.staff_session_id,
                   e.sequence, e.event_ordinal, e.occurred_at, e.schema_version, e.payload_json
            FROM cloud_outbox o
            JOIN events e ON e.event_id = o.event_id
            WHERE o.status IN ('PENDING', 'FAILED')
            ORDER BY e.occurred_at ASC, e.sequence ASC, e.event_ordinal ASC
            LIMIT ?
            """.trimIndent(),
            arrayOf(boundedLimit.toString())
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        JSONObject()
                            .put("eventId", cursor.getString(0))
                            .put("commandId", cursor.getString(1))
                            .put("entityId", cursor.getString(2))
                            .put("entityType", cursor.getString(3))
                            .put("action", cursor.getString(4))
                            .put("businessId", cursor.getString(5))
                            .put("branchId", cursor.getString(6))
                            .put("deviceId", cursor.getString(7))
                            .put("staffId", cursor.getString(8))
                            .put("staffSessionId", cursor.getString(9))
                            .put("sequence", cursor.getLong(10))
                            .put("eventOrdinal", cursor.getInt(11))
                            .put("timestamp", cursor.getString(12))
                            .put("schemaVersion", cursor.getInt(13))
                            .put("payload", JSONObject(cursor.getString(14)))
                    )
                }
            }
        }
    }

    fun acknowledgeCloudEvents(eventIds: Collection<String>, acknowledgedAt: String) = synchronized(monitor) {
        if (eventIds.isEmpty()) return@synchronized
        HubTime.requireCanonicalUtc(acknowledgedAt, "Cloud acknowledgement time")
        val db = open()
        db.beginTransaction()
        try {
            eventIds.distinct().forEach { eventId ->
                db.execSQL(
                    """
                    UPDATE cloud_outbox
                    SET status = 'ACKNOWLEDGED', acknowledged_at = ?, last_error = NULL
                    WHERE event_id = ? AND status != 'ACKNOWLEDGED'
                    """.trimIndent(),
                    arrayOf(acknowledgedAt, eventId)
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun recordCloudSyncFailure(eventIds: Collection<String>, reason: String) = synchronized(monitor) {
        if (eventIds.isEmpty()) return@synchronized
        val safeReason = reason.take(MAX_SYNC_ERROR_CHARS)
        val db = open()
        db.beginTransaction()
        try {
            eventIds.distinct().forEach { eventId ->
                db.execSQL(
                    """
                    UPDATE cloud_outbox
                    SET attempts = attempts + 1, status = 'FAILED', last_error = ?
                    WHERE event_id = ? AND status != 'ACKNOWLEDGED'
                    """.trimIndent(),
                    arrayOf(safeReason, eventId)
                )
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun lastCloudAcknowledgement(): String? = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT MAX(acknowledged_at) FROM cloud_outbox WHERE acknowledged_at IS NOT NULL",
            emptyArray()
        ).use { cursor ->
            if (!cursor.moveToFirst() || cursor.isNull(0)) null else cursor.getString(0)
        }
    }

    fun projection(name: String, key: String): JSONObject? = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT value_json FROM projections WHERE projection_name = ? AND projection_key = ? LIMIT 1",
            arrayOf(name, key)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return@synchronized null
            JSONObject(cursor.getString(0))
        }
    }

    fun events(eventIds: List<String>): List<JSONObject> = synchronized(monitor) {
        if (eventIds.isEmpty()) return@synchronized emptyList()
        val placeholders = eventIds.joinToString(",") { "?" }
        val db = open()
        db.rawQuery(
            """
            SELECT event_id, command_id, aggregate_id, aggregate_type, action,
                   business_id, branch_id, device_id, staff_id, staff_session_id,
                   sequence, event_ordinal, occurred_at, schema_version, payload_json
            FROM events
            WHERE event_id IN ($placeholders)
            ORDER BY sequence ASC, event_ordinal ASC
            """.trimIndent(),
            eventIds.toTypedArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        JSONObject()
                            .put("eventId", cursor.getString(0))
                            .put("commandId", cursor.getString(1))
                            .put("entityId", cursor.getString(2))
                            .put("entityType", cursor.getString(3))
                            .put("action", cursor.getString(4))
                            .put("businessId", cursor.getString(5))
                            .put("branchId", cursor.getString(6))
                            .put("deviceId", cursor.getString(7))
                            .put("staffId", cursor.getString(8))
                            .put("staffSessionId", cursor.getString(9))
                            .put("sequence", cursor.getLong(10))
                            .put("eventOrdinal", cursor.getInt(11))
                            .put("timestamp", cursor.getString(12))
                            .put("schemaVersion", cursor.getInt(13))
                            .put("payload", JSONObject(cursor.getString(14)))
                    )
                }
            }
        }
    }

    fun pairedDevices(): List<HubDevice> = synchronized(monitor) {
        val db = open()
        db.rawQuery(
            "SELECT device_id, name, role, status, connection_type, last_heartbeat, business_id, branch_id FROM paired_devices WHERE status != 'REVOKED' ORDER BY name",
            emptyArray()
        ).use { cursor ->
            buildList {
                while (cursor.moveToNext()) {
                    add(
                        HubDevice(
                            id = cursor.getString(0),
                            name = cursor.getString(1),
                            role = cursor.getString(2),
                            status = cursor.getString(3),
                            connectionType = cursor.getString(4),
                            queuedEvents = 0,
                            lastHeartbeat = cursor.getString(5),
                            businessId = cursor.getString(6),
                            branchId = cursor.getString(7)
                        )
                    )
                }
            }
        }
    }

    fun outboxDepth(): Int = synchronized(monitor) {
        val db = open()
        db.rawQuery("SELECT COUNT(*) FROM cloud_outbox WHERE status != 'ACKNOWLEDGED'", emptyArray()).use { cursor ->
            cursor.moveToFirst()
            cursor.getInt(0)
        }
    }

    fun close() = synchronized(monitor) {
        database?.close()
        database = null
    }

    private fun hasUnacknowledgedOperationalEvents(db: SQLiteDatabase): Boolean =
        db.rawQuery(
            "SELECT 1 FROM cloud_outbox WHERE status != 'ACKNOWLEDGED' LIMIT 1",
            emptyArray()
        ).use { cursor -> cursor.moveToFirst() }

    private fun readReceipt(db: SQLiteDatabase, commandId: String): StoredReceipt? {
        db.rawQuery(
            "SELECT command_fingerprint, business_id, branch_id, device_id, staff_session_id, command_type, sequence, outcome, committed_at, event_ids_json, outbox_ids_json FROM command_receipts WHERE command_id = ? LIMIT 1",
            arrayOf(commandId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            return StoredReceipt(
                commandFingerprint = cursor.getString(0),
                receipt = HubReceipt(
                    commandId = commandId,
                    businessId = cursor.getString(1),
                    branchId = cursor.getString(2),
                    deviceId = cursor.getString(3),
                    staffSessionId = cursor.getString(4),
                    type = cursor.getString(5),
                    sequence = cursor.getLong(6),
                    outcome = cursor.getString(7),
                    committedAt = cursor.getString(8),
                    eventIds = jsonArrayToStrings(cursor.getString(9)),
                    outboxIds = jsonArrayToStrings(cursor.getString(10))
                )
            )
        }
    }

    private fun readNativeCommandIntent(db: SQLiteDatabase, commandId: String): NativeCommandIntent? {
        db.rawQuery(
            """
            SELECT command_id, device_id, staff_session_id, command_type, issued_at,
                   sequence, payload_base64, payload_json
            FROM native_command_intents
            WHERE command_id = ?
            LIMIT 1
            """.trimIndent(),
            arrayOf(commandId)
        ).use { cursor ->
            if (!cursor.moveToFirst()) return null
            return NativeCommandIntent(
                commandId = cursor.getString(0),
                deviceId = cursor.getString(1),
                staffSessionId = cursor.getString(2),
                type = cursor.getString(3),
                issuedAt = cursor.getString(4),
                sequence = cursor.getLong(5),
                payloadBase64 = cursor.getString(6),
                payload = JSONObject(cursor.getString(7))
            )
        }
    }

    private fun open(): SQLiteDatabase {
        database?.let { return it }
        val databaseFile: File = context.getDatabasePath(DATABASE_NAME)
        databaseFile.parentFile?.mkdirs()
        val db = SQLiteDatabase.openOrCreateDatabase(databaseFile, keys.databasePassphrase(), null, null, null)
        db.enableWriteAheadLogging()
        createSchema(db)
        database = db
        return db
    }

    private fun createSchema(db: SQLiteDatabase) {
        db.execSQL("PRAGMA foreign_keys = ON")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS authorization_bundles (
              bundle_id TEXT PRIMARY KEY,
              business_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              hub_device_id TEXT NOT NULL,
              issuer_key_id TEXT NOT NULL,
              issued_at TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              revocation_version INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              signature TEXT NOT NULL,
              tls_material_json TEXT,
              active INTEGER NOT NULL CHECK(active IN (0, 1))
            )
        """.trimIndent())
        db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS one_active_authorization_bundle ON authorization_bundles(active) WHERE active = 1")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS staff_directory (
              staff_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              role TEXT NOT NULL
            )
        """.trimIndent())
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS paired_devices (
              device_id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              role TEXT NOT NULL,
              public_key_base64 TEXT NOT NULL,
              business_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              status TEXT NOT NULL,
              connection_type TEXT NOT NULL,
              last_heartbeat TEXT,
              revoked_at TEXT
            )
        """.trimIndent())
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS staff_sessions (
              session_id TEXT PRIMARY KEY,
              staff_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              role TEXT NOT NULL,
              expires_at TEXT NOT NULL,
              revocation_version INTEGER NOT NULL,
              last_sequence INTEGER NOT NULL DEFAULT -1,
              revoked_at TEXT
            )
        """.trimIndent())
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS active_native_staff_session (
              singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
              staff_session_id TEXT NOT NULL,
              activated_at TEXT NOT NULL
            )
        """.trimIndent())
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS native_command_intents (
              command_id TEXT PRIMARY KEY,
              device_id TEXT NOT NULL,
              staff_session_id TEXT NOT NULL,
              command_type TEXT NOT NULL,
              issued_at TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              payload_base64 TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(staff_session_id, sequence)
            )
        """.trimIndent())
        db.execSQL("CREATE INDEX IF NOT EXISTS native_command_intents_session ON native_command_intents(staff_session_id, sequence)")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS command_receipts (
              command_id TEXT PRIMARY KEY,
              command_fingerprint TEXT NOT NULL,
              business_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              staff_session_id TEXT NOT NULL,
              command_type TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              outcome TEXT NOT NULL,
              committed_at TEXT NOT NULL,
              event_ids_json TEXT NOT NULL,
              outbox_ids_json TEXT NOT NULL
            )
        """.trimIndent())
        ensureColumn(db, "command_receipts", "command_fingerprint", "TEXT NOT NULL DEFAULT ''")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS events (
              event_id TEXT PRIMARY KEY,
              command_id TEXT NOT NULL,
              aggregate_id TEXT NOT NULL,
              aggregate_type TEXT NOT NULL,
              action TEXT NOT NULL,
              business_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              staff_id TEXT NOT NULL,
              staff_session_id TEXT NOT NULL,
              sequence INTEGER NOT NULL,
              event_ordinal INTEGER NOT NULL,
              occurred_at TEXT NOT NULL,
              schema_version INTEGER NOT NULL,
              payload_json TEXT NOT NULL
            )
        """.trimIndent())
        ensureColumn(db, "events", "event_ordinal", "INTEGER NOT NULL DEFAULT 0")
        db.execSQL("CREATE INDEX IF NOT EXISTS events_branch_sequence ON events(branch_id, sequence, event_ordinal)")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS projections (
              projection_name TEXT NOT NULL,
              projection_key TEXT NOT NULL,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              PRIMARY KEY(projection_name, projection_key)
            )
        """.trimIndent())
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS cloud_outbox (
              outbox_id TEXT PRIMARY KEY,
              event_id TEXT NOT NULL UNIQUE,
              command_id TEXT NOT NULL,
              business_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              enqueued_at TEXT NOT NULL,
              attempts INTEGER NOT NULL DEFAULT 0,
              status TEXT NOT NULL,
              acknowledged_at TEXT,
              last_error TEXT
            )
        """.trimIndent())
        db.execSQL("CREATE INDEX IF NOT EXISTS cloud_outbox_pending ON cloud_outbox(status, enqueued_at)")
        db.execSQL("""
            CREATE TABLE IF NOT EXISTS audit_records (
              audit_id TEXT PRIMARY KEY,
              command_id TEXT NOT NULL,
              business_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              staff_id TEXT NOT NULL,
              staff_session_id TEXT NOT NULL,
              command_type TEXT NOT NULL,
              recorded_at TEXT NOT NULL,
              outcome TEXT NOT NULL
            )
        """.trimIndent())
    }

    private fun jsonArrayToStrings(value: String): List<String> {
        val array = JSONArray(value)
        return buildList { for (index in 0 until array.length()) add(array.getString(index)) }
    }

    private fun sameReceiptPrincipal(
        receipt: HubReceipt,
        command: OperationalCommand,
        context: VerifiedCommandContext
    ): Boolean = receipt.businessId == context.businessId &&
        receipt.branchId == context.branchId &&
        receipt.deviceId == context.deviceId &&
        receipt.staffSessionId == context.staffSessionId &&
        receipt.type == command.type &&
        receipt.sequence == command.sequence

    private fun validateBundleFacts(bundle: VerifiedAuthorizationBundle) {
        HubTime.requireCanonicalUtc(bundle.issuedAt, "Authorization bundle issuedAt")
        HubTime.requireCanonicalUtc(bundle.expiresAt, "Authorization bundle expiresAt")
        if (HubTime.isExpired(bundle.expiresAt, bundle.issuedAt)) {
            throw HubCommandRejectedException("The verified authorization bundle is already expired.")
        }
        val deviceIds = bundle.pairedDevices.map { it.deviceId }
        if (deviceIds.size != deviceIds.toSet().size || deviceIds.any { it.isBlank() }) {
            throw HubCommandRejectedException("The verified authorization bundle has invalid paired-device facts.")
        }
        if (bundle.pairedDevices.any { it.name.isBlank() || it.role.isBlank() || it.publicKeyBase64.isBlank() || it.connectionType.isBlank() }) {
            throw HubCommandRejectedException("The verified authorization bundle has incomplete paired-device facts.")
        }
        val sessionIds = bundle.staffSessions.map { it.sessionId }
        if (sessionIds.size != sessionIds.toSet().size || sessionIds.any { it.isBlank() }) {
            throw HubCommandRejectedException("The verified authorization bundle has invalid staff-session facts.")
        }
        if (bundle.staffSessions.any { session ->
                session.staffId.isBlank() || session.deviceId !in deviceIds || session.role.isBlank() || session.expiresAt.isBlank() || session.revocationVersion < 0
            }) {
            throw HubCommandRejectedException("The verified authorization bundle has incomplete or unpaired staff-session facts.")
        }
        bundle.staffSessions.forEach { session ->
            HubTime.requireCanonicalUtc(session.expiresAt, "Staff-session expiry")
            if (HubTime.isExpired(session.expiresAt, bundle.issuedAt)) {
                throw HubCommandRejectedException("The verified authorization bundle contains an already expired staff session.")
            }
        }
        val directoryIds = bundle.staffDirectory.map { it.staffId }
        if (directoryIds.size != directoryIds.toSet().size || directoryIds.any { it.isBlank() }) {
            throw HubCommandRejectedException("The verified authorization bundle has invalid staff-directory facts.")
        }
        if (bundle.staffDirectory.any { it.name.isBlank() || it.role !in setOf("CASHIER", "KITCHEN_STAFF", "MANAGER", "OWNER", "ADMINISTRATOR") }) {
            throw HubCommandRejectedException("The verified authorization bundle has incomplete staff-directory facts.")
        }
        if (bundle.staffSessions.any { it.staffId !in directoryIds }) {
            throw HubCommandRejectedException("The verified authorization bundle has a session outside its signed staff directory.")
        }
        if (!bundle.configuration.vatRate.isFinite() || bundle.configuration.vatRate < 0.0 || bundle.configuration.vatRate > 100.0) {
            throw HubCommandRejectedException("The verified authorization bundle has an invalid VAT configuration.")
        }
        val catalogIds = bundle.configuration.catalogProducts.map { it.productId }
        if (catalogIds.size != catalogIds.toSet().size || catalogIds.any { it.isBlank() }) {
            throw HubCommandRejectedException("The verified authorization bundle has duplicate or invalid catalog product IDs.")
        }
        if (bundle.configuration.catalogProducts.any { product ->
                product.name.isBlank() || product.category.isBlank() || product.unit.isBlank() ||
                    !product.price.isFinite() || product.price < 0.0 ||
                    !product.stockQuantity.isFinite() || product.stockQuantity < 0.0 ||
                    (product.branchId != null && product.branchId != bundle.branchId) ||
                    product.status !in setOf("ACTIVE", "ARCHIVED")
            }) {
            throw HubCommandRejectedException("The verified authorization bundle has an invalid branch catalog snapshot.")
        }
    }

    private fun ensureColumn(db: SQLiteDatabase, table: String, column: String, definition: String) {
        val exists = db.rawQuery("PRAGMA table_info($table)", emptyArray()).use { cursor ->
            var found = false
            while (cursor.moveToNext()) {
                if (cursor.getString(1) == column) {
                    found = true
                    break
                }
            }
            found
        }
        if (!exists) db.execSQL("ALTER TABLE $table ADD COLUMN $column $definition")
    }

    private data class StoredReceipt(
        val receipt: HubReceipt,
        val commandFingerprint: String
    )

    private companion object {
        const val DATABASE_NAME = "theplugos_cashier_hub_v1.db"
        const val MAX_CLOUD_BATCH_EVENTS = 100
        const val MAX_SYNC_ERROR_CHARS = 160
    }
}
