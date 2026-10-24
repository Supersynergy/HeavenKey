import Flutter
import UIKit
import AuthenticationServices

final class VaultBridge: NSObject, FlutterPlugin {
    private let vault = NativeVault()
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
    func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        func failure(_ error: VaultError) {
            let codes: [VaultError: String] = [.locked: "locked", .cancelled: "cancelled", .deviceNotSecure: "device_not_secure",
                .corruptVault: "corrupt_vault", .invalidEntry: "invalid_entry", .unavailable: "vault_error", .full: "vault_full"]
            result(FlutterError(code: codes[error] ?? "vault_error", message: "HeavenKey konnte die Aktion nicht ausführen.", details: nil))
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
                UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: entry["password"]!]],
                    options: [.localOnly: true, .expirationDate: Date().addingTimeInterval(30)])
                clipboardChange = UIPasteboard.general.changeCount
                clipboardTimer?.invalidate()
                clipboardTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                    guard let self else { return }
                    if let change = self.clipboardChange, UIPasteboard.general.changeCount == change { UIPasteboard.general.items = [] }
                    self.clipboardChange = nil
                }
                result(nil)
            case "lock": lock(); result(nil)
            case "enableAutofill":
                if #available(iOS 17.0, *) {
                    ASSettingsHelper.openCredentialProviderAppSettings { error in DispatchQueue.main.async {
                        if error != nil { failure(.unavailable) } else { result(nil) }
                    } }
                } else { throw VaultError.unavailable }
            default: result(FlutterMethodNotImplemented)
            }
        } catch let error as VaultError { failure(error) }
        catch { lock(); failure(.unavailable) }
    }
    deinit {
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) }
        uncover(); lock()
    }
}
