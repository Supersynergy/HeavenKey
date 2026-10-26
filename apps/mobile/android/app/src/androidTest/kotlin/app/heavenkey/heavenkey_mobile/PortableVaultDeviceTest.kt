package app.heavenkey.heavenkey_mobile

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// Runs only on the explicitly owned, disposable test emulator. No production test channel,
// test authentication bypass or fixture key is added to the application.
class PortableVaultDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)

    @Before fun requireOwnedEmulator() {
        assertEquals("heavenkey_production_test", device.executeShellCommand("getprop ro.boot.qemu.avd_name").trim())
        assertEquals("1", device.executeShellCommand("getprop ro.kernel.qemu").trim())
    }

    private fun authenticate(vault: VaultStore, scenario: ActivityScenario<MainActivity>) {
        val complete = CountDownLatch(1)
        var failure: String? = "pending"
        scenario.onActivity { activity -> vault.authenticate(activity) { failure = it; complete.countDown() } }
        val pin = device.wait(Until.findObject(By.clazz("android.widget.EditText").pkg("com.android.systemui")), 20_000)
            ?: error("The actual Android device credential dialog did not appear.")
        pin.text = "417926" // Synthetic emulator PIN, set by the device test runner.
        device.pressEnter()
        assertTrue("Device authentication did not finish", complete.await(15, TimeUnit.SECONDS))
        assertNull("Device authentication failed", failure)
        device.waitForIdle()
    }

    private fun entry(id: String) = JSONObject().put("id", id).put("title", "Synthetic device acceptance")
        .put("origin", "https://example.test").put("username", "synthetic@example.test")
        .put("password", "Synthetic-device-only-password-24!").put("notes", "Grüße 🔑")
        .put("updatedAt", "2026-10-26T00:00:00Z")

    private fun createPasskey(store: PasskeyStore): JSONObject {
        val options = JSONObject().put("challenge", PasskeyProtocol.encode(ByteArray(32) { 7 }))
            .put("rp", JSONObject().put("id", "example.test").put("name", "Synthetic test"))
            .put("user", JSONObject().put("id", "AQ").put("name", "synthetic@example.test").put("displayName", "Synthetic"))
        val response = JSONObject(store.create(options, ByteArray(32) { 9 }, UUID.randomUUID().toString()))
        return store.exportRecords().single { it.getString("id") == response.getString("id") }
    }

    private fun restore(backup: PortableVaultBackup, archive: String, key: String, preview: Map<String, Any>) =
        backup.restore(archive, key, preview.getValue("vaultFingerprint") as String,
            preview.getValue("archiveFingerprint") as String, false)

    private fun failure(code: String, action: () -> Unit) {
        try { action(); fail("The operation should have failed") }
        catch (error: BackupFailure) { assertEquals(code, error.code) }
    }

    @Test fun actualKeystoreRoundTripRestoresUsablePasskeyWithoutDesktop() {
        val id = "device-${UUID.randomUUID()}"
        val vault = VaultStore(context)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            authenticate(vault, scenario)
            val passkeys = PasskeyStore(context, vault)
            vault.save(entry(id))
            val record = createPasskey(passkeys)
            val keyId = record.getString("id")
            try {
                val backup = PortableVaultBackup(context, vault)
                val key = vault.newBackupKey()
                val archive = backup.create(key)
                assertFalse(archive.contains(entry(id).getString("password")))
                assertFalse(archive.contains(record.getString("privateKey")))
                assertFalse(archive.contains(key))
                assertFalse(File(context.noBackupFilesDir, "heavenkey-passkeys-v1.aesgcm").readText().contains(record.getString("privateKey")))
                vault.delete(id); passkeys.delete(keyId); vault.lock()

                // A new store instance must decrypt the files after fresh OS authentication.
                val reopened = VaultStore(context)
                authenticate(reopened, scenario)
                val nativeKeys = PasskeyStore(context, reopened)
                assertFalse(nativeKeys.metadata().any { it.getString("id") == keyId })
                val nativeBackup = PortableVaultBackup(context, reopened)
                val preview = nativeBackup.inspect(archive, key)
                assertTrue((preview.getValue("newPasskeys") as Int) >= 1)
                restore(nativeBackup, archive, key, preview)
                assertTrue(reopened.read().any { it.getString("id") == id })
                val restored = nativeKeys.exportRecords().single { it.getString("id") == keyId }
                assertTrue("Private key changed during portable restore", record.getString("privateKey") == restored.getString("privateKey"))

                val clientHash = ByteArray(32) { 23 }
                val options = JSONObject().put("rpId", "example.test")
                val assertion = JSONObject(nativeKeys.assertion(keyId, options, clientHash, UUID.randomUUID().toString())).getJSONObject("response")
                val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(PasskeyProtocol.decode(record.getString("publicKey"), 1, 2048)))
                assertTrue("Restored passkey signature is invalid", Signature.getInstance("SHA256withECDSA").run {
                    initVerify(publicKey)
                    update(PasskeyProtocol.decode(assertion.getString("authenticatorData")))
                    update(clientHash)
                    verify(PasskeyProtocol.decode(assertion.getString("signature")))
                })
                reopened.delete(id); nativeKeys.delete(keyId); reopened.lock()
            } finally { vault.lock() }
        }
    }

    @Test fun actualNativeStoresRejectWrongKeysTamperingStalePreviewAndLockedAccess() {
        val id = "device-${UUID.randomUUID()}"
        val vault = VaultStore(context)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            authenticate(vault, scenario)
            vault.save(entry(id))
            val backup = PortableVaultBackup(context, vault)
            val key = vault.newBackupKey()
            val archive = backup.create(key)
            val before = File(context.noBackupFilesDir, "heavenkey-v1.aesgcm").readBytes()
            failure("invalid_archive") { backup.inspect(archive, vault.newBackupKey()) }
            assertArrayEquals(before, File(context.noBackupFilesDir, "heavenkey-v1.aesgcm").readBytes())
            val damaged = JSONObject(archive)
            val encrypted = damaged.getString("ciphertext")
            damaged.put("ciphertext", (if (encrypted[0] == 'A') "B" else "A") + encrypted.substring(1))
            failure("invalid_archive") { backup.inspect(damaged.toString(), key) }
            assertArrayEquals(before, File(context.noBackupFilesDir, "heavenkey-v1.aesgcm").readBytes())

            val stale = backup.inspect(archive, key)
            vault.save(entry(id).put("password", "Synthetic-changed-password-24!"))
            val changed = File(context.noBackupFilesDir, "heavenkey-v1.aesgcm").readBytes()
            failure("vault_changed") { restore(backup, archive, key, stale) }
            assertArrayEquals(changed, File(context.noBackupFilesDir, "heavenkey-v1.aesgcm").readBytes())
            vault.delete(id); vault.lock()
            try { backup.create(key); fail("A locked vault must reject backup export") }
            catch (error: VaultFailure) { assertEquals("locked", error.code) }
        }
    }
}
