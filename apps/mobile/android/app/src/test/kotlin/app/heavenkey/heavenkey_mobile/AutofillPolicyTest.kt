package app.heavenkey.heavenkey_mobile

import android.text.InputType
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], manifest = Config.NONE)
class AutofillPolicyTest {
    private fun field(hint: String) = AutofillFields.classify(listOf(hint), emptyMap(), InputType.TYPE_CLASS_TEXT)
    private fun html(token: String, extra: Map<String, String> = emptyMap()) =
        AutofillFields.classify(emptyList(), mapOf("autocomplete" to token) + extra, InputType.TYPE_CLASS_TEXT)
    private fun entry() = JSONObject().put("id", "synthetic").put("title", "Synthetic")
        .put("origin", "https://example.test").put("username", "synthetic@example.test")
        .put("password", "Synthetic-only-24!").put("notes", "").put("updatedAt", "2026-10-27T00:00:00Z")
    private fun profile() = JSONObject(FormProfiles.limits.keys.associateWith { when(it) {
        "id" -> "profile1"; "label" -> "Synthetic only"; "givenName" -> "Synthetisch";
        "country" -> "DE"; "updatedAt" -> "2026-10-27T00:00:00Z"; else -> ""
    } })
    private fun invalid(action: () -> Unit) { try { action(); fail("Unexpectedly accepted") } catch (_: VaultFailure) { } }

