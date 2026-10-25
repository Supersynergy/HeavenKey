package app.heavenkey.heavenkey_mobile

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], manifest = Config.NONE)
class PortableBackupTest {
    private fun login() = JSONObject().put("id", "synthetic-login").put("title", "Synthetic")
        .put("origin", "https://example.test").put("username", "synthetic@example.test")
        .put("password", "Synthetic-only-password-123!").put("notes", "Grüße 🔑")
        .put("updatedAt", "2026-10-25T00:00:00Z")

    private fun passkey(): JSONObject {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        return JSONObject().put("id", PasskeyProtocol.encode(ByteArray(32) { 42 }))
            .put("rpId", "example.test").put("userHandle", "AQ").put("userName", "synthetic@example.test")
            .put("userDisplayName", "Synthetic only").put("createdAt", "2026-10-25T00:00:00Z")
            .put("publicKey", PasskeyProtocol.encode(pair.public.encoded))
            .put("privateKey", PasskeyProtocol.encode(pair.private.encoded))
    }

    private fun rejected(action: () -> Unit) {
        try { action(); fail("Invalid archive was accepted") }
        catch (_: BackupFailure) { }
    }

    @Test fun standaloneRoundTripPreservesPrivateKeyAndLogins() {
        val key = MobileBackup.newKey(); val record = passkey(); val entry = login()
        val archive = MobileBackup.sealFull(listOf(entry), listOf(record), key)
        assertEquals(2, JSONObject(archive).getInt("version"))
        assertFalse(archive.contains(record.getString("privateKey")))
        assertFalse(archive.contains(entry.getString("password")))
        assertFalse(archive.contains(key))
        val opened = MobileBackup.openFull(archive, key)
        assertEquals(entry.getString("notes"), opened.entries.single().getString("notes"))
        assertEquals(record.getString("privateKey"), opened.passkeys.single().getString("privateKey"))
        PasskeyStore.validateRecord(opened.passkeys.single())
    }

    @Test fun oldLoginBackupsRemainReadableWithoutInventingPasskeys() {
        val key = MobileBackup.newKey()
        val archive = MobileBackup.seal(listOf(login()), key)
        val opened = MobileBackup.openFull(archive, key)
        assertEquals(1, opened.entries.size); assertTrue(opened.passkeys.isEmpty())
    }

    @Test fun wrongKeysTamperingAndVersionDowngradeAreRejected() {
        val key = MobileBackup.newKey()
        val archive = MobileBackup.sealFull(listOf(login()), listOf(passkey()), key)
        rejected { MobileBackup.openFull(archive, MobileBackup.newKey()) }
        val damaged = JSONObject(archive)
        val ciphertext = damaged.getString("ciphertext")
        damaged.put("ciphertext", (if (ciphertext[0] == 'A') "B" else "A") + ciphertext.substring(1))
        rejected { MobileBackup.openFull(damaged.toString(), key) }
        rejected { MobileBackup.openFull(JSONObject(archive).put("version", 1).toString(), key) }
        rejected { MobileBackup.openFull(JSONObject(archive).put("version", 3).toString(), key) }
    }

    @Test fun freshIvAndFullFingerprintBindBothStores() {
        val key = MobileBackup.newKey(); val record = passkey()
        val first = MobileBackup.sealFull(listOf(login()), listOf(record), key)
        val second = MobileBackup.sealFull(listOf(login()), listOf(record), key)
        assertNotEquals(JSONObject(first).getString("iv"), JSONObject(second).getString("iv"))
        val before = MobileBackup.fullFingerprint(listOf(login()), listOf(record))
        assertNotEquals(before, MobileBackup.fullFingerprint(listOf(login()), emptyList()))
        assertNotEquals(before, MobileBackup.fullFingerprint(listOf(login().put("password", "changed")), listOf(record)))
    }

    @Test fun duplicateIdsAndMismatchedKeyPairsCannotBeExported() {
        val key = MobileBackup.newKey(); val record = passkey()
        rejected { MobileBackup.sealFull(listOf(login(), login()), emptyList(), key) }
        rejected { MobileBackup.sealFull(emptyList(), listOf(record, record), key) }
        val mismatch = JSONObject(record.toString()).put("publicKey", passkey().getString("publicKey"))
        rejected { MobileBackup.sealFull(emptyList(), listOf(mismatch), key) }
    }

    @Test fun malformedHeadersAndOversizeAreRejectedBeforeDecryption() {
        val key = MobileBackup.newKey()
        val archive = MobileBackup.sealFull(emptyList(), emptyList(), key)
        rejected { MobileBackup.checkArchive(archive.dropLast(1) + ",\"version\":2}") }
        rejected { MobileBackup.checkArchive(JSONObject(archive).put("extra", true).toString()) }
        rejected { MobileBackup.checkArchive("x".repeat(24 * 1024 * 1024 + 1)) }
    }
}
