package app.heavenkey.heavenkey_mobile

import org.json.JSONObject
import java.time.Instant

internal object FormProfiles {
    val limits = linkedMapOf("id" to 80, "label" to 120, "givenName" to 120,
        "familyName" to 120, "fullName" to 240, "email" to 320, "phone" to 80,
        "company" to 240, "addressLine1" to 240, "addressLine2" to 240,
        "postalCode" to 32, "city" to 120, "region" to 120, "country" to 2, "updatedAt" to 80)
    val dataFields = limits.keys - setOf("id", "label", "updatedAt")

    fun validate(profile: JSONObject) {
        if (profile.length() != limits.size) throw VaultFailure("invalid_profile")
        for ((field, limit) in limits) {
            val value = profile.opt(field)
            if (value !is String || value.length > limit || value.any { it.isISOControl() })
                throw VaultFailure("invalid_profile")
        }
        if (!Regex("^[A-Za-z0-9_-]{1,80}$").matches(profile.getString("id")) ||
            profile.getString("label").isBlank() || dataFields.all { profile.getString(it).isBlank() } ||
            !Regex("^([A-Z]{2})?$").matches(profile.getString("country"))) throw VaultFailure("invalid_profile")
        try { Instant.parse(profile.getString("updatedAt")) }
        catch (_: Exception) { throw VaultFailure("invalid_profile") }
    }

    fun validateAll(values: List<JSONObject>) {
        if (values.size > 100 || values.map { it.optString("id") }.toSet().size != values.size)
            throw VaultFailure("invalid_profile")
        values.forEach(::validate)
    }

    fun merge(current: List<JSONObject>, incoming: List<JSONObject>, replace: Boolean): List<JSONObject> {
        validateAll(current); validateAll(incoming)
        val merged = linkedMapOf<String, JSONObject>()
        current.forEach { merged[it.getString("id")] = it }
        incoming.forEach { if (replace || !merged.containsKey(it.getString("id"))) merged[it.getString("id")] = it }
        return merged.values.toList().also(::validateAll)
    }
}
