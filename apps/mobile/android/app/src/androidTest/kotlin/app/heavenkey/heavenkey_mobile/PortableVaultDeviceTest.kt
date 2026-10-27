package app.heavenkey.heavenkey_mobile

import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.json.JSONArray
import android.app.KeyguardManager
import android.util.AtomicFile
import android.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import java.security.KeyStore
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
        device.wakeUp()
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        if (keyguard.isKeyguardLocked) {
            // Wait for the actual PIN bouncer before entering digits. A swipe can
            // return before its first frame exists on a freshly booted emulator.
            device.swipe(device.displayWidth / 2, device.displayHeight * 3 / 4,
                device.displayWidth / 2, device.displayHeight / 4, 30)
            device.waitForIdle()
            val key = device.wait(Until.findObject(By.res("com.android.systemui", "key4")), 10_000)
            if (key == null) missingUi("Lock-screen PIN keypad")
            for (digit in "417926") {
                val button = device.wait(Until.findObject(By.res("com.android.systemui", "key$digit")), 5_000)
                    ?: missingUi("Lock-screen PIN digit")
                button.click()
            }
            val enter = device.findObject(By.res("com.android.systemui", "key_enter"))
            if (enter != null) enter.click() else device.pressEnter()
            device.waitForIdle()
            val deadline = System.currentTimeMillis() + 10_000
            while (keyguard.isKeyguardLocked && System.currentTimeMillis() < deadline) Thread.sleep(100)
        }
        if (keyguard.isKeyguardLocked) missingUi("Unlock owned emulator with its real PIN")
    }

    private fun authenticate(vault: VaultStore, scenario: ActivityScenario<MainActivity>) {
        val complete = CountDownLatch(1)
        var failure: String? = "pending"
        scenario.onActivity { activity -> vault.authenticate(activity) { failure = it; complete.countDown() } }
        enterPin()
        assertTrue("Device authentication did not finish", complete.await(15, TimeUnit.SECONDS))
        assertNull("Device authentication failed", failure)
        device.waitForIdle()
    }

    private fun enterPin() {
        val pin = device.wait(Until.findObject(By.clazz("android.widget.EditText").pkg("com.android.systemui")), 20_000)
            ?: error("The actual Android device credential dialog did not appear; foreground=${device.currentPackageName}, keyguard=${context.getSystemService(KeyguardManager::class.java).isKeyguardLocked}.")
        pin.text = "417926" // Synthetic emulator PIN, set by the device test runner.
        device.pressEnter()
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
    private fun profile(id: String) = JSONObject(FormProfiles.limits.keys.associateWith { when(it) {
        "id" -> id; "label" -> "Synthetic profile"; "givenName" -> "Synthetisch";
        "email" -> "synthetic@example.test"; "city" -> "Berlin"; "country" -> "DE";
        "updatedAt" -> "2026-10-27T00:00:00Z"; else -> ""
    } })

    @Test fun legacyVaultMigratesProfilesAreEncryptedAndRestoreRequiresNewAppTrust() {
        val vault = VaultStore(context)
        val id = "migration-${UUID.randomUUID()}"
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            authenticate(vault, scenario)
            // Recreate the exact V1 on-disk format using the real authenticated Keystore key.
            // Only the owned emulator and synthetic rows are touched.
            val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, keyStore.getKey("heavenkey-vault-v1", null) as SecretKey)
            cipher.updateAAD("HeavenKey/mobile/v1".toByteArray(Charsets.UTF_8))
            val legacy = JSONObject().put("version", 1).put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .put("ciphertext", Base64.encodeToString(cipher.doFinal(JSONArray(listOf(entry(id))).toString().toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
            val storage = AtomicFile(File(context.noBackupFilesDir, "heavenkey-v1.aesgcm"))
            val output = storage.startWrite(); output.write(legacy.toString().toByteArray(Charsets.UTF_8)); storage.finishWrite(output)
            assertEquals(id, vault.read().single().getString("id")); assertTrue(vault.profiles().isEmpty())
            vault.saveProfile(profile(id))
            assertEquals(2, JSONObject(storage.readFully().toString(Charsets.UTF_8)).getInt("version"))
            assertEquals(id, vault.read().single().getString("id"))
            assertFalse(storage.readFully().toString(Charsets.UTF_8).contains("Synthetisch"))
            val app = NativeAppIdentity.read(context, instrumentation.context.packageName) ?: error("Test app signer unavailable")
            try { vault.bindApp(id, app.copy(certificates = "0".repeat(64))); fail("Changed app certificate accepted") }
            catch (error: VaultFailure) { assertEquals("app_changed", error.code) }
            vault.bindApp(id, app); assertEquals(1, vault.associatedEntries(app).size)
            vault.save(entry(id).put("origin", "https://other.test")); assertTrue(vault.associatedEntries(app).isEmpty())
            vault.save(entry(id)); vault.bindApp(id, app)
            val backup = PortableVaultBackup(context, vault); val recovery = vault.newBackupKey(); val archive = backup.create(recovery)
            assertEquals(3, JSONObject(archive).getInt("version"))
            val stale = backup.inspect(archive, recovery)
            vault.saveProfile(profile(id).put("city", "Hamburg"))
            failure("vault_changed") { restore(backup, archive, recovery, stale) }
            vault.delete(id); vault.deleteProfile(id)
            val preview = backup.inspect(archive, recovery)
            assertEquals(1, preview["newProfiles"])
            restore(backup, archive, recovery, preview)
            assertEquals("Berlin", vault.profiles().single().getString("city"))
            assertTrue(vault.appBindings().isEmpty())
            vault.delete(id); vault.deleteProfile(id); vault.lock()
        }
    }

    private fun missingUi(action: String): Nothing {
        val snapshot = java.io.ByteArrayOutputStream()
        device.dumpWindowHierarchy(snapshot)
        val parser = android.util.Xml.newPullParser()
        parser.setInput(java.io.StringReader(snapshot.toString("UTF-8")))
        val rows = mutableListOf<String>()
        while (parser.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
            if (parser.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && parser.name == "node") {
                val text = parser.getAttributeValue(null, "text").orEmpty()
                val description = parser.getAttributeValue(null, "content-desc").orEmpty()
                if (text.isNotEmpty() || description.isNotEmpty()) rows.add(
                    "${parser.getAttributeValue(null, "package")} | $text | $description | ${parser.getAttributeValue(null, "resource-id")}")
            }
            parser.next()
        }
        error("Missing UI action: $action; foreground=${device.currentPackageName}; UI=${rows.joinToString("\n").take(12000)}")
    }
    private fun tap(text: String) {
        val selector = By.text(java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(text), java.util.regex.Pattern.CASE_INSENSITIVE or java.util.regex.Pattern.UNICODE_CASE))
        val item = device.wait(Until.findObject(selector), 15_000) ?: missingUi(text)
        item.click(); device.waitForIdle()
    }
    private fun fixture(form: String) {
        val pkg = instrumentation.context.packageName
        val started = device.executeShellCommand("am start -W -n $pkg/app.heavenkey.heavenkey_mobile.fixture.AutofillFixtureActivity --es form $form -f 0x10008000")
        check("Status: ok" in started && "Error" !in started) { "Synthetic fixture launch failed: $started" }
        device.waitForIdle()
        tap("Request synthetic autofill")
    }
    private fun consent() {
        // Either the standard dropdown or the neutral inline keyboard chip.
        val offer = device.wait(Until.findObject(By.text(java.util.regex.Pattern.compile("Mit HeavenKey ausfüllen|HeavenKey", java.util.regex.Pattern.CASE_INSENSITIVE))), 15_000)
            ?: device.wait(Until.findObject(By.desc("Mit HeavenKey ausfüllen")), 3_000)
            ?: missingUi("System HeavenKey Autofill offer")
        offer.click(); device.waitForIdle()
        tap("Weiter"); enterPin()
    }
    private fun values(): JSONObject {
        tap("Inspect synthetic values")
        val result = device.wait(Until.findObject(By.desc("fixture-result")), 10_000) ?: error("Fixture result unavailable")
        return JSONObject(result.text)
    }

    @Test fun actualSystemAutofillProfilesAppAssociationAndSignupNeverSubmitForms() {
        val vault = VaultStore(context); val id = "autofill-${UUID.randomUUID()}"
        val service = context.packageName + "/app.heavenkey.heavenkey_mobile.HeavenAutofillService"
        device.executeShellCommand("settings put secure autofill_service $service")
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            authenticate(vault, scenario); vault.save(entry(id)); vault.saveProfile(profile(id)); vault.lock()
            fixture("profile"); consent()
            tap("Formularprofil auswählen"); tap("Synthetic profile")
            tap("E-Mail: synthetic@example.test") // Deliberately withhold email while filling name and city.
            tap("Ausgewählte Felder ausfüllen")
            val profileValues = values()
            assertEquals("Synthetisch", profileValues.getString("given-name")); assertEquals("Berlin", profileValues.getString("city"))
            assertEquals("", profileValues.getString("email"))
            assertEquals("", profileValues.getString("hidden-name"))

            fixture("login"); consent(); tap("Gespeicherten Login ausfüllen")
            val login = device.wait(Until.findObject(By.textContains("Synthetic device acceptance")), 10_000) ?: error("Synthetic login not offered")
            login.click(); tap("Zuordnen und ausfüllen")
            val loginValues = values()
            assertEquals(entry(id).getString("username"), loginValues.getString("username"))
            assertEquals(entry(id).getString("password"), loginValues.getString("password"))

            fixture("signup"); consent(); tap("Neues Passwort erzeugen und sichern")
            tap("6 merkbare Wörter · ca. 77,5 Bit")
            device.wait(Until.findObject(By.desc("HTTPS-Website, ggf. mit Port")), 10_000)!!.text = "https://example.test"
            device.findObject(By.desc("Benutzername oder E-Mail")).text = "new-synthetic@example.test"
            tap("Sichern und ausfüllen")
            val signup = values()
            assertEquals("new-synthetic@example.test", signup.getString("username"))
            assertEquals(signup.getString("password"), signup.getString("confirmation"))
            assertTrue(signup.getString("password").length >= 16)
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            authenticate(vault, scenario)
            val generated = vault.read().single { it.getString("username") == "new-synthetic@example.test" }
            assertTrue(generated.getString("password").contains('.'))
            val app = NativeAppIdentity.read(context, instrumentation.context.packageName)!!
            assertEquals(2, vault.associatedEntries(app).size)
            vault.revokeApp(app.packageName); assertTrue(vault.associatedEntries(app).isEmpty())
            vault.delete(id); vault.delete(generated.getString("id")); vault.deleteProfile(id); vault.lock()
        }
    }

}
