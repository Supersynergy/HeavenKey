package app.heavenkey.heavenkey_mobile

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import com.nimbusds.jose.jwk.Curve
import com.nimbusds.jose.jwk.ECKey
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileNotFoundException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class CredentialRecord(val id: String, val original: String)

internal data class WalletReceipt(
    val id: String,
    val kind: String,
    val state: String?,
    val status: String,
    val actionStatus: String? = null,
) {
    fun summary(): Map<String, Any> = buildMap {
        put("id", id)
        put("kind", kind)
        put("status", status)
        if (state != null) put("receipt_id", id)
        actionStatus?.let { put("action_status", it) }
    }
}

internal class WalletStore(context: Context) {
    private val file = AtomicFile(File(context.noBackupFilesDir, "heavenkey-wallet-v1.aesgcm"))
    private val alias = "heavenkey-wallet-store-v1"
    private val aad = "HeavenKey/AndroidWallet/v1".toByteArray()
    private val authenticator = KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun encryptionKey(): SecretKey {
        val keys = keyStore()
        if (keys.containsAlias(alias)) return keys.getKey(alias, null) as SecretKey
        walletCheck(!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists() &&
            !File(file.baseFile.path + ".new").exists(), "wallet_key_lost")
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setUserAuthenticationRequired(true).setUserAuthenticationParameters(60, authenticator)
                .setUnlockedDeviceRequired(true).build())
        }.generateKey()
    }

    private fun holderAlias(id: String): String {
        walletCheck(walletId.matches(id))
        return "heavenkey-wallet-holder-v1-$id"
    }

    fun createHolder(id: String): ECKey = MobileStoreTransaction.run {
        val alias = holderAlias(id)
        val keys = keyStore()
        walletCheck(!keys.containsAlias(alias), "wallet_already_received")
        val pair = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(true).setUserAuthenticationParameters(20, authenticator)
                .setUnlockedDeviceRequired(true).build())
        }.generateKeyPair()
        walletCheck(pair.private.encoded == null, "wallet_unprotected_key")
        ECKey.Builder(Curve.P_256, pair.public as ECPublicKey).build()
    }

    fun publicHolder(id: String): ECKey {
        val key = keyStore().getCertificate(holderAlias(id))?.publicKey as? ECPublicKey
            ?: throw WalletFailure("wallet_key_lost")
        return ECKey.Builder(Curve.P_256, key).build()
    }

    fun privateHolder(id: String): PrivateKey {
        val key = keyStore().getKey(holderAlias(id), null) as? PrivateKey
            ?: throw WalletFailure("wallet_key_lost")
        walletCheck(key.encoded == null, "wallet_unprotected_key")
        return key
    }

    fun holderProtection(id: String): String {
        val key = privateHolder(id)
        val factory = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        val info = factory.getKeySpec(key, KeyInfo::class.java)
        return if (Build.VERSION.SDK_INT >= 31) {
            when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
                else -> "unknown"
            }
        } else {
            @Suppress("DEPRECATION")
            if (info.isInsideSecureHardware) "hardware" else "software"
        }
    }

    fun discardHolder(id: String) = MobileStoreTransaction.run { keyStore().deleteEntry(holderAlias(id)) }

    private data class StoreState(
        val records: List<CredentialRecord> = emptyList(),
        val receipts: List<WalletReceipt> = emptyList(),
        val pending: WalletLink? = null,
        val aya: Boolean = false,
    )

    private fun readState(): StoreState {
        val encrypted = try { file.openRead().use { it.readWalletBody(2 * 1024 * 1024) } }
        catch (_: FileNotFoundException) { return StoreState() }
        walletCheck(encrypted.size >= 29, "wallet_corrupt")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, encryptionKey(), GCMParameterSpec(128, encrypted.copyOfRange(0, 12)))
            updateAAD(aad)
        }
        val plaintext = cipher.doFinal(encrypted, 12, encrypted.size - 12)
        val data = try { JSONObject(plaintext.toString(Charsets.UTF_8)) } finally { plaintext.fill(0) }
        val rows = data.getJSONArray("records")
        val records = (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            CredentialRecord(row.walletString("id"), row.walletString("original"))
        }
        val receipts = data.getJSONArray("receipts").let { stored ->
            (0 until stored.length()).map { index ->
                val item = stored.getJSONObject(index)
                WalletReceipt(item.walletString("id"), item.walletString("kind"), item.optString("state").ifEmpty { null },
                    item.walletString("status"), item.optString("action_status").ifEmpty { null })
            }
        }
        val pending = data.optJSONObject("pending")?.let {
            WalletLink(it.walletString("id"), it.getBoolean("issuance"))
        }
        return StoreState(records, receipts, pending, data.getBoolean("aya"))
    }

    private fun writeState(state: StoreState, guard: () -> Unit) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.ENCRYPT_MODE, encryptionKey())
            updateAAD(aad)
        }
        val rows = JSONArray(state.records.map { row ->
            JSONObject().put("id", row.id).put("original", row.original)
        })
        val receipts = JSONArray(state.receipts.map {
            JSONObject().put("id", it.id).put("kind", it.kind).put("state", it.state).put("status", it.status)
                .put("action_status", it.actionStatus)
        })
        val pending = state.pending?.let { JSONObject().put("id", it.id).put("issuance", it.issuance) }
        val plaintext = JSONObject().put("records", rows).put("receipts", receipts).put("pending", pending)
            .put("aya", state.aya).toString().toByteArray(Charsets.UTF_8)
        val encrypted = try { cipher.doFinal(plaintext) } finally { plaintext.fill(0) }
        walletCheck(cipher.iv.size == 12 && encrypted.size < 2 * 1024 * 1024, "wallet_full")
        guard()
        val output = file.startWrite()
        try {
            output.write(cipher.iv)
            output.write(encrypted)
            guard()
            file.finishWrite(output)
        } catch (error: Exception) {
            file.failWrite(output)
            throw error
        }
    }

    fun records(guard: () -> Unit): List<CredentialRecord> = MobileStoreTransaction.run { guard(); readState().records }
    fun receipts(guard: () -> Unit): List<WalletReceipt> = MobileStoreTransaction.run { guard(); readState().receipts }
    fun pending(guard: () -> Unit): WalletLink? = MobileStoreTransaction.run { guard(); readState().pending }
    fun aya(guard: () -> Unit): Boolean = MobileStoreTransaction.run { guard(); readState().aya }

    fun savePending(pending: WalletLink?, guard: () -> Unit) = MobileStoreTransaction.run {
        guard()
        val state = readState()
        if (state.pending != pending) writeState(state.copy(pending = pending), guard)
    }

    fun saveReceipt(receipt: WalletReceipt, guard: () -> Unit) = MobileStoreTransaction.run {
        guard()
        val state = readState()
        writeState(state.copy(receipts = walletReceipts(state.receipts, receipt)), guard)
    }

    fun saveCredential(record: CredentialRecord, receipt: WalletReceipt, guard: () -> Unit) = MobileStoreTransaction.run {
        guard()
        val state = readState()
        walletCheck(state.records.none { it.id == record.id }, "wallet_already_received")
        walletCheck(state.records.size < 32, "wallet_full")
        writeState(state.copy(records = state.records + record, receipts = walletReceipts(state.receipts, receipt)), guard)
    }

    fun setAya(enabled: Boolean, guard: () -> Unit) = MobileStoreTransaction.run {
        guard()
        writeState(readState().copy(aya = enabled), guard)
    }
}

internal fun walletReceipts(previous: List<WalletReceipt>, updated: WalletReceipt): List<WalletReceipt> {
    val index = previous.indexOfFirst { it.id == updated.id }
    if (index >= 0) return previous.mapIndexed { row, receipt -> if (row == index) updated else receipt }
    if (previous.size < 32) return previous + updated
    val terminal = previous.indexOfFirst {
        it.status in setOf("issued", "expired") || (it.status == "verified" &&
            (it.kind != "invoice.draft.create" || it.actionStatus in setOf("executed", "revoked", "expired")))
    }
    walletCheck(terminal >= 0, "wallet_receipts_full")
    return previous.filterIndexed { row, _ -> row != terminal } + updated
}
