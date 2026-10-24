import Foundation

@main struct MobilePolicyTest {
    static func main() throws {
        let accepted = ["https://EXAMPLE.com:443/": "https://example.com", "https://example.com:8443": "https://example.com:8443"]
        for (input, expected) in accepted {
            let actual = try VaultPolicy.origin(input)
            precondition(actual == expected)
        }
        let rejected = ["http://example.com", "https://u:p@example.com", "https://example.com/a", "https://example.com?", "https://example.com#", "https://example.com.", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://éxample.com", " https://example.com", "https://ex%61mple.com", "https://example.com:0", "https://example.com:65536"]
        for input in rejected {
            do { _ = try VaultPolicy.origin(input); fatalError("unsafe origin accepted") }
            catch VaultError.invalidEntry { }
        }
        let entry = ["id": "synthetic1", "title": "Example", "origin": "https://example.com", "username": "demo", "password": "Synthetic-Only-24-Char", "notes": "", "updatedAt": "2026-10-24T12:00:00.000Z"]
        try VaultPolicy.validate(entry)
        let loginOrigin = try VaultPolicy.serviceOrigin("https://example.com/login?next=https://other.example", isDomain: false)
        precondition(loginOrigin == "https://example.com")
        precondition(VaultPolicy.credentialOrigin([("example.com", true)]) == nil)
        precondition(VaultPolicy.credentialOrigin([("https://example.com:8443/login", false)]) == "https://example.com:8443")
        precondition(VaultPolicy.credentialOrigin([("example.com", true), ("https://example.com:8443/login", false)]) == "https://example.com:8443")
        precondition(VaultPolicy.credentialOrigin([("https://example.com", false), ("https://example.com:8443", false)]) == nil)
        precondition(VaultPolicy.credentialOrigin([("http://example.com", false)]) == nil)
        var invalid = entry; invalid["password"] = ""
        do { try VaultPolicy.validate(invalid); fatalError("empty password accepted") } catch VaultError.invalidEntry { }
        print("Swift origin and record policy checks passed")
    }
}
