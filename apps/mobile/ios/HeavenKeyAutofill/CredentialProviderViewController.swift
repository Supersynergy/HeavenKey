import AuthenticationServices
import UIKit

final class CredentialProviderViewController: ASCredentialProviderViewController, UITableViewDataSource, UITableViewDelegate {
    private let vault = NativeVault()
    private var origins = Set<String>()
    private var requestedID: String?
    private var entries: [[String: String]] = []
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private let message = UILabel()
    private let unlockButton = UIButton(type: .system)
    private var configuring = false
    private var busy = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        message.numberOfLines = 0; message.textAlignment = .center
        message.text = "HeavenKey · Login für diese Website auswählen"
        unlockButton.setTitle("Mit Gerätesperre entsperren", for: .normal)
        unlockButton.addTarget(self, action: #selector(unlock), for: .touchUpInside)
        let cancel = UIButton(type: .system)
        cancel.setTitle("Abbrechen", for: .normal)
        cancel.addTarget(self, action: #selector(cancelRequest), for: .touchUpInside)
        table.dataSource = self; table.delegate = self
        let stack = UIStackView(arrangedSubviews: [message, unlockButton, cancel, table])
        stack.axis = .vertical; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)])
        NotificationCenter.default.addObserver(self, selector: #selector(hideSecrets), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }
    private func origin(_ identifier: ASCredentialServiceIdentifier) -> String? {
        return try? VaultPolicy.serviceOrigin(identifier.identifier, isDomain: identifier.type == .domain)
    }
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        origins = Set(serviceIdentifiers.compactMap { origin($0) }); requestedID = nil
        if origins.count != 1 || serviceIdentifiers.contains(where: { origin($0) == nil }) { origins = [] }
    }
    override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) {
        guard let request = credentialRequest as? ASPasswordCredentialRequest,
              let identity = request.credentialIdentity as? ASPasswordCredentialIdentity,
              let target = origin(identity.serviceIdentifier), let id = identity.recordIdentifier
        else { cancel(.credentialIdentityNotFound); return }
        origins = [target]; requestedID = id
    }
    override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) {
        cancel(.userInteractionRequired)
    }
    override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
        guard let target = origin(credentialIdentity.serviceIdentifier), let id = credentialIdentity.recordIdentifier
        else { cancel(.credentialIdentityNotFound); return }
        origins = [target]; requestedID = id
    }
    override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) {
        cancel(.userInteractionRequired)
    }
    override func prepareInterfaceForExtensionConfiguration() {
        configuring = true
        loadViewIfNeeded()
        message.text = "HeavenKey in den Einstellungen für Automatisch ausfüllen & Passwörter aktivieren. Neue Logins werden in der HeavenKey-App gespeichert."
        unlockButton.setTitle("Fertig", for: .normal)
    }
    @objc private func unlock() {
        if configuring { extensionContext.completeExtensionConfigurationRequest(); return }
        guard origins.count == 1, !busy else { if origins.isEmpty { cancel(.credentialIdentityNotFound) }; return }
        busy = true; unlockButton.isEnabled = false
        vault.unlock { [weak self] response in
            guard let self else { return }
            self.busy = false; self.unlockButton.isEnabled = true
            switch response {
            case .failure: self.cancel(.userCanceled)
            case .success(let values):
                self.entries = values.filter { self.origins.contains($0["origin"] ?? "") && (self.requestedID == nil || $0["id"] == self.requestedID) }
                self.message.text = self.entries.isEmpty ? "Für diese Website ist kein Login gespeichert." : "Login für \(self.origins.first!) bestätigen"
                self.table.reloadData()
            }
        }
    }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { entries.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        cell.textLabel?.text = entries[indexPath.row]["title"]
        cell.detailTextLabel?.text = entries[indexPath.row]["username"]
        cell.accessoryType = .disclosureIndicator
        return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        do {
            let id = entries[indexPath.row]["id"]
            guard let entry = try vault.read().first(where: { $0["id"] == id && origins.contains($0["origin"] ?? "") })
            else { cancel(.credentialIdentityNotFound); return }
            let credential = ASPasswordCredential(user: entry["username"]!, password: entry["password"]!)
            hideSecrets()
            extensionContext.completeRequest(withSelectedCredential: credential, completionHandler: nil)
        } catch { cancel(.failed) }
    }
    @objc private func hideSecrets() { entries = []; table.reloadData(); vault.lock() }
    @objc private func cancelRequest() { cancel(.userCanceled) }
    private func cancel(_ code: ASExtensionError.Code) {
        hideSecrets()
        extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
    }
    deinit { NotificationCenter.default.removeObserver(self); vault.lock() }
}
