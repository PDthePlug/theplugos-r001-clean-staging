package com.theplugos.cashierhub.native

import com.theplugos.cashierhub.BuildConfig
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.URL
import java.util.UUID
import javax.net.ssl.HttpsURLConnection

/**
 * Native-only client for enrollment, signed bundle renewal, and fresh staff
 * sessions. It intentionally has no Capacitor-facing method that accepts a
 * pairing code or PIN; callers are native Android activities/services only.
 */
class HubCloudAuthorityClient(
    private val runtime: CashierHubRuntime,
    private val coordinator: HubEnrollmentCoordinator = HubEnrollmentCoordinator(runtime)
) {
    fun enrollCashierHub(pairingCode: CharArray, hubName: String = "Cashier Hub"): EnrollmentInstallResult {
        return try {
            requireNoPendingEventsForAuthorityChange()
            val proof = runtime.enrollmentProof()
            val requestId = UUID.randomUUID().toString()
            val begin = post("hub-enrollment", JSONObject()
                .put("action", "begin")
                .put("pairingCode", String(pairingCode))
                .put("requestId", requestId)
                .put("hubDeviceId", stableDeviceId())
                .put("hubName", hubName.trim().ifBlank { "Cashier Hub" })
                .put("signingPublicKeyBase64", proof.signingPublicKeyBase64)
                .put("tlsCertificateBase64", proof.tlsCertificateBase64)
                .put("tlsCertificateSha256", proof.tlsCertificateSha256)
            )
            pairingCode.fill('\u0000')
            val challengeId = begin.requiredString("challengeId")
            val nonce = begin.requiredString("nonce")
            val signedProof = runtime.signCloudProtocol(
                HubCloudProtocol.enrollmentChallengeBytes(
                    requestId, challengeId, nonce,
                    proof.signingPublicKeyBase64, proof.tlsCertificateSha256
                )
            )
            val complete = post("hub-enrollment", JSONObject()
                .put("action", "complete")
                .put("requestId", requestId)
                .put("challengeId", challengeId)
                .put("nonce", nonce)
                .put("hubDeviceId", stableDeviceId())
                .put("signingPublicKeyBase64", proof.signingPublicKeyBase64)
                .put("tlsCertificateSha256", proof.tlsCertificateSha256)
                .put("signature", signedProof)
            )
            coordinator.installSignedBundle(complete.requiredObject("envelope"))
        } catch (error: IllegalStateException) {
            pairingCode.fill('\u0000')
            EnrollmentInstallResult(installed = false, error = error.message ?: "Hub enrollment could not be completed.")
        } catch (_: Exception) {
            pairingCode.fill('\u0000')
            EnrollmentInstallResult(installed = false, error = "Hub enrollment could not be completed.")
        }
    }

    fun renewAuthorizationBundle(): EnrollmentInstallResult {
        return try {
            requireNoPendingEventsForAuthorityChange()
            val active = runtime.activeAuthorizationBundleForCloud()
                ?: throw HubUnavailableException("This Hub is not enrolled.")
            val requestId = UUID.randomUUID().toString()
            val issuedAt = HubClock.now()
            val signature = runtime.signCloudProtocol(
                HubCloudProtocol.bundleRenewalBytes(requestId, active.hubDeviceId, active.bundleId, issuedAt)
            )
            val response = post("hub-enrollment", JSONObject()
                .put("action", "renew")
                .put("requestId", requestId)
                .put("hubDeviceId", active.hubDeviceId)
                .put("bundleId", active.bundleId)
                .put("issuedAt", issuedAt)
                .put("signature", signature)
            )
            coordinator.installSignedBundle(response.requiredObject("envelope"))
        } catch (error: IllegalStateException) {
            EnrollmentInstallResult(installed = false, error = error.message ?: "Hub authorization renewal failed.")
        } catch (_: Exception) {
            EnrollmentInstallResult(installed = false, error = "Hub authorization renewal failed.")
        }
    }

    fun startNativeStaffSession(staffId: String, pin: CharArray): EnrollmentInstallResult {
        return try {
            requireNoPendingEventsForAuthorityChange()
            val active = runtime.activeAuthorizationBundleForCloud()
                ?: throw HubUnavailableException("This Hub is not enrolled.")
            val requestId = UUID.randomUUID().toString()
            val begin = post("hub-staff-session", JSONObject()
                .put("action", "begin")
                .put("requestId", requestId)
                .put("hubDeviceId", active.hubDeviceId)
                .put("staffId", staffId)
            )
            val challengeId = begin.requiredString("challengeId")
            val nonce = begin.requiredString("nonce")
            val signature = runtime.signCloudProtocol(
                HubCloudProtocol.staffSessionChallengeBytes(
                    requestId, challengeId, nonce, active.hubDeviceId, staffId
                )
            )
            val complete = post("hub-staff-session", JSONObject()
                .put("action", "complete")
                .put("requestId", requestId)
                .put("challengeId", challengeId)
                .put("nonce", nonce)
                .put("hubDeviceId", active.hubDeviceId)
                .put("staffId", staffId)
                .put("signature", signature)
                .put("pin", String(pin))
            )
            pin.fill('\u0000')
            val activeStaffSessionId = complete.requiredString("activeStaffSessionId")
            val installed = coordinator.installSignedBundle(complete.requiredObject("envelope"))
            if (installed.installed) runtime.activateNativeStaffSession(activeStaffSessionId)
            installed
        } catch (error: IllegalStateException) {
            pin.fill('\u0000')
            EnrollmentInstallResult(installed = false, error = error.message ?: "Native staff sign-in failed.")
        } catch (_: Exception) {
            pin.fill('\u0000')
            EnrollmentInstallResult(installed = false, error = "Native staff sign-in failed.")
        }
    }

    fun isConfigured(): Boolean = BuildConfig.HUB_CLOUD_FUNCTIONS_BASE_URL.trim().startsWith("https://")

    private fun requireNoPendingEventsForAuthorityChange() {
        if (runtime.hasPendingOperationalOutboxForAuthorityChange()) {
            throw HubUnavailableException(
                "DEFERRED_UNTIL_SYNC: Cloud acknowledgement is required before replacing Hub authority or starting a fresh staff session."
            )
        }
    }

    private fun stableDeviceId(): String {
        val active = runtime.activeAuthorizationBundleForCloud()
        return active?.hubDeviceId ?: runtime.hubDeviceIdForCloud()
    }

    private fun post(functionName: String, body: JSONObject): JSONObject {
        val base = BuildConfig.HUB_CLOUD_FUNCTIONS_BASE_URL.trim().removeSuffix("/")
        if (!base.startsWith("https://")) throw HubUnavailableException("The Hub cloud receiver is not configured.")
        val connection = (URL("$base/$functionName").openConnection() as? HttpsURLConnection)
            ?: throw HubUnavailableException("The Hub cloud receiver is unavailable.")
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            OutputStreamWriter(connection.outputStream, Charsets.UTF_8).use { output ->
                output.write(body.toString())
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val response = stream?.let(::readBounded) ?: ""
            if (status !in 200..299) {
                throw HubUnavailableException("The Hub cloud receiver rejected the request.")
            }
            val parsed = try { JSONObject(response) } catch (_: Exception) {
                throw HubUnavailableException("The Hub cloud receiver returned an invalid response.")
            }
            if (!parsed.optBoolean("ok", false)) throw HubUnavailableException("The Hub cloud receiver rejected the request.")
            return parsed
        } finally {
            connection.disconnect()
        }
    }

    /**
     * A receiver is untrusted until the response has passed all protocol
     * checks.  Do not use Reader.readText(): it can allocate an unbounded
     * response before the size check runs.
     */
    private fun readBounded(stream: java.io.InputStream): String = stream.bufferedReader(Charsets.UTF_8).use { reader ->
        val buffer = CharArray(4096)
        val output = StringBuilder()
        while (true) {
            val count = reader.read(buffer)
            if (count < 0) break
            if (output.length + count > MAX_RESPONSE_CHARS) {
                throw HubUnavailableException("The Hub cloud receiver response is too large.")
            }
            output.append(buffer, 0, count)
        }
        output.toString()
    }

    private companion object {
        const val CONNECT_TIMEOUT_MS = 10_000
        const val READ_TIMEOUT_MS = 20_000
        const val MAX_RESPONSE_CHARS = 128 * 1024
    }
}

private object HubClock {
    fun now(): String = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).apply {
        timeZone = java.util.TimeZone.getTimeZone("UTC")
    }.format(java.util.Date())
}

private fun JSONObject.requiredString(name: String): String {
    val value = optString(name, "").trim()
    if (value.isEmpty()) throw HubUnavailableException("The Hub cloud receiver returned an incomplete response.")
    return value
}

private fun JSONObject.requiredObject(name: String): JSONObject = optJSONObject(name)
    ?: throw HubUnavailableException("The Hub cloud receiver returned an incomplete response.")
