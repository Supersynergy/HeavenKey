package app.heavenkey.heavenkey_mobile

fun main() {
    val cases = listOf(
        Triple("https://example.com:8443/login", "example.com", "https://example.com:8443"),
        Triple("https://example.com/login?next=%2Fvault#form", "example.com", "https://example.com"),
        Triple("https://example.com:443/", "example.com", "https://example.com"),
        Triple("https://EXAMPLE.com:9443/a", "example.com", "https://example.com:9443"),
        Triple("https://other.example/login", "example.com", null),
        Triple("http://example.com/login", "example.com", null),
        Triple("example.com", "example.com", null),
        Triple("https://evil@example.com/", "example.com", null),
        Triple("https://%65xample.com/", "example.com", null),
        Triple("https://example.com:0/", "example.com", null),
        Triple("https://example.com:65536/", "example.com", null),
        Triple("https://example.com./", "example.com", null),
        Triple(null, "example.com", null),
        Triple("https://example.com/", "example.com:8443", null)
    )
    for ((url, host, expected) in cases) {
        val actual = WebOriginPolicy.resolve("https", host, url)
        check(actual == expected) { "origin regression: url=$url expected=$expected observed=$actual" }
    }
    check(WebOriginPolicy.resolve("http", "example.com", "https://example.com") == null)
    check(WebOriginPolicy.resolve("https", "example.com", "https://example.com/" + "a".repeat(8192)) == null)
    println("Native full-origin policy: ${cases.size + 2} cases passed")
}
