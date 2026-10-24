import Foundation

@main
struct MobileBackupTest {
    static func main() {
        var response: [String: Any]
        do {
            guard let request = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as? [String: Any],
                  let operation = request["operation"] as? String else { throw BackupError.invalidArchive }
            let key = request["key"] as? String ?? ""
            switch operation {
            case "newKey": response = ["key": MobileBackup.newKey()]
            case "checkKey": response = ["valid": MobileBackup.checkKey(key)]
            case "seal":
                guard let entries = request["entries"] as? [[String: String]] else { throw BackupError.invalidArchive }
                response = ["archive": try MobileBackup.seal(entries, recoveryKey: key), "fingerprint": try MobileBackup.fingerprint(entries)]
            case "open":
                guard let archive = request["archive"] as? String else { throw BackupError.invalidArchive }
                let entries = try MobileBackup.open(archive, recoveryKey: key)
                response = ["entries": entries, "fingerprint": try MobileBackup.fingerprint(entries)]
            case "fingerprint":
                guard let entries = request["entries"] as? [[String: String]] else { throw BackupError.invalidArchive }
                response = ["fingerprint": try MobileBackup.fingerprint(entries)]
            case "merge":
                guard let current = request["current"] as? [[String: String]],
                      let incoming = request["incoming"] as? [[String: String]],
                      let replace = request["replace"] as? Bool else { throw BackupError.invalidArchive }
                response = ["entries": try MobileBackup.merge(current, incoming: incoming, replaceExisting: replace)]
            default: throw BackupError.invalidArchive
            }
        } catch BackupError.invalidKey { response = ["error": "invalid_key"] }
        catch BackupError.tooLarge { response = ["error": "too_large"] }
        catch { response = ["error": "invalid_archive"] }
        do {
            let data = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        } catch { exit(1) }
    }
}
