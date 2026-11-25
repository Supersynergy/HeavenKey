package app.heavenkey.heavenkey_mobile

import com.nimbusds.jose.jwk.Curve
import com.nimbusds.jose.jwk.ECKey
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URI
import java.net.URLEncoder
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory

internal class WalletFailure(val code: String) : Exception(code)

internal fun walletCheck(condition: Boolean, code: String = "invalid_request") {
    if (!condition) throw WalletFailure(code)
}

internal fun JSONObject.walletString(key: String): String = get(key) as? String
    ?: throw WalletFailure("invalid_request")

internal fun JSONObject.walletNumber(key: String): Long = when (val value = get(key)) {
    is Int -> value.toLong()
    is Long -> value
    else -> throw WalletFailure("invalid_request")
}

internal fun JSONObject.onlyKeys(vararg expected: String) {
    walletCheck(keys().asSequence().toSet() == expected.toSet())
}

internal fun InputStream.readWalletBody(limit: Int): ByteArray {
    val result = ByteArrayOutputStream()
    val buffer = ByteArray(4096)
    while (true) {
        val read = read(buffer)
        if (read < 0) return result.toByteArray()
        walletCheck(result.size() + read <= limit, "wallet_body_too_large")
        result.write(buffer, 0, read)
    }
}

internal const val WALLET_VCT = "https://heavenkey.app/credentials/membership/v1"
internal const val MEMBERSHIP_CONFIG = "membership"
internal const val PREAUTHORIZED = "urn:ietf:params:oauth:grant-type:pre-authorized_code"
internal const val WALLET_ORG = "supersynergy-demo"
internal const val WALLET_MEMBERSHIP = "project-member"
internal val walletId = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
internal val walletSecret = Regex("[A-Za-z0-9_-]{20,128}")
private val walletClientId = Regex("[A-Za-z0-9._-]{1,128}")

internal data class WalletLink(val id: String, val issuance: Boolean) {
    val path: String get() = if (issuance) "/offer/$id" else "/request/$id"
}

internal class WalletProfile private constructor(
    val origin: String,
    val verifierClientId: String,
    val issuerKey: ECKey,
    val verifierKey: ECKey,
    tlsCa: String?,
) {
    private val sslSocketFactory = tlsCa?.let { pem ->
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(pem.byteInputStream(Charsets.US_ASCII))
        val anchors = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setCertificateEntry("heavenkey-wallet-fixture", certificate)
        }
        val managers = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
            init(anchors)
        }
        SSLContext.getInstance("TLS").apply { init(null, managers.trustManagers, null) }.socketFactory
    }

    fun parseLink(text: String): WalletLink {
        walletCheck(text.length <= 2048)
        val link = URI(text)
        walletCheck(!link.isOpaque && link.rawFragment == null)
        val issuance = when (link.scheme) {
            "openid-credential-offer" -> {
                walletCheck(link.rawAuthority == null && link.rawPath.isNullOrEmpty())
                true
            }
            "openid4vp" -> {
                walletCheck(link.rawAuthority == "authorize" && link.rawPath.isNullOrEmpty())
                false
            }
            else -> throw WalletFailure("invalid_request")
        }
        val pairs = link.rawQuery.orEmpty().split("&").map {
            val pair = it.split("=", limit = 2)
            walletCheck(pair.size == 2)
            pair[0] to java.net.URLDecoder.decode(pair[1], "UTF-8")
        }
        val query = pairs.toMap()
        walletCheck(query.size == pairs.size)
        if (!issuance) walletCheck(query["client_id"] == verifierClientId)
        val key = if (issuance) "credential_offer_uri" else "request_uri"
        walletCheck(query.keys == if (issuance) setOf(key) else setOf("client_id", key))
        val prefix = origin + if (issuance) "/offer/" else "/request/"
        val endpoint = query.getValue(key)
        walletCheck(endpoint.startsWith(prefix))
        val id = endpoint.removePrefix(prefix)
        walletCheck(walletId.matches(id))
        return WalletLink(id, issuance)
    }

    fun request(
        path: String,
        expectedType: String = "application/json",
        body: String? = null,
        contentType: String = "application/json",
        accessToken: String? = null,
        beforeSend: () -> Unit,
    ): String {
        val url = URI(origin + path)
        walletCheck(url.toString() == origin + path && path.startsWith("/") && !path.startsWith("//") &&
            url.rawQuery == null && url.rawFragment == null && url.normalize() == url)
        beforeSend()
        val connection = url.toURL().openConnection(java.net.Proxy.NO_PROXY) as HttpsURLConnection
        sslSocketFactory?.let { connection.sslSocketFactory = it }
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.connectTimeout = 5_000
        connection.readTimeout = 5_000
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12)
        connection.setRequestProperty("Accept", expectedType)
        connection.setRequestProperty("Cache-Control", "no-store")
        if (accessToken != null) connection.setRequestProperty("Authorization", "Bearer $accessToken")
        return try {
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                walletCheck(bytes.size <= 128 * 1024)
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", contentType)
                connection.setFixedLengthStreamingMode(bytes.size)
                beforeSend()
                connection.outputStream.use { stream -> beforeSend(); stream.write(bytes) }
            }
            beforeSend()
            walletCheck(connection.responseCode == 200, "wallet_endpoint_rejected")
            walletCheck(connection.contentType?.substringBefore(';')?.trim() == expectedType, "invalid_response")
            walletCheck(connection.contentLengthLong <= 128L * 1024, "wallet_body_too_large")
            connection.inputStream.use { stream ->
                val result = ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    beforeSend()
                    walletCheck(System.nanoTime() - deadline < 0L, "wallet_timeout")
                    val read = stream.read(buffer)
                    if (read < 0) break
                    walletCheck(result.size() + read <= 128 * 1024, "wallet_body_too_large")
                    result.write(buffer, 0, read)
                }
                return@use result.toString("UTF-8")
            }
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        fun load(): WalletProfile? = BuildConfig.WALLET_PROFILE_BASE64.takeIf(String::isNotEmpty)?.let {
            parse(java.util.Base64.getDecoder().decode(it).toString(Charsets.UTF_8))
        }

        fun parse(text: String): WalletProfile {
            val profile = JSONObject(text)
            val fields = setOf("origin", "verifierClientId", "issuerJwk", "verifierJwk")
            walletCheck(profile.keys().asSequence().toSet() in setOf(fields, fields + "tlsCa"))
            val origin = profile.walletString("origin")
            val url = URI(origin)
            walletCheck(url.scheme == "https" && url.host != null && url.userInfo == null &&
                url.rawPath.isNullOrEmpty() && url.rawQuery == null && url.rawFragment == null &&
                (url.port == -1 || url.port in 1..65535))
            val client = profile.walletString("verifierClientId")
            walletCheck(walletClientId.matches(client))
            fun key(name: String): ECKey {
                val jwk = ECKey.parse(profile.getJSONObject(name).toString())
                walletCheck(jwk.curve == Curve.P_256 && !jwk.isPrivate)
                return jwk
            }
            val issuer = key("issuerJwk")
            val verifier = key("verifierJwk")
            walletCheck(issuer.computeThumbprint() != verifier.computeThumbprint())
            return WalletProfile(origin, client, issuer, verifier, profile.optString("tlsCa").ifEmpty { null })
        }
    }
}

internal fun walletForm(vararg entries: Pair<String, String>): String =
    entries.joinToString("&") { (key, value) -> "$key=${URLEncoder.encode(value, "UTF-8")}" }
