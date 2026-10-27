package app.heavenkey.heavenkey_mobile

import android.text.InputType

internal object AutofillFields {
    val labels = mapOf("username" to "Benutzername", "password" to "Passwort", "newPassword" to "Neues Passwort",
        "fullName" to "Name", "givenName" to "Vorname", "familyName" to "Nachname", "email" to "E-Mail",
        "phone" to "Telefon", "company" to "Firma", "addressLine1" to "Straße und Hausnummer",
        "addressLine2" to "Adresszusatz", "postalCode" to "Postleitzahl", "city" to "Ort",
        "region" to "Region", "country" to "Ländercode")
    private val hints = mapOf(
        "username" to "username", "newusername" to "username", "emailaddress" to "email",
        "password" to "password", "newpassword" to "newPassword", "passwordconfirmation" to "newPassword",
        "name" to "fullName", "personname" to "fullName", "persongivenname" to "givenName",
        "personnamegiven" to "givenName", "personfamilyname" to "familyName", "personnamefamily" to "familyName",
        "phonenumber" to "phone", "phone" to "phone", "organizationname" to "company",
        "postaladdress" to "addressLine1", "postaladdressstreetaddress" to "addressLine1",
        "postaladdressextendedaddress" to "addressLine2", "postaladdresspostalcode" to "postalCode",
        "postalcode" to "postalCode", "postaladdresslocality" to "city",
        "postaladdressregion" to "region", "postaladdresscountry" to "country")
    private val html = mapOf("username" to "username", "current-password" to "password", "new-password" to "newPassword",
        "name" to "fullName", "given-name" to "givenName", "family-name" to "familyName", "email" to "email",
        "tel" to "phone", "organization" to "company", "street-address" to "addressLine1",
        "address-line1" to "addressLine1", "address-line2" to "addressLine2", "postal-code" to "postalCode",
        "address-level2" to "city", "address-level1" to "region", "country" to "country")

    fun classify(rawHints: List<String>, attributes: Map<String, String>, inputType: Int): String? {
        val nativeHints = rawHints.map { it.lowercase() }
        val tokens = attributes["autocomplete"].orEmpty().lowercase().split(Regex("\\s+"))
        if (attributes["type"]?.lowercase() == "hidden" || "readonly" in attributes || "disabled" in attributes ||
            "off" in tokens || tokens.any { it == "one-time-code" || it.startsWith("cc-") || it.startsWith("bday") } ||
            nativeHints.any { it.contains("otp") || it.contains("onetime") || it.contains("creditcard") || it.contains("birth") }) return null
        val explicit = (nativeHints.mapNotNull { hints[it] } + tokens.mapNotNull { html[it] }).toSet()
        if (explicit.size > 1) return null
        if (explicit.isNotEmpty()) return explicit.single()
        val variation = inputType and InputType.TYPE_MASK_VARIATION
        val kind = inputType and InputType.TYPE_MASK_CLASS
        return when {
            attributes["type"] == "password" || (kind == InputType.TYPE_CLASS_TEXT && variation in setOf(InputType.TYPE_TEXT_VARIATION_PASSWORD, InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD)) -> "password"
            attributes["type"] == "email" || (kind == InputType.TYPE_CLASS_TEXT && variation == InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS) -> "email"
            else -> null
        }
    }

    fun unambiguous(counts: Map<String, Int>): Boolean = counts.isNotEmpty() &&
        counts.all { (field, count) -> count in 1..(if (field == "newPassword") 2 else 1) } &&
        !("password" in counts && "newPassword" in counts) &&
        !("password" in counts && "username" in counts && "email" in counts) &&
        !("newPassword" in counts && "username" in counts && "email" in counts)
}
