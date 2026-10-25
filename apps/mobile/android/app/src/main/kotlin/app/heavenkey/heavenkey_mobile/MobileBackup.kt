package app.heavenkey.heavenkey_mobile

import android.util.JsonReader
import android.util.JsonToken
import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.io.StringReader
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal class BackupFailure(val code: String) : Exception(code)

internal object MobileBackup {
    private const val maxPlaintext = 16 * 1024 * 1024
    private const val maxEnvelope = 24 * 1024 * 1024
    private val aad = "HeavenKey/mobile-backup/v1".toByteArray(Charsets.UTF_8)
    private val fields = listOf("id", "notes", "origin", "password", "title", "updatedAt", "username")
    private val encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder = Base64.getUrlDecoder()
    private val random = SecureRandom()

    fun newKey(): String = "hk1_" + encoder.encodeToString(ByteArray(32).also { random.nextBytes(it) })

    fun checkKey(key: String): Boolean = try { keyBytes(key); true } catch (_: BackupFailure) { false }

    private fun decode(value: String, maximum: Int): ByteArray {
        if (value.length > (maximum.toLong() * 4 + 2) / 3 ||
            !Regex("^[A-Za-z0-9_-]+$").matches(value)) throw BackupFailure("invalid_archive")
        val bytes = try { decoder.decode(value) } catch (_: IllegalArgumentException) { throw BackupFailure("invalid_archive") }
        if (bytes.size > maximum || encoder.encodeToString(bytes) != value) throw BackupFailure("invalid_archive")
        return bytes
    }

    private fun keyBytes(key: String): ByteArray {
        if (!key.startsWith("hk1_") || key.length != 47) throw BackupFailure("invalid_key")
        val bytes = try { decode(key.substring(4), 32) } catch (_: BackupFailure) { throw BackupFailure("invalid_key") }
        if (bytes.size != 32) throw BackupFailure("invalid_key")
        return bytes
    }

    private fun validate(entries: List<JSONObject>) {
        if (entries.size > 500) throw BackupFailure("invalid_archive")
        val ids = mutableSetOf<String>()
        for (entry in entries) {
            try { OriginPolicy.validate(entry) } catch (_: Exception) { throw BackupFailure("invalid_archive") }
            if (!ids.add(entry.getString("id"))) throw BackupFailure("invalid_archive")
        }
    }

    private fun parts(envelope: String, version: Int = 1): Pair<ByteArray, ByteArray> {
        if (envelope.length > maxEnvelope || envelope.toByteArray(Charsets.UTF_8).size > maxEnvelope)
            throw BackupFailure("too_large")
        try {
            val header = mutableMapOf<String, String>()
            JsonReader(StringReader(envelope)).use { reader ->
                reader.isLenient = false
                reader.beginObject()
                while (reader.hasNext()) {
                    val name = reader.nextName()
                    if (name !in setOf("format", "version", "iv", "ciphertext") || header.containsKey(name)) throw BackupFailure("invalid_archive")
                    if (reader.peek() != if (name == "version") JsonToken.NUMBER else JsonToken.STRING) throw BackupFailure("invalid_archive")
                    header[name] = reader.nextString()
                }
                reader.endObject()
                if (reader.peek() != JsonToken.END_DOCUMENT) throw BackupFailure("invalid_archive")
            }
            if (header.size != 4 || header["format"] != "heavenkey-mobile-backup" || header["version"] != version.toString()) throw BackupFailure("invalid_archive")
            val iv = decode(header.getValue("iv"), 12)
            val encrypted = decode(header.getValue("ciphertext"), maxPlaintext + 16)
            if (iv.size != 12 || encrypted.size < 16) throw BackupFailure("invalid_archive")
            return iv to encrypted
        } catch (error: BackupFailure) { throw error }
          catch (_: Exception) { throw BackupFailure("invalid_archive") }
    }

    fun checkArchive(envelope: String) {
        if (envelope.length > maxEnvelope || envelope.toByteArray(Charsets.UTF_8).size > maxEnvelope) throw BackupFailure("too_large")
        // Only the header is inspected here; authentication and strict payload validation follow on import.
        val version = try { JSONObject(envelope).getInt("version") } catch (_: Exception) { throw BackupFailure("invalid_archive") }
        if (version !in 1..2) throw BackupFailure("invalid_archive")
        parts(envelope, version)
    }