    @Test fun explicitLoginSignupAndProfileHintsAreRecognized() {
        assertEquals("username", field("newUsername"))
        assertEquals("newPassword", field("newPassword"))
        assertEquals("newPassword", html("section-register new-password"))
        assertEquals("givenName", field("personGivenName"))
        assertEquals("familyName", html("family-name"))
        assertEquals("addressLine1", html("shipping address-line1"))
        assertEquals("city", field("postalAddressLocality"))
        assertEquals("postalCode", html("postal-code"))
        assertEquals("phone", html("tel"))
        assertEquals("email", field("emailAddress"))
        assertNull(field("unknownLabel"))
    }
    @Test fun otpPaymentHiddenReadonlyAndConflictingHintsDoNotReceiveSecrets() {
        for (token in listOf("one-time-code", "cc-number", "bday", "off")) assertNull(html(token, mapOf("type" to "password")))
        for (hint in listOf("smsOTPCode", "emailOTPCode", "creditCardNumber", "birthDateFull")) assertNull(field(hint))
        assertNull(html("given-name", mapOf("readonly" to "")))
        assertNull(html("given-name", mapOf("disabled" to "")))
        assertNull(html("current-password", mapOf("type" to "hidden")))
        assertNull(AutofillFields.classify(listOf("username", "password"), emptyMap(), InputType.TYPE_CLASS_TEXT))
        assertNull(AutofillFields.classify(emptyList(), emptyMap(), InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD))
    }
    @Test fun ambiguousAndChangePasswordFormsFailClosedButRegistrationConfirmationWorks() {
        assertTrue(AutofillFields.unambiguous(mapOf("newPassword" to 2, "email" to 1)))
        assertTrue(AutofillFields.unambiguous(mapOf("givenName" to 1, "postalCode" to 1)))
        assertTrue(AutofillFields.unambiguous(mapOf("password" to 1)))
        for (counts in listOf(emptyMap(), mapOf("password" to 2), mapOf("email" to 2),
            mapOf("newPassword" to 3), mapOf("password" to 1, "newPassword" to 1),
            mapOf("password" to 1, "username" to 1, "email" to 1))) assertFalse(AutofillFields.unambiguous(counts))
    }
    @Test fun consentIsExpiringOneUseAndCancellationCannotBeReplayed() {
        val challenge = FillChallenge(100)
        assertFalse(challenge.authorized(1)); assertFalse(challenge.consume(1))
        assertTrue(challenge.confirm(2)); assertFalse(challenge.confirm(3))
        assertTrue(challenge.consume(4)); assertFalse(challenge.consume(5)); assertFalse(challenge.live(6))
        assertFalse(FillChallenge(10).confirm(10))
        val cancelled = FillChallenge(100); cancelled.confirm(1); cancelled.cancel()
        assertFalse(cancelled.consume(2)); assertFalse(cancelled.confirm(3))
    }
    @Test fun bindingsRequireExactEntryPackageAndCurrentSignerPins() {
        val binding = JSONObject().put("entryId", "synthetic").put("packageName", "app.example.client").put("certificates", "a".repeat(64))
        AppBindings.validateAll(listOf(binding), listOf(entry()))
        invalid { AppBindings.validateAll(listOf(binding), emptyList()) }
        invalid { AppBindings.validateAll(listOf(binding, binding), listOf(entry())) }
        invalid { AppBindings.validateAll(listOf(JSONObject(binding.toString()).put("certificates", "a".repeat(63))), listOf(entry())) }
        assertNotEquals(NativeAppIdentity("app.example.client", "a".repeat(64)), NativeAppIdentity("app.example.client", "b".repeat(64)))
        assertFalse(WebHostScope("example.test").matches("https://evil.example.test"))
        assertNull(WebOriginPolicy.legacy("http", "example.test"))
    }
    @Test fun profilesAreStrictAndMergeRetainsExistingDataByDefault() {
        val original = profile(); val changed = profile().put("givenName", "Neu")
        FormProfiles.validate(original)
        assertEquals("Synthetisch", FormProfiles.merge(listOf(original), listOf(changed), false).single().getString("givenName"))
        assertEquals("Neu", FormProfiles.merge(listOf(original), listOf(changed), true).single().getString("givenName"))
        invalid { FormProfiles.validate(profile().put("country", "Germany")) }
        invalid { FormProfiles.validate(profile().put("email", "a\nb")) }
        invalid { FormProfiles.validate(profile().put("unexpected", "secret")) }
        invalid { FormProfiles.validateAll(listOf(original, original)) }
    }
    @Test fun v3BackupEncryptsProfilesAndBindsThemToPreviewWithoutExportingAppTrust() {
        val key = MobileBackup.newKey(); val profile = profile()
        val archive = MobileBackup.sealFull(listOf(entry()), emptyList(), key, listOf(profile))
        assertEquals(3, JSONObject(archive).getInt("version"))
        assertFalse(archive.contains("Synthetisch"))
        val contents = MobileBackup.openFull(archive, key)
        assertEquals("Synthetisch", contents.profiles.single().getString("givenName"))
        assertEquals(1, contents.entries.size)
        assertTrue(MobileBackup.openFull(MobileBackup.sealFull(emptyList(), emptyList(), key), key).profiles.isEmpty())
        val before = MobileBackup.fullFingerprint(listOf(entry()), emptyList(), listOf(profile))
        assertNotEquals(before, MobileBackup.fullFingerprint(listOf(entry()), emptyList(), listOf(profile().put("city", "Neu"))))
        val binding = JSONObject().put("entryId", "synthetic").put("packageName", "app.example.client").put("certificates", "a".repeat(64))
        assertNotEquals(before, MobileBackup.fullFingerprint(listOf(entry()), emptyList(), listOf(profile), listOf(binding)))
        try { MobileBackup.openFull(JSONObject(archive).put("version", 2).toString(), key); fail("Version downgrade accepted") } catch (_: BackupFailure) { }
    }
    @Test fun passwordGenerationUsesBoundsAndEveryRequiredCharacterGroup() {
        repeat(20) {
            val generated = PasswordGenerator.characters()
            assertEquals(24, generated.length)
            for (group in listOf("[A-Z]", "[a-z]", "[2-9]", "[!@#%+_=?:-]")) assertTrue(Regex(group).containsMatchIn(generated))
        }
        try { PasswordGenerator.characters(12); fail("Too short") } catch (_: IllegalArgumentException) { }
    }
}
