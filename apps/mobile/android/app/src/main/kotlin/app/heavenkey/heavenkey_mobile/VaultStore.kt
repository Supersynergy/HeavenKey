package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URI
import java.security.KeyStore
import java.time.Instant
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class VaultFailure(val code: String) : Exception(code)

internal object OriginPolicy {
    fun canonical(value: String): String {
        val uri = try { URI(value) } catch (_: Exception) { throw VaultFailure("invalid_entry") }
        val host = uri.host?.lowercase() ?: throw VaultFailure("invalid_entry")
        val labels = host.split('.')
        val label = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
        if (value != value.trim() || uri.scheme != "https" || uri.rawUserInfo != null ||
            uri.rawQuery != null || uri.rawFragment != null || uri.rawAuthority.contains('%') ||
            (uri.rawPath.isNotEmpty() && uri.rawPath != "/") || host.length > 253 || labels.size < 2 ||
            labels.any { !label.matches(it) } || Regex("^[0-9.]+$").matches(host) ||
            (uri.port != -1 && uri.port !in 1..65535)) throw VaultFailure("invalid_entry")
        return "https://$host" + if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
    }
    fun validate(entry: JSONObject) {
        val limits = mapOf("id" to 80, "title" to 120, "origin" to 2048, "username" to 320,
            "password" to 1024, "notes" to 4096, "updatedAt" to 80)
        if (entry.length() != limits.size) throw VaultFailure("invalid_entry")
        for ((field, limit) in limits) {
            val value = entry.opt(field)
            if (value !is String || value.length > limit) throw VaultFailure("invalid_entry")
        }
        if (!Regex("^[A-Za-z0-9_-]{1,80}$").matches(entry.getString("id")) ||
            entry.getString("title").isBlank() || entry.getString("password").isEmpty() ||
            canonical(entry.getString("origin")) != entry.getString("origin")) throw VaultFailure("invalid_entry")
        try { Instant.parse(entry.getString("updatedAt")) } catch (_: Exception) { throw VaultFailure("invalid_entry") }
    }
}

internal class VaultStore(private val context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "heavenkey-v1.aesgcm"))
    private val alias = "heavenkey-vault-v1"
    private var expires = 0L
    private var generation = 0
    private var clipboardLabel: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private var pendingAuthentication: CancellationSignal? = null
    private fun hasStoredData(): Boolean = listOf("", ".bak", ".new")
        .any { File(file.baseFile.path + it).exists() }

    fun secureDevice(): Boolean = context.getSystemService(KeyguardManager::class.java).isDeviceSecure
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(alias)) return store.getKey(alias, null) as SecretKey
        if (hasStoredData()) throw VaultFailure("corrupt_vault")
        if (!secureDevice()) throw VaultFailure("device_not_secure")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(true)
                .setUserAuthenticationParameters(60, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                .build())
        }.generateKey()
    }
    fun authenticate(activity: Activity, complete: (String?) -> Unit) {
        if (!secureDevice()) { complete("device_not_secure"); return }
        try { key() } catch (_: Exception) { complete("corrupt_vault"); return }
        val token = ++generation
        val signal = CancellationSignal()
        pendingAuthentication?.cancel()
        pendingAuthentication = signal
        handler.postDelayed({ if (pendingAuthentication === signal) signal.cancel() }, 60_000)
        var delivered = false
        fun finish(error: String?) {
            if (delivered) return
            delivered = true
            if (token != generation) { complete("cancelled"); return }
            pendingAuthentication = null
            if (error == null) expires = SystemClock.elapsedRealtime() + 60_000
            complete(error)
        }
        BiometricPrompt.Builder(activity).setTitle("HeavenKey entsperren")
            .setSubtitle("Login nur nach deiner Freigabe verwenden")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL)
            .build().authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { finish(null) }
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) { finish("cancelled") }
            })
    }
    private fun requireSession() {
        if (expires == 0L || SystemClock.elapsedRealtime() >= expires) {
            lock(); throw VaultFailure("locked")
        }
    }
    fun lock() { generation++; expires = 0; pendingAuthentication?.cancel(); pendingAuthentication = null; clearClipboard() }
    fun read(): List<JSONObject> {
        requireSession()
        if (!hasStoredData()) return emptyList()
        try {
            if (file.baseFile.length() > 16 * 1024 * 1024) throw VaultFailure("corrupt_vault")
            val envelope = JSONObject(String(file.readFully(), Charsets.UTF_8))
            if (envelope.getInt("version") != 1) throw VaultFailure("corrupt_vault")
            val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
            if (iv.size != 12) throw VaultFailure("corrupt_vault")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            cipher.updateAAD("HeavenKey/mobile/v1".toByteArray(Charsets.UTF_8))
            val plaintext = cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP))
            val values = try { JSONArray(String(plaintext, Charsets.UTF_8)) } finally { plaintext.fill(0) }
            if (values.length() > 500) throw VaultFailure("corrupt_vault")
            val ids = mutableSetOf<String>()
            return (0 until values.length()).map { i -> values.getJSONObject(i).also {
                OriginPolicy.validate(it)
                if (!ids.add(it.getString("id"))) throw VaultFailure("corrupt_vault")
            } }
        } catch (error: android.security.keystore.UserNotAuthenticatedException) {
            throw VaultFailure("locked")
        } catch (_: Exception) { throw VaultFailure("corrupt_vault") }
    }
    private fun write(values: List<JSONObject>) {
        requireSession()
        if (values.size > 500) throw VaultFailure("invalid_entry")
        values.forEach { OriginPolicy.validate(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD("HeavenKey/mobile/v1".toByteArray(Charsets.UTF_8))
        val plaintext = JSONArray(values).toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        val payload = JSONObject().put("version", 1).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString().toByteArray(Charsets.UTF_8)
        if (payload.size > 16 * 1024 * 1024) throw VaultFailure("vault_full")
        val output = file.startWrite()
        try { output.write(payload); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw error }
    }
    fun save(entry: JSONObject) {
        OriginPolicy.validate(entry)
        val values = read().toMutableList()
        val index = values.indexOfFirst { it.getString("id") == entry.getString("id") }
        if (index >= 0) values[index] = entry else values.add(entry)
        write(values)
    }
    fun delete(id: String) { write(read().filterNot { it.getString("id") == id }) }
    fun copy(id: String) {
        val entry = read().find { it.getString("id") == id } ?: throw VaultFailure("invalid_entry")
        clearClipboard()
        val label = "HeavenKey-${UUID.randomUUID()}"
        val clip = ClipData.newPlainText(label, entry.getString("password"))
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        clipboardLabel = label
        handler.postDelayed({ if (clipboardLabel == label) clearClipboard() }, 30_000)
    }
    private fun clearClipboard() {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val label = clipboardLabel
        if (label != null && clipboard.primaryClipDescription?.label?.toString() == label) clipboard.clearPrimaryClip()
        clipboardLabel = null
    }
}
