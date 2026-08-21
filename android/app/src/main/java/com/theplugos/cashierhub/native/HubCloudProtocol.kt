package com.theplugos.cashierhub.native

/** Exact UTF-8 line protocols shared with the cloud receiver contract. */
object HubCloudProtocol {
    fun enrollmentChallengeBytes(
        requestId: String,
        challengeId: String,
        nonceBase64url: String,
        hubSigningPublicKeyBase64: String,
        hubTlsCertificateSha256: String
    ): ByteArray = lineProtocol(
        "theplugos.enrollment.v1",
        requestId,
        challengeId,
        nonceBase64url,
        hubSigningPublicKeyBase64,
        hubTlsCertificateSha256
    )

    fun bundleRenewalBytes(
        requestId: String,
        hubDeviceId: String,
        bundleId: String,
        issuedAt: String
    ): ByteArray {
        HubTime.requireCanonicalUtc(issuedAt, "Bundle renewal issuedAt")
        return lineProtocol("theplugos.bundle-renewal.v1", requestId, hubDeviceId, bundleId, issuedAt)
    }

    fun staffSessionChallengeBytes(
        requestId: String,
        challengeId: String,
        nonceBase64url: String,
        hubDeviceId: String,
        staffId: String
    ): ByteArray = lineProtocol(
        "theplugos.staff-session.v1",
        requestId,
        challengeId,
        nonceBase64url,
        hubDeviceId,
        staffId
    )

    fun syncRequestBytes(
        requestId: String,
        hubDeviceId: String,
        bundleId: String,
        issuedAt: String,
        payloadBase64: String
    ): ByteArray {
        HubTime.requireCanonicalUtc(issuedAt, "Hub sync issuedAt")
        return lineProtocol("theplugos.sync.v1", requestId, hubDeviceId, bundleId, issuedAt, payloadBase64)
    }

    private fun lineProtocol(protocol: String, vararg fields: String): ByteArray {
        if (protocol.isBlank() || protocol.contains('\n') || protocol.contains('\r') ||
            fields.any { it.isBlank() || it.contains('\n') || it.contains('\r') }) {
            throw HubCommandRejectedException("Cloud protocol fields are incomplete or malformed.")
        }
        return (listOf(protocol) + fields).joinToString("\n").toByteArray(Charsets.UTF_8)
    }
}
