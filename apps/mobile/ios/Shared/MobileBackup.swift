import Foundation
import CoreFoundation
import CryptoKit

enum BackupError: Error { case invalidKey, invalidArchive, tooLarge, vaultChanged }

enum MobileBackup {
    private static let maxPlaintext = 16 * 1024 * 1024
    private static let maxEnvelope = 24 * 1024 * 1024
    private static let aad = Data("HeavenKey/mobile-backup/v1".utf8)
    private static let fields = ["id", "notes", "origin", "password", "title", "updatedAt", "username"]

    static func newKey() -> String {
        let key = SymmetricKey(size: .bits256)
        return "hk1_" + key.withUnsafeBytes { encode(Data($0)) }
    }

    static func checkKey(_ key: String) -> Bool { (try? keyBytes(key)) != nil }

    private static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private static func decode(_ value: String, maximum: Int) throws -> Data {
        guard value.utf8.count <= (maximum * 4 + 2) / 3, !value.isEmpty,
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 })
        else { throw BackupError.invalidArchive }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - value.utf8.count % 4) % 4)
        guard let data = Data(base64Encoded: padded), data.count <= maximum, encode(data) == value
        else { throw BackupError.invalidArchive }
        return data
    }

    private static func keyBytes(_ key: String) throws -> Data {
        guard key.hasPrefix("hk1_"), key.utf8.count == 47,
              let data = try? decode(String(key.dropFirst(4)), maximum: 32), data.count == 32
        else { throw BackupError.invalidKey }
        return data
    }

    private static func validate(_ entries: [[String: String]]) throws {
        guard entries.count <= 500 else { throw BackupError.invalidArchive }
        var ids = Set<String>()
        for entry in entries {
            do { try VaultPolicy.validate(entry) } catch { throw BackupError.invalidArchive }
            guard ids.insert(entry["id"]!).inserted else { throw BackupError.invalidArchive }
        }
    }

    private static func parts(_ envelope: String) throws -> (Data, Data) {
        guard envelope.utf8.count <= maxEnvelope else { throw BackupError.tooLarge }
        do {
            guard let header = try JSONSerialization.jsonObject(with: Data(envelope.utf8)) as? [String: Any],
                  Set(header.keys) == Set(["format", "version", "iv", "ciphertext"]),
                  header["format"] as? String == "heavenkey-mobile-backup", let version = header["version"] as? NSNumber,
                  CFGetTypeID(version) != CFBooleanGetTypeID(), !["d", "f"].contains(String(cString: version.objCType)), version.intValue == 1,
                  let iv = header["iv"] as? String, let ciphertext = header["ciphertext"] as? String
            else { throw BackupError.invalidArchive }
            let nonce = try decode(iv, maximum: 12)
            let encrypted = try decode(ciphertext, maximum: maxPlaintext + 16)
            guard nonce.count == 12, encrypted.count >= 16 else { throw BackupError.invalidArchive }
            return (nonce, encrypted)
        } catch let error as BackupError { throw error }
        catch { throw BackupError.invalidArchive }
    }

    static func checkArchive(_ envelope: String) throws { _ = try parts(envelope) }

    static func archiveFingerprint(_ envelope: String) throws -> String {
        guard envelope.utf8.count <= maxEnvelope else { throw BackupError.tooLarge }
        return SHA256.hash(data: Data(envelope.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    static func merge(_ current: [[String: String]], incoming: [[String: String]], replaceExisting: Bool) throws -> [[String: String]] {
        try validate(current); try validate(incoming)
        var merged = current
        var indices = Dictionary(uniqueKeysWithValues: current.enumerated().map { ($0.element["id"]!, $0.offset) })
        for entry in incoming {
            if let index = indices[entry["id"]!] {
                if replaceExisting { merged[index] = entry }
            } else {
                indices[entry["id"]!] = merged.count; merged.append(entry)
            }
        }
        guard merged.count <= 500 else { throw BackupError.tooLarge }
        return merged
    }

    static func seal(_ entries: [[String: String]], recoveryKey: String) throws -> String {
        let key = SymmetricKey(data: try keyBytes(recoveryKey))
        try validate(entries)
        var plaintext = try JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        guard plaintext.count <= maxPlaintext else { throw BackupError.tooLarge }
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: aad)
        let header: [String: Any] = ["format": "heavenkey-mobile-backup", "version": 1,
            "iv": encode(Data(sealed.nonce)), "ciphertext": encode(sealed.ciphertext + sealed.tag)]
        let envelope = try JSONSerialization.data(withJSONObject: header, options: [.sortedKeys])
        guard envelope.count <= maxEnvelope, let result = String(data: envelope, encoding: .utf8) else { throw BackupError.tooLarge }
        return result
    }

    static func open(_ envelope: String, recoveryKey: String) throws -> [[String: String]] {
        guard envelope.utf8.count <= maxEnvelope else { throw BackupError.tooLarge }
        let key = SymmetricKey(data: try keyBytes(recoveryKey))
        do {
            let (nonce, encrypted) = try parts(envelope)
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
            var plaintext = try AES.GCM.open(box, using: key, authenticating: aad)
            defer { plaintext.resetBytes(in: 0..<plaintext.count) }
            guard plaintext.count <= maxPlaintext else { throw BackupError.tooLarge }
            guard let entries = try JSONSerialization.jsonObject(with: plaintext) as? [[String: String]] else { throw BackupError.invalidArchive }
            try validate(entries)
            return entries
        } catch let error as BackupError { throw error }
        catch { throw BackupError.invalidArchive }
    }

    static func fingerprint(_ entries: [[String: String]]) throws -> String {
        try validate(entries)
        var digest = SHA256()
        func count(_ value: Int) {
            var length = UInt32(value).bigEndian
            withUnsafeBytes(of: &length) { digest.update(data: Data($0)) }
        }
        count(entries.count)
        for entry in entries.sorted(by: { $0["id"]! < $1["id"]! }) {
            for field in fields {
                let bytes = Data(entry[field]!.utf8)
                count(bytes.count); digest.update(data: bytes)
            }
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
