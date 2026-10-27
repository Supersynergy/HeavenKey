package app.heavenkey.heavenkey_mobile

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import org.json.JSONObject
import java.security.MessageDigest

// An app label or a domain claimed by an app never establishes a credential association.
internal data class NativeAppIdentity(val packageName: String, val certificates: String) {
    fun current(context: Context): Boolean = read(context, packageName) == this

    companion object {
        @Suppress("DEPRECATION")
        fun read(context: Context, packageName: String): NativeAppIdentity? = try {
            if (packageName == context.packageName || packageName == "android" ||
                !Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+").matches(packageName)) null
            else {
                val info = context.packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                val pins = info.signingInfo?.apkContentsSigners.orEmpty().map { signature ->
                    MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                        .joinToString("") { "%02x".format(it.toInt() and 255) }
                }.sorted().distinct()
                if (pins.isEmpty() || pins.size > 4) null else NativeAppIdentity(packageName, pins.joinToString(","))
            }
        } catch (_: Exception) { null }

        @Suppress("DEPRECATION")
        fun isBrowser(context: Context, packageName: String): Boolean =
            packageName == FillPolicy.defaultBrowser(context) ||
                context.packageManager.queryIntentActivities(Intent(Intent.ACTION_VIEW, Uri.parse("https://example.test"))
                    .addCategory(Intent.CATEGORY_BROWSABLE), PackageManager.MATCH_ALL)
                    .any { it.activityInfo.packageName == packageName }
    }
}

internal object AppBindings {
    fun validateAll(values: List<JSONObject>, entries: List<JSONObject>) {
        val ids = entries.map { it.getString("id") }.toSet()
        val unique = mutableSetOf<String>()
        if (values.size > 1000) throw VaultFailure("invalid_entry")
        for (value in values) {
            val id = value.optString("entryId")
            val pkg = value.optString("packageName")
            val cert = value.optString("certificates")
            if (value.length() != 3 || value.keys().asSequence().any { value.opt(it) !is String } || id !in ids ||
                !Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+").matches(pkg) || pkg.length > 255 ||
                !Regex("[a-f0-9]{64}(,[a-f0-9]{64}){0,3}").matches(cert) ||
                cert.split(',') != cert.split(',').sorted().distinct() || !unique.add("$id/$pkg/$cert"))
                throw VaultFailure("invalid_entry")
        }
    }
}
