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

    private fun parts(envelope: String): Pair<ByteArray, ByteArray> {
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
            if (header.size != 4 || header["format"] != "heavenkey-mobile-backup" || header["version"] != "1") throw BackupFailure("invalid_archive")
            val iv = decode(header.getValue("iv"), 12)
            val encrypted = decode(header.getValue("ciphertext"), maxPlaintext + 16)
            if (iv.size != 12 || encrypted.size < 16) throw BackupFailure("invalid_archive")
            return iv to encrypted
        } catch (error: BackupFailure) { throw error }
          catch (_: Exception) { throw BackupFailure("invalid_archive") }
    }

    fun checkArchive(envelope: String) { parts(envelope) }

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
