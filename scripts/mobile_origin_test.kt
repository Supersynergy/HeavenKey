package app.heavenkey.heavenkey_mobile

fun main() {
    var assertions = 0
    fun checkCase(condition: Boolean, name: String) { check(condition) { name }; assertions++ }
    val scope = WebOriginPolicy.legacy("https", "EXAMPLE.com")
    checkCase(scope?.host == "example.com", "exact ASCII host canonicalized")
    for (origin in listOf("https://example.com", "https://example.com:8443", "https://example.com:9443")) {
        checkCase(scope!!.matches(origin), "explicit host scope includes HTTPS port: $origin")
    }
    for (origin in listOf("http://example.com", "https://other.example", "https://sub.example.com", "https://example.com.evil.example", "https://u:p@example.com", "https://example.com/a", "https://example.com:0")) {
        checkCase(!scope!!.matches(origin), "host scope rejects: $origin")
    }
    for (domain in listOf("example.com:8443", "example.com.", "example.com/a", "example.com?x", "localhost", "127.0.0.1", "[::1]", "éxample.com", "ex%61mple.com", "u@example.com", " example.com", "example.com ", "", "a".repeat(254))) {
        checkCase(WebOriginPolicy.legacy("https", domain) == null, "invalid host hint rejected: $domain")
    }
    checkCase(WebOriginPolicy.legacy("http", "example.com") == null, "HTTP is never eligible")
    checkCase(WebOriginPolicy.legacy(null, "example.com") == null, "missing TLS claim rejected")
    checkCase(WebOriginPolicy.legacy("https", null) == null, "missing host rejected")
    checkCase(BrowserTrust.signersMatch(setOf("pinned"), setOf("pinned")), "pinned signer accepted")
    checkCase(!BrowserTrust.signersMatch(setOf("pinned"), emptySet()), "empty signer set denied")
    checkCase(!BrowserTrust.signersMatch(setOf("pinned"), setOf("other")), "forged signer denied")
    checkCase(!BrowserTrust.signersMatch(setOf("pinned"), setOf("pinned", "other")), "all current signers must be trusted")
    val challenge = FillChallenge(30_000)
    checkCase(!challenge.authorized(1), "no release before explicit consent")
    checkCase(!challenge.consume(1), "cannot consume unconfirmed request")
    checkCase(challenge.confirm(2), "fresh consent recorded")
    checkCase(!challenge.confirm(3), "confirmation is one-time")
    checkCase(challenge.authorized(4), "confirmed request eligible")
    checkCase(challenge.consume(5), "first release accepted")
    checkCase(!challenge.consume(6) && !challenge.authorized(6), "replay rejected")
    val cancelled = FillChallenge(30_000)
    cancelled.confirm(1); cancelled.cancel()
    checkCase(!cancelled.authorized(2) && !cancelled.consume(2), "cancel after consent revokes grant")
    val expired = FillChallenge(30_000)
    expired.confirm(1)
    checkCase(!expired.authorized(30_000) && !expired.consume(30_000), "deadline rechecked at release")
    checkCase(!FillChallenge(10).confirm(10), "expired consent rejected")
    println("Native adaptive host scope and one-time grant: $assertions cases passed")
}
