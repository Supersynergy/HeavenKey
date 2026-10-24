import Foundation

enum VaultError: Error, Hashable { case locked, cancelled, deviceNotSecure, corruptVault, invalidEntry, unavailable, full }

enum VaultPolicy {
    static func serviceOrigin(_ value: String, isDomain: Bool) throws -> String {
        if isDomain { return try origin("https://\(value)") }
        guard var parts = URLComponents(string: value) else { throw VaultError.invalidEntry }
        parts.path = ""; parts.query = nil; parts.fragment = nil
        guard let site = parts.string else { throw VaultError.invalidEntry }
        return try origin(site)
    }
    static func origin(_ value: String) throws -> String {
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              value.unicodeScalars.allSatisfy({ $0.value < 128 && !CharacterSet.whitespacesAndNewlines.contains($0) }),
              let parts = URLComponents(string: value), parts.scheme == "https", parts.user == nil,
              parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/", let host = parts.host?.lowercased(),
              host.count <= 253, !value.contains("%"), parts.port == nil || (1...65535).contains(parts.port!)
        else { throw VaultError.invalidEntry }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.count >= 2, host.range(of: "^[0-9.]+$", options: .regularExpression) == nil,
              labels.allSatisfy({ $0.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil })
        else { throw VaultError.invalidEntry }
        return "https://\(host)" + (parts.port == nil || parts.port == 443 ? "" : ":\(parts.port!)")
    }
    static func validate(_ entry: [String: String]) throws {
        let limits = ["id": 80, "title": 120, "origin": 2048, "username": 320, "password": 1024, "notes": 4096, "updatedAt": 80]
        guard entry.count == limits.count, limits.allSatisfy({ entry[$0.key] != nil && entry[$0.key]!.utf16.count <= $0.value }),
              entry["id"]!.range(of: "^[A-Za-z0-9_-]{1,80}$", options: .regularExpression) != nil,
              !entry["title"]!.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !entry["password"]!.isEmpty,
              try origin(entry["origin"]!) == entry["origin"] else { throw VaultError.invalidEntry }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard fractional.date(from: entry["updatedAt"]!) != nil || ISO8601DateFormatter().date(from: entry["updatedAt"]!) != nil
        else { throw VaultError.invalidEntry }
    }
}
