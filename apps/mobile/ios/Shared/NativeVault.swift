import Foundation
import LocalAuthentication
import Security

final class NativeVault {
    private var authentication: LAContext?
    private var expires: TimeInterval = 0
    private var generation = 0
    private var timeout: DispatchWorkItem?
    private var pendingUnlock: ((Result<[[String: String]], VaultError>) -> Void)?
    private let service = "app.heavenkey.mobile.vault"

    var secureDevice: Bool {
        let context = LAContext()
        return context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }
    private func baseQuery() throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "HeavenKeyAccessGroup") as? String,
              !group.isEmpty, !group.contains("$"), !group.hasPrefix(".") else { throw VaultError.unavailable }
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                kSecAttrAccount as String: "vault-v1", kSecAttrAccessGroup as String: group,
                kSecAttrSynchronizable as String: false]
    }
    private func session() throws -> LAContext {
        guard let context = authentication, ProcessInfo.processInfo.systemUptime < expires else {
            lock(); throw VaultError.locked
        }
        return context
    }
    func unlock(_ complete: @escaping (Result<[[String: String]], VaultError>) -> Void) {
        lock()
        guard secureDevice else { complete(.failure(.deviceNotSecure)); return }
        let token = generation
        pendingUnlock = complete
        let context = LAContext()
        context.localizedCancelTitle = "Abbrechen"
        authentication = context
        let work = DispatchWorkItem { [weak self] in
            guard let self, token == self.generation else { return }
            self.lock()
        }
        timeout = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 60, execute: work)
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "HeavenKey entsperren und Login freigeben") { [weak self] success, _ in
            DispatchQueue.main.async {
                guard let self, token == self.generation else { return }
                self.timeout?.cancel(); self.timeout = nil
                guard success else { self.finish(.failure(.cancelled), token: token); return }
                context.interactionNotAllowed = true
                self.expires = ProcessInfo.processInfo.systemUptime + 60
                do { self.finish(.success(try self.read()), token: token) }
                catch let error as VaultError { self.finish(.failure(error), token: token) }
                catch { self.finish(.failure(.corruptVault), token: token) }
            }
        }
    }
    private func finish(_ result: Result<[[String: String]], VaultError>, token: Int) {
        guard token == generation, let complete = pendingUnlock else { return }
        pendingUnlock = nil
        timeout?.cancel(); timeout = nil
        if case .failure = result { lock() }
        complete(result)
    }
    func lock() {
        generation += 1; expires = 0
        timeout?.cancel(); timeout = nil
        authentication?.invalidate(); authentication = nil
        let complete = pendingUnlock; pendingUnlock = nil
        complete?(.failure(.cancelled))
    }
    func read() throws -> [[String: String]] {
        let context = try session()
        var query = try baseQuery()
        query[kSecUseAuthenticationContext as String] = context
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else {
            if status == errSecInteractionNotAllowed || status == errSecAuthFailed { throw VaultError.locked }
            throw VaultError.corruptVault
        }
        guard let data = value as? Data, data.count <= 16 * 1024 * 1024,
              let entries = try JSONSerialization.jsonObject(with: data) as? [[String: String]], entries.count <= 500
        else { throw VaultError.corruptVault }
        var ids = Set<String>()
        for entry in entries {
            try VaultPolicy.validate(entry)
            guard ids.insert(entry["id"]!).inserted else { throw VaultError.corruptVault }
        }
        return entries
    }
    private func write(_ entries: [[String: String]]) throws {
        let context = try session()
        guard entries.count <= 500 else { throw VaultError.invalidEntry }
        for entry in entries { try VaultPolicy.validate(entry) }
        let data = try JSONSerialization.data(withJSONObject: entries, options: [.sortedKeys])
        guard data.count <= 16 * 1024 * 1024 else { throw VaultError.full }
        var query = try baseQuery()
        query[kSecUseAuthenticationContext as String] = context
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var error: Unmanaged<CFError>?
            guard let control = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .userPresence, &error)
            else { throw VaultError.deviceNotSecure }
            query[kSecAttrAccessControl as String] = control
            query[kSecValueData as String] = data
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw VaultError.unavailable }
        } else if status != errSecSuccess { throw VaultError.unavailable }
    }
    func save(_ entry: [String: String]) throws {
        try VaultPolicy.validate(entry)
        var entries = try read()
        if let index = entries.firstIndex(where: { $0["id"] == entry["id"] }) { entries[index] = entry }
        else { entries.append(entry) }
        try write(entries)
    }
    func delete(_ id: String) throws { try write(read().filter { $0["id"] != id }) }
    func newBackupKey() throws -> String { _ = try read(); return MobileBackup.newKey() }
    func createBackup(_ recoveryKey: String) throws -> String {
        let archive = try MobileBackup.seal(read(), recoveryKey: recoveryKey)
        _ = try session()
        return archive
    }
    func inspectBackup(_ envelope: String, recoveryKey: String) throws -> [String: Any] {
        let current = try read()
        let incoming = try MobileBackup.open(envelope, recoveryKey: recoveryKey)
        _ = try session()
        let ids = Set(current.map { $0["id"]! })
        let existing = incoming.filter { ids.contains($0["id"]!) }.count
        return ["total": incoming.count, "new": incoming.count - existing, "existing": existing,
                "vaultFingerprint": try MobileBackup.fingerprint(current),
                "archiveFingerprint": try MobileBackup.archiveFingerprint(envelope),
                "entries": incoming.map { entry in Dictionary(uniqueKeysWithValues: ["id", "title", "origin", "username"].map { ($0, entry[$0]!) }) }]
    }
    func restoreBackup(_ envelope: String, recoveryKey: String, vaultFingerprint: String,
                       archiveFingerprint: String, replaceExisting: Bool) throws -> [[String: String]] {
        let current = try read()
        guard try MobileBackup.fingerprint(current) == vaultFingerprint,
              try MobileBackup.archiveFingerprint(envelope) == archiveFingerprint else { throw BackupError.vaultChanged }
        let incoming = try MobileBackup.open(envelope, recoveryKey: recoveryKey)
        let merged = try MobileBackup.merge(current, incoming: incoming, replaceExisting: replaceExisting)
        _ = try session()
        if try MobileBackup.fingerprint(merged) != vaultFingerprint { try write(merged) }
        return merged
    }
    deinit { lock() }
}
