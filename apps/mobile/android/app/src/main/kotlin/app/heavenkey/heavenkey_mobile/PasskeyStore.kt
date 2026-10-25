package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.content.Context
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import co.nstant.`in`.cbor.CborBuilder
import co.nstant.`in`.cbor.CborEncoder
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.math.BigInteger
import java.nio.ByteBuffer
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.time.Instant
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object PasskeyProtocol {
    fun encode(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    fun decode(value: String, min: Int = 1, max: Int = 1024): ByteArray {
        require(value.length <= (max * 4 / 3 + 4) && Regex("^[A-Za-z0-9_-]+$").matches(value))
        return Base64.getUrlDecoder().decode(value).also {
            require(it.size in min..max && encode(it) == value)
        }
    }
    fun digest(value: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(value)
    fun rp(value: String): String {
        require(OriginPolicy.canonical("https://$value") == "https://$value")
        require(java.net.URI("https://$value").host == value && ':' !in value)
        return value
    }
    fun options(json: String, create: Boolean): JSONObject {
        require(json.length <= 65_536)
        val options = JSONObject(json)
        decode(options.getString("challenge"), 16, 1024)
        val rp = rp(if (create) options.getJSONObject("rp").getString("id") else options.getString("rpId"))
        require(rp.isNotEmpty())
        if (options.has("timeout")) require(options.getDouble("timeout").isFinite() && options.getDouble("timeout") > 0)
        val uv = if (create) options.optJSONObject("authenticatorSelection")?.optString("userVerification", "preferred")
            ?: "preferred" else options.optString("userVerification", "preferred")
        require(uv in setOf("required", "preferred", "discouraged"))
        // No authenticator extension is advertised or implemented; fail closed on requested extensions.
        require(!options.has("extensions") || options.getJSONObject("extensions").length() == 0) { "unsupported_extensions" }
        if (create) {
            val user = options.getJSONObject("user")
            decode(user.getString("id"), 1, 64)
            for (field in listOf("name", "displayName")) require(user.getString(field).let { it.isNotBlank() && it.length <= 320 && it.none(Char::isISOControl) })
            require(options.getJSONObject("rp").getString("name").length in 1..320)
            val params = options.getJSONArray("pubKeyCredParams")
            require(params.length() in 1..64 && (0 until params.length()).any {
                params.getJSONObject(it).optString("type") == "public-key" && params.getJSONObject(it).optInt("alg") == -7
            })
            require(options.optString("attestation", "none") == "none")
            val selection = options.optJSONObject("authenticatorSelection")
            require(selection?.optString("authenticatorAttachment", "platform") in setOf(null, "platform"))
            require(selection?.optString("residentKey", "preferred") in setOf(null, "required", "preferred", "discouraged"))
            descriptors(options, "excludeCredentials")
        } else descriptors(options, "allowCredentials")
        return options
    }
    fun descriptors(options: JSONObject, field: String): Set<String> {
        if (!options.has(field)) return emptySet()
        val values = options.getJSONArray(field)
        require(values.length() <= 500)
        return (0 until values.length()).map {
            val entry = values.getJSONObject(it)
            require(entry.getString("type") == "public-key")
            entry.getString("id").also { id -> decode(id, 1, 1024) }
        }.toSet()
    }
    fun authenticatorData(rpId: String, backedUp: Boolean, attested: ByteArray = byteArrayOf()): ByteArray =
        digest(rpId.toByteArray(Charsets.UTF_8)) + byteArrayOf((0x0d or (if (backedUp) 0x10 else 0) or
            (if (attested.isNotEmpty()) 0x40 else 0)).toByte()) + ByteArray(4) + attested
    fun sign(privateKey: java.security.PrivateKey, authData: ByteArray, clientDataHash: ByteArray): ByteArray {
        require(clientDataHash.size == 32)
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey); update(authData); update(clientDataHash); sign()
        }
    }
    private fun coordinate(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        require(value.signum() >= 0 && bytes.size <= 33)
        return bytes.takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
    }
    fun cose(publicKey: ECPublicKey): ByteArray = ByteArrayOutputStream().also { output ->
        CborEncoder(output).encode(CborBuilder().addMap().put(1L, 2L).put(3L, -7L)
            .put(-1L, 1L).put(-2L, coordinate(publicKey.w.affineX)).put(-3L, coordinate(publicKey.w.affineY)).end().build())
    }.toByteArray()
    fun attestation(authData: ByteArray): ByteArray = ByteArrayOutputStream().also { output ->
        CborEncoder(output).encode(CborBuilder().addMap().put("fmt", "none").put("authData", authData)
            .putMap("attStmt").end().end().build())
    }.toByteArray()
    fun response(id: String, response: JSONObject): String = JSONObject().put("id", id).put("rawId", id)
        .put("type", "public-key").put("authenticatorAttachment", "platform")
        .put("clientExtensionResults", JSONObject()).put("response", response).toString()
}

