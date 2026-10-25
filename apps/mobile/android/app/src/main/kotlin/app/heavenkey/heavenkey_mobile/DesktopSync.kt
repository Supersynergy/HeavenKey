package app.heavenkey.heavenkey_mobile

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.net.URL
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

internal class DesktopSync(context: Context, private val vault: VaultStore) {
    private val passkeys = PasskeyStore(context, vault)
    fun status(): Map<String, Any> {
        vault.read()
        val state = vault.readSyncState()
        val conflict = state?.optJSONObject("conflict")
        return mapOf("connected" to (state != null), "pending" to (state?.has("code") == true), "endpoint" to (state?.getString("endpoint") ?: ""),
            "conflict" to if (conflict == null) emptyMap<String, Any>() else mapOf("token" to conflict.getString("token"),
                "entries" to rows(conflict.getJSONArray("entries")).map { row -> mapOf("id" to row.getString("id"), "title" to row.getString("title")) }),
            "revision" to (state?.optLong("revision", 0) ?: 0), "passkeys" to passkeys.metadata().map { row ->
                row.keys().asSequence().associateWith { row.getString(it) }
            })
    }
    fun disconnect() { vault.writeSyncState(null) }
    fun deletePasskey(id: String) { passkeys.delete(id) }
    fun connect(code: String): Map<String, Any> = exclusive {
        vault.read()
        if (vault.readSyncState() != null) throw VaultFailure("sync_already_connected")
        if (!code.startsWith("hks1_") || code.length > 8192) throw VaultFailure("invalid_sync_pairing")
        val state = try { JSONObject(String(decode(code.substring(5), 6000), Charsets.UTF_8)) }
            catch (_: Exception) { throw VaultFailure("invalid_sync_pairing") }
        if (state.length() != 7 || state.getInt("version") != 1 || state.getInt("expires_in") != 120 ||
            !Regex("^[0-9a-f-]{36}$").matches(state.getString("id")) ||
            decode(state.getString("key"), 32).size != 32 || decode(state.getString("code"), 32).size != 32 ||
            decode(state.getString("certificate_sha256"), 32).size != 32) throw VaultFailure("invalid_sync_pairing")
        endpoint(state)
        state.remove("expires_in")
        state.put("token", encode(ByteArray(32).also { SecureRandom().nextBytes(it) })).put("baseline", empty()).put("revision", 0)
        vault.read()
        // Persist the client-generated credential before redemption, including interrupted first exchanges.
        vault.writeSyncState(state)
        synchronize(state)
    }
    fun synchronize(resolution: String? = null, conflictToken: String? = null): Map<String, Any> = exclusive {
        synchronize(vault.readSyncState() ?: throw VaultFailure("sync_not_connected"), resolution, conflictToken)
    }
    private fun synchronize(state: JSONObject, resolution: String? = null, conflictToken: String? = null): Map<String, Any> {
        if (state.has("code")) {
            val pairingFingerprint = canonical(state)
            try { request(state, "/sync/v1/connect", JSONObject().put("id", state.getString("id")).put("code", state.getString("code")).put("token", state.getString("token"))) }
            catch (failure: VaultFailure) {
                if (failure.code != "sync_denied") throw failure
                // The first response may have been lost after the server consumed the one-time code.
                request(state, "/sync/v1/snapshot", JSONObject().put("id", state.getString("id")))
            }
            MobileStoreTransaction.run {
                if (canonical(vault.readSyncState()) != pairingFingerprint) throw VaultFailure("vault_changed")
                state.remove("code"); vault.writeSyncState(state)
            }
        }
        val stateFingerprint = canonical(state)
        val (nativeBefore, keysBefore) = MobileStoreTransaction.run {
            if (canonical(vault.readSyncState()) != stateFingerprint) throw VaultFailure("vault_changed")
            vault.read() to passkeys.exportRecords()
        }
        val fingerprint = MobileBackup.fingerprint(nativeBefore) + canonical(JSONArray(keysBefore))
        val baseline = state.getJSONObject("baseline")
        val local = localSnapshot(baseline, nativeBefore, keysBefore)
        val remote = request(state, "/sync/v1/snapshot", JSONObject().put("id", state.getString("id")))
        val revision = remote.getLong("revision")
        if (revision < 1 || revision < state.getLong("revision") || revision >= 9_007_199_254_740_990) throw VaultFailure("sync_rollback")
        val opened = open(remote.getJSONObject("record"), state, revision)
        val actualToken = encode(MessageDigest.getInstance("SHA-256").digest(
            ("$revision\u0000" + canonical(baseline) + "\u0000" + canonical(local) + "\u0000" + canonical(opened)).toByteArray(Charsets.UTF_8)))
        fun rememberConflict() = MobileStoreTransaction.run {
            if (canonical(vault.readSyncState()) != stateFingerprint) throw VaultFailure("vault_changed")
            state.put("conflict", JSONObject().put("token", actualToken).put("entries", JSONArray(conflicts(baseline, local, opened))))
            vault.writeSyncState(state)
        }
        if (resolution != null && (resolution !in listOf("local", "remote") || conflictToken != actualToken ||
                state.optJSONObject("conflict")?.optString("token") != actualToken)) {
            rememberConflict(); throw VaultFailure("sync_conflict_changed")
        }
        val merged = try { merge(baseline, local, opened, resolution) }
            catch (failure: VaultFailure) { if (failure.code == "sync_conflict") rememberConflict(); throw failure }
        val output = seal(merged, state, revision + 1)
        if (fingerprint != MobileBackup.fingerprint(vault.read()) + canonical(JSONArray(passkeys.exportRecords()))) throw VaultFailure("vault_changed")
        request(state, "/sync/v1/snapshot", JSONObject().put("id", state.getString("id")).put("expected_revision", revision).put("record", output))
        val nextEntries = MobileStoreTransaction.run {
            if (canonical(vault.readSyncState()) != stateFingerprint) throw VaultFailure("vault_changed")
            if (fingerprint != MobileBackup.fingerprint(vault.read()) + canonical(JSONArray(passkeys.exportRecords()))) throw VaultFailure("vault_changed")
            val priorById = nativeBefore.associateBy { it.getString("id") }
            val nextEntries = rows(merged.getJSONArray("entries")).mapNotNull(::mobile).map { entry ->
                val prior = priorById[entry.getString("id")]
                if (prior != null && listOf("id", "title", "origin", "username", "password", "notes").all { prior.getString(it) == entry.getString(it) }) prior else entry
            }
            val nextKeys = rows(merged.getJSONArray("passkeys"))
            nextKeys.forEach(PasskeyStore::validateRecord)
            if (nextEntries.size > 500) throw VaultFailure("vault_full")
            // Individual AtomicFiles are durable; baseline advances last. A partial file failure retains
            // the old baseline so retry merges the already-applied subset or reports an explicit conflict.
            passkeys.replaceRecords(nextKeys)
            if (MobileBackup.fingerprint(nextEntries) != MobileBackup.fingerprint(nativeBefore)) vault.replaceEntries(nextEntries)
            state.remove("conflict")
            state.put("baseline", merged).put("revision", revision + 1)
            vault.writeSyncState(state)
            nextEntries
        }
        return status() + mapOf("entries" to nextEntries.map { row -> row.keys().asSequence().associateWith { row.getString(it) } },
            "unsupported" to merged.getJSONArray("entries").length() - nextEntries.size)
    }
    private fun localSnapshot(baseline: JSONObject, current: List<JSONObject>, keys: List<JSONObject>): JSONObject {
        validate(baseline)
        val remaining = current.associateBy { it.getString("id") }.toMutableMap()
        val values = mutableListOf<JSONObject>()
        for (base in rows(baseline.getJSONArray("entries"))) {
            val original = mobile(base)
            if (original == null) { values.add(base); continue }
            val entry = remaining.remove(base.getString("id")) ?: continue
            val next = JSONObject(base.toString())
            for ((local, remote) in listOf("title" to "title", "username" to "username", "password" to "password", "notes" to "notes")) next.put(remote, entry.getString(local))
            if (entry.getString("origin") != original.getString("origin")) next.put("url", entry.getString("origin"))
            values.add(next)
        }
        for (entry in remaining.values) values.add(JSONObject().put("id", entry.getString("id")).put("title", entry.getString("title"))
            .put("username", entry.getString("username")).put("password", entry.getString("password")).put("url", entry.getString("origin"))
            .put("notes", entry.getString("notes")).put("totp", "").put("tags", JSONArray()).put("favorite", false))
        return JSONObject().put("version", 1).put("entries", JSONArray(values)).put("passkeys", JSONArray(keys))
    }
    private fun endpoint(state: JSONObject): URL {
        val uri = URI(state.getString("endpoint"))
        if (uri.scheme != "https" || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null ||
            !uri.rawPath.isNullOrEmpty() || uri.port !in 1..65535 || uri.rawAuthority.contains('%')) throw VaultFailure("invalid_sync_pairing")
        return uri.toURL()
    }
    private fun request(state: JSONObject, path: String, data: JSONObject): JSONObject {
        val base = endpoint(state)
        val expected = decode(state.getString("certificate_sha256"), 32)
        val trust = object: X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw java.security.cert.CertificateException("client certificates unsupported") }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                if (chain.size != 1 || !MessageDigest.isEqual(expected, MessageDigest.getInstance("SHA-256").digest(chain[0].encoded))) throw java.security.cert.CertificateException("sync certificate mismatch")
                chain[0].checkValidity()
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf<TrustManager>(trust), SecureRandom()) }
        val connection = URL(base.toString() + path).openConnection() as HttpsURLConnection
        try {
            connection.sslSocketFactory = ssl.socketFactory
            connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { host, _ -> host == base.host }
            connection.connectTimeout = 5000; connection.readTimeout = 8000; connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"; connection.doOutput = true; connection.useCaches = false
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("X-HeavenKey-Client", "mobile-sync")
            if (state.has("token")) connection.setRequestProperty("Authorization", "Bearer " + state.getString("token"))
            val bytes = data.toString().toByteArray(Charsets.UTF_8)
            if (bytes.size > 2 * 1024 * 1024) throw VaultFailure("vault_full")
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.outputStream.use { it.write(bytes) }
            if (connection.responseCode == 409) throw VaultFailure("sync_conflict")
            if (connection.responseCode != 200) throw VaultFailure("sync_denied")
            val response = connection.inputStream.use { input ->
                val output = ByteArrayOutputStream(); val buffer = ByteArray(16 * 1024)
                while (output.size() <= 2 * 1024 * 1024) {
                    val count = input.read(buffer, 0, minOf(buffer.size, 2 * 1024 * 1024 + 1 - output.size()))
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            if (response.size > 2 * 1024 * 1024) throw VaultFailure("sync_failed")
            return JSONObject(String(response, Charsets.UTF_8))
        } catch (error: VaultFailure) { throw error }
          catch (_: javax.net.ssl.SSLException) { throw VaultFailure("sync_certificate_mismatch") }
          catch (_: Exception) { throw VaultFailure("sync_unavailable") }
        finally { connection.disconnect() }
    }
    companion object {
        private val LOCK = ReentrantLock()
        private fun <T> exclusive(action: () -> T): T {
            if (!LOCK.tryLock()) throw VaultFailure("sync_busy")
            try { return action() } finally { LOCK.unlock() }
        }
        fun empty(): JSONObject = JSONObject().put("version", 1).put("entries", JSONArray()).put("passkeys", JSONArray())
        fun rows(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }
        fun canonical(value: Any?): String = when (value) {
            null -> "missing"
            is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
            is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
            is String -> JSONObject.quote(value)
            else -> value.toString()
        }
        fun validate(value: JSONObject) {
            if (value.length() != 3 || value.getInt("version") != 1 || value.toString().toByteArray(Charsets.UTF_8).size > 1_000_000) throw VaultFailure("invalid_sync_snapshot")
            for ((name, maximum) in listOf("entries" to 1000, "passkeys" to 500)) {
                val values = rows(value.getJSONArray(name))
                if (values.size > maximum || values.map { it.getString("id") }.toSet().size != values.size) throw VaultFailure("invalid_sync_snapshot")
                for (row in values) {
                    if (name == "passkeys") PasskeyStore.validateRecord(row)
                    else {
                        for ((field, length) in mapOf("id" to 100, "title" to 200, "username" to 1000, "password" to 4096, "url" to 4096, "notes" to 10000, "totp" to 1024)) if (row.opt(field) !is String || row.getString(field).length > length) throw VaultFailure("invalid_sync_snapshot")
                        if (row.getString("id").isEmpty() || row.getString("title").isBlank() || row.opt("favorite") !is Boolean || row.getJSONArray("tags").length() > 20) throw VaultFailure("invalid_sync_snapshot")
                        val tags = row.getJSONArray("tags"); for (i in 0 until tags.length()) if (tags.opt(i) !is String || tags.getString(i).length > 80) throw VaultFailure("invalid_sync_snapshot")
                    }
                }
            }
        }
        fun conflicts(base: JSONObject, local: JSONObject, remote: JSONObject): List<JSONObject> {
            val conflicts = mutableListOf<JSONObject>()
            for (name in listOf("entries", "passkeys")) {
                val maps = listOf(base, local, remote).map { rows(it.getJSONArray(name)).associateBy { row -> row.getString("id") } }
                for (id in maps.flatMap { it.keys }.toSortedSet()) {
                    val (old, mine, theirs) = maps.map { it[id] }
                    if (canonical(mine) != canonical(old) && canonical(theirs) != canonical(old) && canonical(mine) != canonical(theirs)) {
                        val item = mine ?: theirs ?: old!!
                        conflicts.add(JSONObject().put("id", id).put("title", if (name == "passkeys") item.getString("rpId") else item.getString("title")))
                    }
                }
            }
            return conflicts
        }
        fun merge(base: JSONObject, local: JSONObject, remote: JSONObject, resolution: String? = null): JSONObject {
            listOf(base, local, remote).forEach(::validate)
            val result = empty()
            for (name in listOf("entries", "passkeys")) {
                val maps = listOf(base, local, remote).map { rows(it.getJSONArray(name)).associateBy { row -> row.getString("id") } }
                val values = JSONArray()
                for (id in maps.flatMap { it.keys }.toSortedSet()) {
                    val (old, mine, theirs) = maps.map { it[id] }
                    val next = when { canonical(mine) == canonical(old) -> theirs
                        canonical(theirs) == canonical(old) || canonical(mine) == canonical(theirs) -> mine
                        resolution == "local" -> mine
                        resolution == "remote" -> theirs
                        else -> throw VaultFailure("sync_conflict") }
                    if (next != null) values.put(next)
                }
                result.put(name, values)
            }
            validate(result); return result
        }
        fun mobile(row: JSONObject): JSONObject? = try {
            val uri = URI(row.getString("url"))
            val origin = OriginPolicy.canonical("${uri.scheme}://${uri.rawAuthority}")
            JSONObject().put("id", row.getString("id")).put("title", row.getString("title")).put("origin", origin)
                .put("username", row.getString("username")).put("password", row.getString("password"))
                .put("notes", row.getString("notes")).put("updatedAt", Instant.now().toString()).also(OriginPolicy::validate)
        } catch (_: Exception) { null }
        private fun decode(value: String, maximum: Int): ByteArray {
            if (value.length > (maximum + 2) / 3 * 4 || !Regex("^[A-Za-z0-9_-]+$").matches(value)) throw VaultFailure("invalid_sync_snapshot")
            val bytes = Base64.decode(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
            if (bytes.size > maximum || encode(bytes) != value) throw VaultFailure("invalid_sync_snapshot")
            return bytes
        }
        private fun encode(value: ByteArray): String = Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        private fun aad(state: JSONObject, revision: Long): ByteArray = "HeavenKey/sync/v1\u0000${state.getString("id")}\u0000$revision".toByteArray(Charsets.UTF_8)
        fun seal(value: JSONObject, state: JSONObject, revision: Long): JSONObject {
            validate(value)
            val key = decode(state.getString("key"), 32)
            val plain = value.toString().toByteArray(Charsets.UTF_8)
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")); cipher.updateAAD(aad(state, revision))
                return JSONObject().put("version", 1).put("iv", encode(cipher.iv)).put("ciphertext", encode(cipher.doFinal(plain)))
            } finally { key.fill(0); plain.fill(0) }
        }
        fun open(value: JSONObject, state: JSONObject, revision: Long): JSONObject {
            if (value.length() != 3 || value.getInt("version") != 1) throw VaultFailure("invalid_sync_snapshot")
            val key = decode(state.getString("key"), 32); val iv = decode(value.getString("iv"), 12)
            if (iv.size != 12) throw VaultFailure("invalid_sync_snapshot")
            try {
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv)); cipher.updateAAD(aad(state, revision))
                val plain = cipher.doFinal(decode(value.getString("ciphertext"), 1_500_016))
                return try { JSONObject(String(plain, Charsets.UTF_8)).also(::validate) } finally { plain.fill(0) }
            } finally { key.fill(0) }
        }
    }
}