    // V2 uses the same reviewed platform AES-GCM primitive and independent domain separation.
    fun sealFull(entries: List<JSONObject>, passkeys: List<JSONObject>, recoveryKey: String): String {
        validate(entries); validatePasskeys(passkeys)
        val plaintext = JSONObject().put("entries", JSONArray(entries)).put("passkeys", JSONArray(passkeys))
            .toString().toByteArray(Charsets.UTF_8)
        val key = keyBytes(recoveryKey)
        try {
            if (plaintext.size > maxPlaintext) throw BackupFailure("too_large")
            val iv = ByteArray(12).also { random.nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD("HeavenKey/mobile-backup/v2".toByteArray(Charsets.UTF_8))
            return JSONObject().put("format", "heavenkey-mobile-backup").put("version", 2)
                .put("iv", encoder.encodeToString(iv)).put("ciphertext", encoder.encodeToString(cipher.doFinal(plaintext))).toString()
        } finally { key.fill(0); plaintext.fill(0) }
    }

    data class Contents(val entries: List<JSONObject>, val passkeys: List<JSONObject>)

    private fun readRows(reader: JsonReader, allowed: Set<String>): List<JSONObject> {
        val rows = mutableListOf<JSONObject>()
        reader.beginArray()
        while (reader.hasNext()) {
            if (rows.size >= 500) throw BackupFailure("invalid_archive")
            val row = JSONObject()
            reader.beginObject()
            while (reader.hasNext()) {
                val name = reader.nextName()
                if (name !in allowed || row.has(name) || reader.peek() != JsonToken.STRING) throw BackupFailure("invalid_archive")
                row.put(name, reader.nextString())
            }
            reader.endObject(); rows.add(row)
        }
        reader.endArray()
        return rows
    }

    private fun validatePasskeys(passkeys: List<JSONObject>) {
        if (passkeys.size > 500 || passkeys.map { it.optString("id") }.toSet().size != passkeys.size) throw BackupFailure("invalid_archive")
        try { passkeys.forEach(PasskeyStore::validateRecord) }
        catch (_: Exception) { throw BackupFailure("invalid_archive") }
    }

    fun openFull(envelope: String, recoveryKey: String): Contents {
        checkArchive(envelope)
        if (JSONObject(envelope).getInt("version") == 1) return Contents(open(envelope, recoveryKey), emptyList())
        val key = keyBytes(recoveryKey)
        try {
            val (iv, encrypted) = parts(envelope, 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD("HeavenKey/mobile-backup/v2".toByteArray(Charsets.UTF_8))
            val plain = cipher.doFinal(encrypted)
            try {
                val text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(plain)).toString()
                val payload = mutableMapOf<String, List<JSONObject>>()
                JsonReader(StringReader(text)).use { reader ->
                    reader.isLenient = false; reader.beginObject()
                    while (reader.hasNext()) {
                        val name = reader.nextName()
                        if (name !in setOf("entries", "passkeys") || payload.containsKey(name)) throw BackupFailure("invalid_archive")
                        val allowed = if (name == "entries") fields.toSet() else setOf("id", "rpId", "userHandle", "userName", "userDisplayName", "privateKey", "publicKey", "createdAt")
                        payload[name] = readRows(reader, allowed)
                    }
                    reader.endObject()
                    if (reader.peek() != JsonToken.END_DOCUMENT || payload.size != 2) throw BackupFailure("invalid_archive")
                }
                val entries = payload.getValue("entries"); val passkeys = payload.getValue("passkeys")
                validate(entries); validatePasskeys(passkeys)
                return Contents(entries, passkeys)
            } finally { plain.fill(0) }
        } catch (failure: BackupFailure) { throw failure }
          catch (_: Exception) { throw BackupFailure("invalid_archive") }
        finally { key.fill(0) }
    }

    fun fullFingerprint(entries: List<JSONObject>, passkeys: List<JSONObject>): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(fingerprint(entries).toByteArray(Charsets.UTF_8))
        // Fixed field order, length prefixes and sorted IDs bind all private material without exposing it.
        for (record in passkeys.sortedBy { it.getString("id") }) {
            for (name in listOf("id", "rpId", "userHandle", "userName", "userDisplayName", "privateKey", "publicKey", "createdAt")) {
                val bytes = record.getString(name).toByteArray(Charsets.UTF_8)
                digest.update(ByteBuffer.allocate(4).putInt(bytes.size).array()); digest.update(bytes); bytes.fill(0)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    fun archiveFingerprint(envelope: String): String {
        if (envelope.length > maxEnvelope || envelope.toByteArray(Charsets.UTF_8).size > maxEnvelope)
            throw BackupFailure("too_large")
        return MessageDigest.getInstance("SHA-256").digest(envelope.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    fun merge(current: List<JSONObject>, incoming: List<JSONObject>, replaceExisting: Boolean): List<JSONObject> {
        validate(current); validate(incoming)
        val merged = linkedMapOf<String, JSONObject>()
        current.forEach { merged[it.getString("id")] = it }
        incoming.forEach { if (replaceExisting || !merged.containsKey(it.getString("id"))) merged[it.getString("id")] = it }
        if (merged.size > 500) throw BackupFailure("too_large")
        return merged.values.toList()
    }

    fun seal(entries: List<JSONObject>, recoveryKey: String): String {
        val key = keyBytes(recoveryKey)
        validate(entries)
        val plaintext = JSONArray(entries).toString().toByteArray(Charsets.UTF_8)
        try {
            if (plaintext.size > maxPlaintext) throw BackupFailure("too_large")
            val iv = ByteArray(12).also { random.nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            return JSONObject().put("format", "heavenkey-mobile-backup").put("version", 1)
                .put("iv", encoder.encodeToString(iv))
                .put("ciphertext", encoder.encodeToString(cipher.doFinal(plaintext))).toString()
        } finally { key.fill(0); plaintext.fill(0) }
    }

    fun open(envelope: String, recoveryKey: String): List<JSONObject> {
        if (envelope.length > maxEnvelope || envelope.toByteArray(Charsets.UTF_8).size > maxEnvelope)
            throw BackupFailure("too_large")
        val key = keyBytes(recoveryKey)
        try {
            val (iv, encrypted) = parts(envelope)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            cipher.updateAAD(aad)
            val plaintext = cipher.doFinal(encrypted)
            try {
                if (plaintext.size > maxPlaintext) throw BackupFailure("too_large")
                val entries = mutableListOf<JSONObject>()
                val text = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(plaintext)).toString()
                JsonReader(StringReader(text)).use { reader ->
                    reader.isLenient = false; reader.beginArray()
                    while (reader.hasNext()) {
                        if (entries.size >= 500) throw BackupFailure("invalid_archive")
                        val entry = JSONObject()
                        reader.beginObject()
                        while (reader.hasNext()) {
                            val name = reader.nextName()
                            if (name !in fields || entry.has(name) || reader.peek() != JsonToken.STRING) throw BackupFailure("invalid_archive")
                            entry.put(name, reader.nextString())
                        }
                        reader.endObject(); entries.add(entry)
                    }
                    reader.endArray()
                    if (reader.peek() != JsonToken.END_DOCUMENT) throw BackupFailure("invalid_archive")
                }
                return entries.also { validate(it) }
            } finally { plaintext.fill(0) }
        } catch (error: BackupFailure) { throw error }
          catch (_: Exception) { throw BackupFailure("invalid_archive") }
        finally { key.fill(0) }
    }

    fun fingerprint(entries: List<JSONObject>): String {
        validate(entries)
        val digest = MessageDigest.getInstance("SHA-256")
        fun count(value: Int) { digest.update(ByteBuffer.allocate(4).putInt(value).array()) }
        count(entries.size)
        for (entry in entries.sortedBy { it.getString("id") }) {
            for (field in fields) {
                val bytes = entry.getString(field).toByteArray(Charsets.UTF_8)
                count(bytes.size); digest.update(bytes)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
}
