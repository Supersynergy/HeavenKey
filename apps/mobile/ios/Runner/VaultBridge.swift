import Flutter
import UIKit
import AuthenticationServices
import CoreFoundation

final class VaultBridge: NSObject, FlutterPlugin {
    private let vault = NativeVault()
    private lazy var backupFiles = BackupFiles { [weak self] in self?.lock() }
    private var clipboardChange: Int?
    private var clipboardTimer: Timer?
    private var backgroundObserver: NSObjectProtocol?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var privacyCovers: [UIView] = []
    static func register(with registrar: FlutterPluginRegistrar) {
        let instance = VaultBridge()
        let channel = FlutterMethodChannel(name: "heavenkey/vault", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: channel)
        instance.backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak instance] _ in instance?.lock() }
        instance.lifecycleObservers = [
            NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak instance] _ in instance?.cover() },
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak instance] _ in instance?.uncover() }
        ]
    }
    private func uncover() { privacyCovers.forEach { $0.removeFromSuperview() }; privacyCovers = [] }
    private func cover() {
        uncover()
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows where window.isKeyWindow {
                let view = UIView(frame: window.bounds)
                view.backgroundColor = .systemBackground; view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                window.addSubview(view); privacyCovers.append(view)
            }
        }
    }
    private func lock() {
        vault.lock(); clipboardTimer?.invalidate(); clipboardTimer = nil
        if let change = clipboardChange, UIPasteboard.general.changeCount == change { UIPasteboard.general.items = [] }
        clipboardChange = nil
    }
    private func copyText(_ value: String) {
        UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: value]],
            options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(30)])
        clipboardChange = UIPasteboard.general.changeCount
        clipboardTimer?.invalidate()
        clipboardTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self else { return }
            if let change = self.clipboardChange, UIPasteboard.general.changeCount == change { UIPasteboard.general.items = [] }
            self.clipboardChange = nil
        }
    }
    private func filePresenter() throws -> UIViewController {
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) where scene.activationState == .foregroundActive {
            if let controller = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController { return controller }
        }
        throw VaultError.unavailable
    }
    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        func failureCode(_ code: String) {
            result(FlutterError(code: code, message: "HeavenKey konnte die Aktion nicht ausführen.", details: nil))
        }
        func failure(_ error: VaultError) {
            let codes: [VaultError: String] = [.locked: "locked", .cancelled: "cancelled", .deviceNotSecure: "device_not_secure",
                .corruptVault: "corrupt_vault", .invalidEntry: "invalid_entry", .unavailable: "vault_error", .full: "vault_full"]
            failureCode(codes[error] ?? "vault_error")
        }
        do {
            switch call.method {
            case "status":
                ASCredentialIdentityStore.shared.getState { state in DispatchQueue.main.async {
                    result(["available": true, "secureDevice": self.vault.secureDevice, "autofillEnabled": state.isEnabled, "platform": "ios"])
                } }
            case "unlock": vault.unlock { response in
                switch response { case .success(let entries): result(entries); case .failure(let error): failure(error) }
            }
            case "save":
                guard let entry = call.arguments as? [String: String] else { throw VaultError.invalidEntry }
                try vault.save(entry); result(nil)
            case "delete":
                guard let args = call.arguments as? [String: String], let id = args["id"] else { throw VaultError.invalidEntry }
                try vault.delete(id); result(nil)
            case "copyPassword":
                guard let args = call.arguments as? [String: String], let id = args["id"],
                      let entry = try vault.read().first(where: { $0["id"] == id }) else { throw VaultError.invalidEntry }
                copyText(entry["password"]!)
                result(nil)
            case "newBackupKey": result(try vault.newBackupKey())
            case "copyBackupKey":
                guard let args = call.arguments as? [String: String], let key = args["recoveryKey"] else { throw BackupError.invalidKey }
                _ = try vault.read()
                guard MobileBackup.checkKey(key) else { throw BackupError.invalidKey }
                copyText(key); result(nil)
            case "createBackup":
                guard let args = call.arguments as? [String: String], let key = args["recoveryKey"] else { throw BackupError.invalidKey }
                result(try vault.createBackup(key))
            case "saveBackupFile":
                guard let args = call.arguments as? [String: String], let envelope = args["envelope"] else { throw BackupError.invalidArchive }
                backupFiles.save(envelope, presenter: try filePresenter()) { value, error in
                    if let error { failureCode(error) } else { result(value) }
                }
            case "loadBackupFile":
                backupFiles.load(presenter: try filePresenter()) { value, error in
                    if let error { failureCode(error) } else { result(value) }
                }
            case "inspectBackup":
                guard let args = call.arguments as? [String: String], let envelope = args["envelope"], let key = args["recoveryKey"]
                else { throw BackupError.invalidArchive }
                result(try vault.inspectBackup(envelope, recoveryKey: key))
            case "restoreBackup":
                guard let args = call.arguments as? [String: Any], let envelope = args["envelope"] as? String,
                      let key = args["recoveryKey"] as? String, let current = args["vaultFingerprint"] as? String,
                      let archive = args["archiveFingerprint"] as? String else { throw BackupError.invalidArchive }
                var replaceExisting = false
                if let raw = args["replaceExisting"] {
                    guard let value = raw as? Bool, let number = raw as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID()
                    else { throw BackupError.invalidArchive }
                    replaceExisting = value
                }
                result(try vault.restoreBackup(envelope, recoveryKey: key, vaultFingerprint: current,
                    archiveFingerprint: archive, replaceExisting: replaceExisting))
            case "lock": lock(); result(nil)
            case "enableAutofill":
                if #available(iOS 17.0, *) {
                    ASSettingsHelper.openCredentialProviderAppSettings { error in DispatchQueue.main.async {
                        if error != nil { failure(.unavailable) } else { result(nil) }
                    } }
                } else { throw VaultError.unavailable }
            default: result(FlutterMethodNotImplemented)
            }
        } catch let error as BackupError {
            switch error {
            case .invalidKey: failureCode("invalid_key")
            case .invalidArchive: failureCode("invalid_archive")
            case .tooLarge: failureCode("too_large")
            case .vaultChanged: failureCode("vault_changed")
            }
        } catch let error as VaultError { failure(error) }
        catch { lock(); failure(.unavailable) }
    }
    deinit {
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) }
        backupFiles.destroy(); uncover(); lock()
    }
}
