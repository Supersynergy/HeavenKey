package app.heavenkey.heavenkey_mobile

import java.net.URI
import java.time.Instant
import org.json.JSONObject

internal class VaultFailure(val code: String) : Exception(code)

internal object OriginPolicy {
    fun canonical(value: String): String {
        val uri = try { URI(value) } catch (_: Exception) { throw VaultFailure("invalid_entry") }
        val host = uri.host?.lowercase() ?: throw VaultFailure("invalid_entry")
        val labels = host.split('.')
        val label = Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
        if (value != value.trim() || uri.scheme != "https" || uri.rawUserInfo != null ||
            uri.rawQuery != null || uri.rawFragment != null || uri.rawAuthority.contains('%') ||
            (uri.rawPath.isNotEmpty() && uri.rawPath != "/") || host.length > 253 || labels.size < 2 ||
            labels.any { !label.matches(it) } || Regex("^[0-9.]+$").matches(host) ||
            (uri.port != -1 && uri.port !in 1..65535)) throw VaultFailure("invalid_entry")
        return "https://$host" + if (uri.port == -1 || uri.port == 443) "" else ":${uri.port}"
    }
    fun validate(entry: JSONObject) {
        val limits = mapOf("id" to 80, "title" to 120, "origin" to 2048, "username" to 320,
            "password" to 1024, "notes" to 4096, "updatedAt" to 80)
        if (entry.length() != limits.size) throw VaultFailure("invalid_entry")
        for ((field, limit) in limits) {
            val value = entry.opt(field)
            if (value !is String || value.length > limit) throw VaultFailure("invalid_entry")
        }
        if (!Regex("^[A-Za-z0-9_-]{1,80}$").matches(entry.getString("id")) ||
            entry.getString("title").isBlank() || entry.getString("password").isEmpty() ||
            canonical(entry.getString("origin")) != entry.getString("origin")) throw VaultFailure("invalid_entry")
        try { Instant.parse(entry.getString("updatedAt")) } catch (_: Exception) { throw VaultFailure("invalid_entry") }
    }
}

