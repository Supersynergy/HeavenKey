package app.heavenkey.heavenkey_mobile

import java.net.URI

internal data class WebHostScope(val host: String) {
    fun matches(savedOrigin: String): Boolean = try {
        OriginPolicy.canonical(savedOrigin) == savedOrigin && URI(savedOrigin).host == host
    } catch (_: VaultFailure) { false }
}

internal object WebOriginPolicy {
    fun legacy(scheme: String?, domain: String?): WebHostScope? {
        if (scheme != "https" || domain == null || domain.length > 253 || ':' in domain) return null
        return try {
            val origin = OriginPolicy.canonical("https://$domain")
            if (origin != "https://${domain.lowercase()}") null else WebHostScope(URI(origin).host)
        } catch (_: VaultFailure) { null }
    }
}

internal class FillChallenge(private val expires: Long) {
    private enum class State { REQUESTED, CONFIRMED, USED, CANCELLED }
    private var state = State.REQUESTED
    @Synchronized fun live(now: Long): Boolean = now < expires && state != State.USED && state != State.CANCELLED
    @Synchronized fun confirm(now: Long): Boolean {
        if (!live(now) || state != State.REQUESTED) return false
        state = State.CONFIRMED; return true
    }
    @Synchronized fun authorized(now: Long): Boolean = live(now) && state == State.CONFIRMED
    @Synchronized fun consume(now: Long): Boolean {
        if (!authorized(now)) return false
        state = State.USED; return true
    }
    @Synchronized fun cancel() { state = State.CANCELLED }
}
