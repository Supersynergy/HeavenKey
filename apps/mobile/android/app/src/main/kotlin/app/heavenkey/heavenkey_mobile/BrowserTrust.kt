package app.heavenkey.heavenkey_mobile

import android.content.Context
import android.content.pm.PackageManager
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest

internal object BrowserTrust {
    fun signersMatch(pinned: Set<String>, actual: Set<String>): Boolean =
        actual.isNotEmpty() && actual.all { it in pinned }

    @Suppress("DEPRECATION")
    fun trusted(context: Context, browser: String): Boolean = try {
        val pins = context.assets.open("browser_trust.json").bufferedReader().use {
            JSONObject(it.readText()).optJSONArray(browser)
        }
        if (pins == null) false else {
            val expected = (0 until pins.length()).map { pins.getString(it) }.toSet()
            val info = context.packageManager.getPackageInfo(browser, PackageManager.GET_SIGNING_CERTIFICATES)
            val actual = info.signingInfo?.apkContentsSigners.orEmpty().map { signature ->
                MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())
                    .joinToString("") { "%02x".format(it.toInt() and 255) }
            }.toSet()
            signersMatch(expected, actual)
        }
    } catch (_: PackageManager.NameNotFoundException) { false }
      catch (_: SecurityException) { false }
      catch (_: IOException) { false }
      catch (_: org.json.JSONException) { false }
}