// Supplementary process-local deduplication; provider tickets are the authorization boundary.
// Expiry uses elapsed time. Process death invalidates both this window and all provider tickets.
internal object PasskeyReplayWindow {
    private const val WINDOW_MS = 120_000L
    private const val MAX_LIVE = 2000
    private val used = mutableMapOf<String, Long>()
    fun consume(id: String) = MobileStoreTransaction.run {
        val now = SystemClock.elapsedRealtime()
        used.entries.removeAll { it.value <= now }
        require(id !in used) { "replayed_request" }
        check(used.size < MAX_LIVE) { "passkey_replay_window_full" }
        used[id] = now + WINDOW_MS
    }
}

internal class PasskeyStore(private val context: Context, private val authentication: VaultStore? = null) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "heavenkey-passkeys-v1.aesgcm"))
    private val vault = VaultStore(context)
    private var expires = 0L
    private fun hasData(): Boolean = listOf("", ".bak", ".new").any { File(file.baseFile.path + it).exists() }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(ALIAS)) return store.getKey(ALIAS, null) as SecretKey
        check(!hasData()) { "passkey_key_missing" }
        check(vault.secureDevice()) { "device_not_secure" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true).setUserAuthenticationParameters(60,
                    KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL).build())
        }.generateKey()
    }
    fun authenticate(activity: Activity, complete: (String?) -> Unit) {
        try { key() } catch (_: Exception) { complete("passkey_store_unavailable"); return }
        vault.authenticate(activity) { error ->
            expires = if (error == null) SystemClock.elapsedRealtime() + 55_000 else 0
            complete(error)
        }
    }
    fun lock() { expires = 0; vault.lock() }
    private fun authorized() {
        if (authentication != null) authentication.read()
        else check(expires > SystemClock.elapsedRealtime()) { "locked" }
    }
    private fun empty() = JSONObject().put("version", 1).put("records", JSONArray()).put("used", JSONArray()).put("backedUpIds", JSONArray())
    private fun read(): JSONObject {
        authorized()
        if (!hasData()) return empty()
        require(file.baseFile.length() <= MAX_FILE)
        val envelope = JSONObject(String(file.readFully(), Charsets.UTF_8))
        require(envelope.getInt("version") == 1)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val iv = PasskeyProtocol.decode(envelope.getString("iv"), 12, 12)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv)); cipher.updateAAD(AAD)
        val plain = cipher.doFinal(PasskeyProtocol.decode(envelope.getString("ciphertext"), 16, MAX_FILE))
        val data = try { JSONObject(String(plain, Charsets.UTF_8)) } finally { plain.fill(0) }
        require(data.getInt("version") == 1 && data.getJSONArray("records").length() <= 500 && data.getJSONArray("used").length() <= 2000)
        return data
    }
    private fun write(data: JSONObject) {
        authorized()
        val plain = data.toString().toByteArray(Charsets.UTF_8)
        require(plain.size <= MAX_FILE / 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(AAD)
        val encrypted = try { cipher.doFinal(plain) } finally { plain.fill(0) }
        val payload = JSONObject().put("version", 1).put("iv", PasskeyProtocol.encode(cipher.iv))
            .put("ciphertext", PasskeyProtocol.encode(encrypted)).toString().toByteArray(Charsets.UTF_8)
        val out = file.startWrite()
        try { out.write(payload); file.finishWrite(out) } catch (error: Exception) { file.failWrite(out); throw error }
    }
    fun metadata(): List<JSONObject> = MobileStoreTransaction.run { records(read()).map { record -> JSONObject().apply {
        for (field in listOf("id", "rpId", "userName", "userDisplayName", "createdAt")) put(field, record.get(field))
    } } }
    fun exportRecords(): List<JSONObject> = MobileStoreTransaction.run { records(read()).map { JSONObject(it.toString()) } }
    fun previewRestore(incoming: List<JSONObject>): List<JSONObject> = MobileStoreTransaction.run {
        require(incoming.size <= 500)
        incoming.forEach(::validateRecord)
        require(incoming.map { it.getString("id") }.toSet().size == incoming.size)
        val current = records(read()).associateBy { it.getString("id") }.toMutableMap()
        for (record in incoming) {
            val old = current[record.getString("id")]
            if (old != null) require(listOf("rpId", "userHandle", "publicKey", "privateKey").all { old.getString(it) == record.getString(it) })
            else current[record.getString("id")] = record
        }
        require(current.size <= 500)
        // Include the serialization overhead before either file can be changed during restoration.
        require(JSONArray(current.values.toList()).toString().toByteArray(Charsets.UTF_8).size < MAX_FILE / 2 - 100_000)
        current.values.toList()
    }
    fun restoreRecords(incoming: List<JSONObject>) = MobileStoreTransaction.run {
        val next = previewRestore(incoming)
        val data = read()
        val backedUp = data.optJSONArray("backedUpIds") ?: JSONArray()
        val ids = (0 until backedUp.length()).map { backedUp.getString(it) }.toMutableSet()
        ids.retainAll(next.map { it.getString("id") }.toSet())
        ids.addAll(incoming.map { it.getString("id") })
        data.put("records", JSONArray(next)).put("backedUpIds", JSONArray(ids.toList()))
        write(data)
    }
    fun replaceRecords(incoming: List<JSONObject>) = MobileStoreTransaction.run {
        require(incoming.size <= 500)
        incoming.forEach(::validateRecord)
        require(incoming.map { it.getString("id") }.toSet().size == incoming.size)
        val data = read()
        val existing = records(data).associateBy { it.getString("id") }
        for (record in incoming) {
            val old = existing[record.getString("id")]
            if (old != null) require(listOf("rpId", "userHandle", "publicKey", "privateKey").all { old.getString(it) == record.getString(it) })
        }
        data.put("records", JSONArray(incoming.map { JSONObject(it.toString()) }))
        data.put("backedUpIds", JSONArray(incoming.map { it.getString("id") }))
        write(data)
    }
    fun delete(id: String) = MobileStoreTransaction.run {
        val data = read(); data.put("records", JSONArray(records(data).filterNot { it.getString("id") == id })); write(data)
    }
    private fun records(data: JSONObject): List<JSONObject> {
        val array = data.getJSONArray("records")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }
    private fun consume(data: JSONObject, replayId: String) {
        PasskeyReplayWindow.consume(replayId)
        // Retire lifetime-history records from v1 files; fresh requests require fresh provider tickets.
        data.put("used", JSONArray())
    }
    fun create(options: JSONObject, clientDataHash: ByteArray, replayId: String): String = MobileStoreTransaction.run {
        require(clientDataHash.size == 32)
        val data = read(); val records = records(data)
        val rp = options.getJSONObject("rp").getString("id")
        val excluded = PasskeyProtocol.descriptors(options, "excludeCredentials")
        require(records.none { it.getString("rpId") == rp && it.getString("id") in excluded }) { "credential_excluded" }
        require(records.size < 500)
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val idBytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val id = PasskeyProtocol.encode(idBytes)
        val user = options.getJSONObject("user")
        val record = JSONObject().put("id", id).put("rpId", rp).put("userHandle", user.getString("id"))
            .put("userName", user.getString("name")).put("userDisplayName", user.getString("displayName"))
            .put("privateKey", PasskeyProtocol.encode(pair.private.encoded)).put("publicKey", PasskeyProtocol.encode(pair.public.encoded))
            .put("createdAt", Instant.now().toString())
        val attested = ByteArray(16) + ByteBuffer.allocate(2).putShort(idBytes.size.toShort()).array() + idBytes + PasskeyProtocol.cose(pair.public as ECPublicKey)
        val authData = PasskeyProtocol.authenticatorData(rp, false, attested)
        consume(data, replayId); data.getJSONArray("records").put(record); write(data)
        PasskeyProtocol.response(id, JSONObject().put("clientDataJSON", "").put("attestationObject", PasskeyProtocol.encode(PasskeyProtocol.attestation(authData)))
            .put("authenticatorData", PasskeyProtocol.encode(authData)).put("publicKey", PasskeyProtocol.encode(pair.public.encoded))
            .put("publicKeyAlgorithm", -7).put("transports", JSONArray(listOf("internal"))))
    }
    fun assertion(id: String, options: JSONObject, clientDataHash: ByteArray, replayId: String): String = MobileStoreTransaction.run {
        require(clientDataHash.size == 32)
        val data = read()
        val record = records(data).single { it.getString("id") == id }
        validateRecord(record)
        require(record.getString("rpId") == options.getString("rpId"))
        val allowed = PasskeyProtocol.descriptors(options, "allowCredentials")
        require(allowed.isEmpty() || id in allowed)
        val backedUpIds = data.optJSONArray("backedUpIds") ?: JSONArray()
        val backedUp = (0 until backedUpIds.length()).any { backedUpIds.getString(it) == id }
        val authData = PasskeyProtocol.authenticatorData(record.getString("rpId"), backedUp)
        val bytes = PasskeyProtocol.decode(record.getString("privateKey"), 1, 2048)
        val signature = try { PasskeyProtocol.sign(KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(bytes)), authData, clientDataHash) }
            finally { bytes.fill(0) }
        consume(data, replayId); write(data)
        PasskeyProtocol.response(id, JSONObject().put("clientDataJSON", "").put("authenticatorData", PasskeyProtocol.encode(authData))
            .put("signature", PasskeyProtocol.encode(signature)).put("userHandle", record.getString("userHandle")))
    }
    companion object {
        private const val ALIAS = "heavenkey-passkeys-v1"
        private const val MAX_FILE = 4 * 1024 * 1024
        private val AAD = "HeavenKey/passkeys/v1".toByteArray(Charsets.UTF_8)
        fun validateRecord(record: JSONObject) {
            require(record.length() == 8)
            PasskeyProtocol.decode(record.getString("id"), 32, 32)
            PasskeyProtocol.rp(record.getString("rpId"))
            PasskeyProtocol.decode(record.getString("userHandle"), 1, 64)
            for (field in listOf("userName", "userDisplayName")) require(record.getString(field).let { it.isNotBlank() && it.length <= 320 && it.none(Char::isISOControl) })
            Instant.parse(record.getString("createdAt"))
            val factory = KeyFactory.getInstance("EC")
            val bytes = PasskeyProtocol.decode(record.getString("privateKey"), 1, 2048)
            val privateKey = try { factory.generatePrivate(PKCS8EncodedKeySpec(bytes)) as ECPrivateKey } finally { bytes.fill(0) }
            val publicKey = factory.generatePublic(X509EncodedKeySpec(PasskeyProtocol.decode(record.getString("publicKey"), 1, 2048))) as ECPublicKey
            val expected = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair().public as ECPublicKey
            require(privateKey.params.order == expected.params.order && publicKey.params.order == expected.params.order && publicKey.params.curve == expected.params.curve)
            val challenge = ByteArray(32).also { SecureRandom().nextBytes(it) }
            val signed = PasskeyProtocol.sign(privateKey, challenge, challenge)
            require(Signature.getInstance("SHA256withECDSA").run { initVerify(publicKey); update(challenge); update(challenge); verify(signed) })
        }
    }
}
