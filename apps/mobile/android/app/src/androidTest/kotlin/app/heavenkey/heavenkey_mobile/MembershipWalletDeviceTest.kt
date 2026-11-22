package app.heavenkey.heavenkey_mobile

import android.app.KeyguardManager
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.URI
import java.security.KeyFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class MembershipWalletDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val device = UiDevice.getInstance(instrumentation)
    private val syntheticPin = "417926"

    @Test fun realMembershipWallet() {
        val profile = testProfile()
        val arguments = InstrumentationRegistry.getArguments()
        val offer = profile.parseLink(requireNotNull(arguments.getString("walletOffer")) { "Missing walletOffer." })
        val project = profile.parseLink(requireNotNull(arguments.getString("walletProject")) { "Missing walletProject." })
        assertTrue(offer.issuance)
        assertFalse(project.issuance)
        unlockEmulator()

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val vault = VaultStore(context)
            val store = WalletStore(context)
            val protocol = MembershipProtocol(profile, store)
            val guard = guard(vault)

            authenticate(vault, scenario)
            val issuance = protocol.prepareIssue(offer, guard)
            authenticate(vault, scenario)
            val issued = protocol.issue(issuance, guard)
            assertEquals("issued", issued.status)
            val stored = store.records(guard).single { it.id == offer.id }
            val membership = protocol.credential(stored)
            assertTrue(membership.holderBound)
            assertEquals(WALLET_ORG, membership.claims["org_id"])
            assertEquals(WALLET_MEMBERSHIP, membership.claims["membership"])
            val holder = store.privateHolder(stored.id)
            assertTrue("The credential Holder-Key must not be exportable.", holder.encoded == null)
            assertEquals("EC", holder.algorithm)
            val keyStoreFactory = KeyFactory.getInstance("EC", "AndroidKeyStore")
            assertEquals("AndroidKeyStore", keyStoreFactory.provider.name)
            val keyInfo = keyStoreFactory.getKeySpec(holder, android.security.keystore.KeyInfo::class.java)
            assertTrue("The holder key must require device authentication.", keyInfo.isUserAuthenticationRequired)
            assertEquals(android.security.keystore.KeyProperties.PURPOSE_SIGN, keyInfo.purposes)
            assertTrue("The holder key must have a wallet-only alias.",
                keyInfo.keystoreAlias.startsWith("heavenkey-wallet-holder-v1-"))
            val file = File(context.noBackupFilesDir, "heavenkey-wallet-v1.aesgcm")
            assertTrue("The wallet must have a dedicated protected record.", file.isFile)
            assertFalse("The original SD-JWT must not appear in the file as plaintext.",
                file.readBytes().toString(Charsets.ISO_8859_1).contains(stored.original))

            val presentation = protocol.preparePresentation(project, guard)
            assertEquals("project.access", presentation.kind)
            assertEquals(setOf("org_id", "membership"), presentation.claims.keys)
            vault.lock()
            assertFalse("A prior authorization must end on lock.", vault.walletSessionActive())
            authenticate(vault, scenario)
            val resumed = protocol.preparePresentation(project, guard)
            assertEquals(presentation, resumed)
            authenticate(vault, scenario)
            val result = protocol.present(resumed, guard)
            assertEquals("verified", result.status)
            assertEquals(project.id, result.id)
            assertNotNull("A verified receipt must be persisted.", store.receipts(guard).singleOrNull { it.id == project.id })
        }
    }

    @Test fun realInvoiceConsent() {
        val profile = testProfile()
        val link = profile.parseLink(requireNotNull(InstrumentationRegistry.getArguments().getString("walletInvoice")) {
            "Missing walletInvoice."
        })
        assertFalse(link.issuance)
        unlockEmulator()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val vault = VaultStore(context)
            val store = WalletStore(context)
            val protocol = MembershipProtocol(profile, store)
            val guard = guard(vault)
            authenticate(vault, scenario)
            assertTrue("Complete the project membership with this wallet first.", store.receipts(guard).any {
                it.kind == "project.access" && it.status == "verified"
            })
            val plan = protocol.preparePresentation(link, guard)
            assertEquals("invoice.draft.create", plan.kind)
            assertEquals("supersynergy-demo", plan.operation["tenant"])
            assertEquals("order-demo-1", plan.operation["resource"])
            assertEquals("invoice-draft-agent", plan.operation["agent_id"])
            assertEquals(45_000L, plan.operation["amount_minor"])
            assertEquals("EUR", plan.operation["currency"])
            assertEquals(1, plan.operation["uses"])
            assertTrue(plan.operation["expiration"] as Long > walletNow())
            assertNotNull("The exact transaction must be bound to the holder proof.", plan.transactionHash)
            authenticate(vault, scenario)
            val result = protocol.present(plan, guard)
            assertEquals("verified", result.status)
            assertEquals("approved", result.actionStatus)
            assertEquals(link.id, result.id)
            assertTrue("The separate approval receipt must survive lock and process exit.",
                store.receipts(guard).any { it.id == link.id && it.actionStatus == "approved" })
        }
    }

    private fun testProfile(): WalletProfile {
        assertEquals("Run only on an isolated test emulator.", "1",
            device.executeShellCommand("getprop ro.kernel.qemu").trim())
        Configurator.getInstance().setWaitForIdleTimeout(1_000)
        val profile = requireNotNull(WalletProfile.load()) { "A public test wallet profile must be configured." }
        assertEquals("Only the fixture reached through adb reverse is accepted.", "127.0.0.1", URI(profile.origin).host)
        return profile
    }

    private fun guard(vault: VaultStore): () -> Unit = {
        assertTrue("Current device authentication is required.", vault.walletSessionActive())
        assertFalse("A locked device cannot use its credential.", deviceKeyguard().isDeviceLocked)
    }

    private fun authenticate(vault: VaultStore, scenario: ActivityScenario<MainActivity>) {
        val done = CountDownLatch(1)
        var failure: String? = "prompt_pending"
        scenario.onActivity { activity -> vault.authenticate(activity) { error -> failure = error; done.countDown() } }
        val pin = device.wait(Until.findObject(By.clazz("android.widget.EditText").pkg("com.android.systemui").focused(true)), 20_000)
            ?: error("The actual Android device-credential prompt did not appear.")
        pin.click()
        pin.text = syntheticPin
        device.pressEnter()
        assertTrue("Android authentication timed out.", done.await(30, TimeUnit.SECONDS))
        assertNull("Android did not approve device authentication.", failure)
        device.waitForIdle()
    }

    private fun deviceKeyguard(): KeyguardManager = context.getSystemService(KeyguardManager::class.java)

    private fun unlockEmulator() {
        device.wakeUp()
        if (!deviceKeyguard().isKeyguardLocked) return
        val digit = By.res("com.android.systemui", "key4")
        repeat(5) {
            if (!deviceKeyguard().isKeyguardLocked || device.hasObject(digit)) return@repeat
            device.swipe(device.displayWidth / 2, device.displayHeight * 9 / 10, device.displayWidth / 2,
                device.displayHeight / 10, 40)
            device.wait(Until.hasObject(digit), 2_000)
        }
        if (!deviceKeyguard().isKeyguardLocked) return
        for (character in syntheticPin) {
            val key = device.wait(Until.findObject(By.res("com.android.systemui", "key$character")), 5_000)
                ?: error("The test emulator lockscreen keypad did not appear.")
            key.click()
        }
        val enter = device.findObject(By.res("com.android.systemui", "key_enter"))
        if (enter == null) device.pressEnter() else enter.click()
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
        while (deviceKeyguard().isKeyguardLocked && System.nanoTime() < deadline) Thread.sleep(100)
        assertFalse("The test emulator PIN did not unlock the device.", deviceKeyguard().isKeyguardLocked)
    }
}
