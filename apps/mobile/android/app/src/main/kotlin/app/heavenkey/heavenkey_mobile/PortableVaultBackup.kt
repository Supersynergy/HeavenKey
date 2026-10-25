package app.heavenkey.heavenkey_mobile

import android.content.Context
import org.json.JSONObject

// Private keys stay on the native side of the method channel. Only encrypted archives and
// counts cross into Flutter. Existing V1 login archives remain readable on Android.
internal class PortableVaultBackup(context: Context, private val vault: VaultStore) {
    private val passkeys = PasskeyStore(context, vault)

    fun create(recoveryKey: String): String = MobileStoreTransaction.run {
        val archive = MobileBackup.sealFull(vault.read(), passkeys.exportRecords(), recoveryKey)
        vault.read() // Recheck the native deadline after encryption.
        archive
    }

    fun inspect(envelope: String, recoveryKey: String): Map<String, Any> = MobileStoreTransaction.run {
        val current = vault.read()
        val keys = passkeys.exportRecords()
        val incoming = MobileBackup.openFull(envelope, recoveryKey)
        try { passkeys.previewRestore(incoming.passkeys) }
        catch (_: Exception) { throw BackupFailure("invalid_archive") }
        vault.read()
        val ids = current.map { it.getString("id") }.toSet()
        val keyIds = keys.map { it.getString("id") }.toSet()
        val existing = incoming.entries.count { it.getString("id") in ids }
        val existingKeys = incoming.passkeys.count { it.getString("id") in keyIds }
        mapOf("total" to incoming.entries.size, "new" to incoming.entries.size - existing, "existing" to existing,
            "passkeyCount" to incoming.passkeys.size, "newPasskeys" to incoming.passkeys.size - existingKeys,
            "existingPasskeys" to existingKeys,
            "vaultFingerprint" to MobileBackup.fullFingerprint(current, keys),
            "archiveFingerprint" to MobileBackup.archiveFingerprint(envelope),
            "entries" to incoming.entries.map { entry -> listOf("id", "title", "origin", "username").associateWith { entry.getString(it) } })
    }

    fun restore(envelope: String, recoveryKey: String, vaultFingerprint: String,
                archiveFingerprint: String, replaceExisting: Boolean): List<JSONObject> = MobileStoreTransaction.run {
        val current = vault.read()
        val keys = passkeys.exportRecords()
        if (MobileBackup.fullFingerprint(current, keys) != vaultFingerprint ||
            MobileBackup.archiveFingerprint(envelope) != archiveFingerprint) throw BackupFailure("vault_changed")
        val incoming = MobileBackup.openFull(envelope, recoveryKey)
        val merged = MobileBackup.merge(current, incoming.entries, replaceExisting)
        try { passkeys.previewRestore(incoming.passkeys) }
        catch (_: Exception) { throw BackupFailure("invalid_archive") }
        vault.read()
        // Validate the entire archive before mutation. Individual stores use AtomicFile. If a
        // later I/O failure interrupts the two stores, no deletion is attempted: unlock, inspect
        // again, and retry the idempotent merge. The UI explicitly reports an incomplete restore.
        try {
            if (incoming.passkeys.isNotEmpty()) passkeys.restoreRecords(incoming.passkeys)
            if (MobileBackup.fingerprint(merged) != MobileBackup.fingerprint(current)) vault.replaceEntries(merged)
        } catch (_: Exception) { throw BackupFailure("backup_incomplete") }
        merged
    }
}
