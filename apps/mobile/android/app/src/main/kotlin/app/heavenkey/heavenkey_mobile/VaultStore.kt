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
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// One in-process boundary for login, passkey and sync-state files. Network work stays outside.
internal object MobileStoreTransaction {
    private val LOCK = Any()
    fun <T> run(action: () -> T): T = synchronized(LOCK) { action() }
}

internal class VaultStore(private val context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "heavenkey-v1.aesgcm"))
    private val alias = "heavenkey-vault-v1"
    @Volatile private var expires = 0L
    private var generation = 0
    private var clipboardLabel: String? = null
    private val handler = Handler(Looper.getMainLooper())
    private var pendingAuthentication: CancellationSignal? = null
    private fun hasStoredData(): Boolean = listOf("", ".bak", ".new")
        .any { File(file.baseFile.path + it).exists() }

    fun hasVault(): Boolean = hasStoredData()

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
    @Synchronized fun lock() { generation++; expires = 0; pendingAuthentication?.cancel(); pendingAuthentication = null; clearClipboard() }
    private data class State(val entries: List<JSONObject>, val profiles: List<JSONObject>, val bindings: List<JSONObject>)
    private fun rows(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }
    private fun validate(state: State) {
        if (state.entries.size > 500 || state.entries.map { it.getString("id") }.toSet().size != state.entries.size)
            throw VaultFailure("invalid_entry")
        state.entries.forEach(OriginPolicy::validate)
        FormProfiles.validateAll(state.profiles)
        AppBindings.validateAll(state.bindings, state.entries)
    }
    private fun readState(): State {
        requireSession()
        if (!hasStoredData()) return State(emptyList(), emptyList(), emptyList())
        try {
            if (file.baseFile.length() > 16 * 1024 * 1024) throw VaultFailure("corrupt_vault")
            val envelope = JSONObject(String(file.readFully(), Charsets.UTF_8))
            val version = envelope.getInt("version")
            if (version !in 1..2) throw VaultFailure("corrupt_vault")
            val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
            if (iv.size != 12) throw VaultFailure("corrupt_vault")
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            cipher.updateAAD("HeavenKey/mobile/v$version".toByteArray(Charsets.UTF_8))
            val plaintext = cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP))
            val state = try {
                val text = String(plaintext, Charsets.UTF_8)
                if (version == 1) State(rows(JSONArray(text)), emptyList(), emptyList())
                else {
                    val payload = JSONObject(text)
                    if (payload.length() != 3) throw VaultFailure("corrupt_vault")
                    State(rows(payload.getJSONArray("entries")), rows(payload.getJSONArray("profiles")), rows(payload.getJSONArray("appBindings")))
                }
            } finally { plaintext.fill(0) }
            validate(state)
            requireSession()
            return state
        } catch (_: android.security.keystore.UserNotAuthenticatedException) { throw VaultFailure("locked") }
          catch (failure: VaultFailure) { throw VaultFailure(if (failure.code == "locked") "locked" else "corrupt_vault") }
          catch (_: Exception) { throw VaultFailure("corrupt_vault") }
    }
    fun read(): List<JSONObject> = MobileStoreTransaction.run { readState().entries }
    fun profiles(): List<JSONObject> = MobileStoreTransaction.run { readState().profiles }
    fun appBindings(): List<JSONObject> = MobileStoreTransaction.run { readState().bindings }

    private fun writeState(state: State) {
        requireSession()
        validate(state)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD("HeavenKey/mobile/v2".toByteArray(Charsets.UTF_8))
        val plaintext = JSONObject().put("entries", JSONArray(state.entries)).put("profiles", JSONArray(state.profiles))
            .put("appBindings", JSONArray(state.bindings)).toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        val payload = JSONObject().put("version", 2).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString().toByteArray(Charsets.UTF_8)
        if (payload.size > 16 * 1024 * 1024) throw VaultFailure("vault_full")
        requireSession()
        val output = file.startWrite()
        try { output.write(payload); file.finishWrite(output) }
        catch (error: Exception) { file.failWrite(output); throw error }
    }
    private fun retainedBindings(state: State, values: List<JSONObject>): List<JSONObject> {
        val old = state.entries.associate { it.getString("id") to it.getString("origin") }
        val current = values.associate { it.getString("id") to it.getString("origin") }
        return state.bindings.filter { binding ->
            val id = binding.getString("entryId")
            current[id] != null && current[id] == old[id]
        }
    }
    private fun write(values: List<JSONObject>) {
        val state = readState()
        writeState(state.copy(entries = values, bindings = retainedBindings(state, values)))
    }
    fun save(entry: JSONObject) = MobileStoreTransaction.run {
        OriginPolicy.validate(entry)
        val values = read().toMutableList()
        val index = values.indexOfFirst { it.getString("id") == entry.getString("id") }
        if (index >= 0) values[index] = entry else values.add(entry)
        write(values)
    }
    fun delete(id: String) = MobileStoreTransaction.run { write(read().filterNot { it.getString("id") == id }) }
    fun replaceEntries(values: List<JSONObject>) = MobileStoreTransaction.run { write(values) }
    fun saveProfile(profile: JSONObject) = MobileStoreTransaction.run {
        FormProfiles.validate(profile)
        val state = readState()
        writeState(state.copy(profiles = FormProfiles.merge(state.profiles, listOf(profile), true)))
    }
    fun deleteProfile(id: String) = MobileStoreTransaction.run {
        val state = readState()
        writeState(state.copy(profiles = state.profiles.filterNot { it.getString("id") == id }))
    }
    fun replaceContent(entries: List<JSONObject>, profiles: List<JSONObject>) = MobileStoreTransaction.run {
        val state = readState()
        writeState(State(entries, profiles, retainedBindings(state, entries)))
    }
    fun replaceProfiles(profiles: List<JSONObject>) = MobileStoreTransaction.run {
        writeState(readState().copy(profiles = profiles))
    }
    fun associatedEntries(app: NativeAppIdentity): List<JSONObject> = MobileStoreTransaction.run {
        val state = readState()
        val ids = state.bindings.filter { it.getString("packageName") == app.packageName && it.getString("certificates") == app.certificates }
            .map { it.getString("entryId") }.toSet()
        state.entries.filter { it.getString("id") in ids }
    }
    fun bindApp(entryId: String, app: NativeAppIdentity) = MobileStoreTransaction.run {
        if (!app.current(context)) throw VaultFailure("app_changed")
        val state = readState()
        val binding = JSONObject().put("entryId", entryId).put("packageName", app.packageName).put("certificates", app.certificates)
        val bindings = state.bindings.filterNot { it.getString("entryId") == entryId && it.getString("packageName") == app.packageName } + binding
        writeState(state.copy(bindings = bindings))
    }
    fun revokeApp(packageName: String) = MobileStoreTransaction.run {
        val state = readState()
        writeState(state.copy(bindings = state.bindings.filterNot { it.getString("packageName") == packageName }))
    }
    fun readSyncState(): JSONObject? = MobileStoreTransaction.run {
        requireSession()
        val storage = AtomicFile(File(context.noBackupFilesDir, "heavenkey-sync-v1.aesgcm"))
        if (!listOf("", ".bak", ".new").any { File(storage.baseFile.path + it).exists() }) return@run null
        if (storage.baseFile.length() > 4 * 1024 * 1024) throw VaultFailure("corrupt_vault")
        val envelope = JSONObject(String(storage.readFully(), Charsets.UTF_8))
        if (envelope.getInt("version") != 1) throw VaultFailure("corrupt_vault")
        val iv = Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)
        if (iv.size != 12) throw VaultFailure("corrupt_vault")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        cipher.updateAAD("HeavenKey/mobile-sync-state/v1".toByteArray(Charsets.UTF_8))
        val bytes = cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.NO_WRAP))
        return@run try { JSONObject(String(bytes, Charsets.UTF_8)) } finally { bytes.fill(0) }
    }
    fun writeSyncState(state: JSONObject?) = MobileStoreTransaction.run {
        requireSession()
        val storage = AtomicFile(File(context.noBackupFilesDir, "heavenkey-sync-v1.aesgcm"))
        if (state == null) { storage.delete(); return@run }
        val bytes = state.toString().toByteArray(Charsets.UTF_8)
        if (bytes.size > 2 * 1024 * 1024) throw VaultFailure("vault_full")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD("HeavenKey/mobile-sync-state/v1".toByteArray(Charsets.UTF_8))
        val encrypted = try { cipher.doFinal(bytes) } finally { bytes.fill(0) }
        val envelope = JSONObject().put("version", 1).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(encrypted, Base64.NO_WRAP)).toString().toByteArray(Charsets.UTF_8)
        val output = storage.startWrite()
        try { output.write(envelope); storage.finishWrite(output) }
        catch (error: Exception) { storage.failWrite(output); throw error }
    }
    fun newBackupKey(): String { read(); return MobileBackup.newKey() }
    fun copyBackupKey(recoveryKey: String) {
        read()
        if (!MobileBackup.checkKey(recoveryKey)) throw BackupFailure("invalid_key")
        copyText(recoveryKey)
    }
    fun createBackup(recoveryKey: String): String {
        val archive = MobileBackup.seal(read(), recoveryKey)
        requireSession()
        return archive
    }
    fun inspectBackup(envelope: String, recoveryKey: String): Map<String, Any> {
        val current = read()
        val incoming = MobileBackup.open(envelope, recoveryKey)
        requireSession()
        val ids = current.map { it.getString("id") }.toSet()
        val existing = incoming.count { it.getString("id") in ids }
        return mapOf("total" to incoming.size, "new" to incoming.size - existing, "existing" to existing,
            "vaultFingerprint" to MobileBackup.fingerprint(current),
            "archiveFingerprint" to MobileBackup.archiveFingerprint(envelope),
            "entries" to incoming.map { entry -> listOf("id", "title", "origin", "username").associateWith { entry.getString(it) } })
    }
    fun restoreBackup(envelope: String, recoveryKey: String, vaultFingerprint: String,
                      archiveFingerprint: String, replaceExisting: Boolean): List<JSONObject> = MobileStoreTransaction.run {
        val current = read()
        if (MobileBackup.fingerprint(current) != vaultFingerprint ||
            MobileBackup.archiveFingerprint(envelope) != archiveFingerprint) throw BackupFailure("vault_changed")
        val incoming = MobileBackup.open(envelope, recoveryKey)
        val merged = MobileBackup.merge(current, incoming, replaceExisting)
        requireSession()
        if (MobileBackup.fingerprint(merged) != vaultFingerprint) write(merged)
        merged
    }
    fun copy(id: String) {
        val entry = read().find { it.getString("id") == id } ?: throw VaultFailure("invalid_entry")
        copyText(entry.getString("password"))
    }
    private fun copyText(value: String) {
        clearClipboard()
        val label = "HeavenKey-${UUID.randomUUID()}"
        val clip = ClipData.newPlainText(label, value)
        clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(clip)
        clipboardLabel = label
        handler.postDelayed({ if (clipboardLabel == label) clearClipboard() }, 30_000)
    }
    fun clearClipboard() {
        val label = clipboardLabel ?: return
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        // Android can hide the description while this window lacks input focus.
        val current = clipboard.primaryClipDescription ?: return
        if (current.label?.toString() == label) clipboard.clearPrimaryClip()
        clipboardLabel = null
    }
}
