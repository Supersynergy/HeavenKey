package app.heavenkey.heavenkey_mobile

import java.net.URI

internal object WebOriginPolicy {
    fun resolve(scheme: String?, domain: String?, nativeUrl: String?): String? {
        if (scheme != "https" || domain == null || nativeUrl == null || nativeUrl.length > 8192 || nativeUrl != nativeUrl.trim()) return null
        return try {
            val reported = URI(OriginPolicy.canonical("https://$domain"))
            if (reported.port != -1) return null
            val complete = URI(nativeUrl)
            if (complete.scheme != "https" || complete.rawUserInfo != null || complete.rawAuthority == null) return null
            val origin = OriginPolicy.canonical("https://${complete.rawAuthority}")
            origin.takeIf { URI(it).host == reported.host }
        } catch (_: Exception) { null }
    }
}
