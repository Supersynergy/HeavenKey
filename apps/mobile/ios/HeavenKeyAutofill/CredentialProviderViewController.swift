import AuthenticationServices
import UIKit

final class CredentialProviderViewController: ASCredentialProviderViewController, UITableViewDataSource, UITableViewDelegate {
    private let vault = NativeVault()
    private var origins = Set<String>()
    private var entries: [[String: String]] = []
    private let table = UITableView(frame: .zero, style: .insetGrouped)
    private let message = UILabel()
    private let unlockButton = UIButton(type: .system)
    private var configuring = false
    private var busy = false
    private var requestGeneration = 0
    private var requestDeadline: TimeInterval = 0
    private var active = false
    private var explanation = "Die Website konnte nicht eindeutig geprüft werden. HeavenKey gibt dafür kein Passwort frei."

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        message.numberOfLines = 0; message.textAlignment = .center
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
        render()
    }
    private var current: Bool { active && origins.count == 1 && ProcessInfo.processInfo.systemUptime < requestDeadline }
    private func render() {
        guard isViewLoaded else { return }
        message.text = explanation
        unlockButton.setTitle(configuring ? "Fertig" : "Mit Gerätesperre entsperren", for: .normal)
        unlockButton.isEnabled = configuring || (current && !busy)
    }
    override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
        hideSecrets(); configuring = false
        let target = VaultPolicy.credentialOrigin(serviceIdentifiers.map { ($0.identifier, $0.type == .domain) })
        origins = target.map { Set([$0]) } ?? []
        active = target != nil; requestDeadline = ProcessInfo.processInfo.systemUptime + 120
        explanation = target.map { "Login für \($0) auswählen" } ?? "iOS übermittelt keine eindeutige HTTPS-Herkunft. HeavenKey gibt dafür kein Passwort frei."
        render()
    }
    override func prepareInterfaceToProvideCredential(for credentialRequest: any ASCredentialRequest) { cancel(.credentialIdentityNotFound) }
    override func provideCredentialWithoutUserInteraction(for credentialRequest: any ASCredentialRequest) { cancel(.userInteractionRequired) }
    override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) { cancel(.credentialIdentityNotFound) }
    override func provideCredentialWithoutUserInteraction(for credentialIdentity: ASPasswordCredentialIdentity) { cancel(.userInteractionRequired) }
    override func prepareInterfaceForExtensionConfiguration() {
        hideSecrets(); configuring = true
        explanation = "HeavenKey in den Einstellungen für Automatisch ausfüllen & Passwörter aktivieren. Neue Logins werden in der HeavenKey-App gespeichert."
        loadViewIfNeeded(); render()
    }
    @objc private func unlock() {
        if configuring { extensionContext.completeExtensionConfigurationRequest(); return }
        guard current, !busy else { cancel(.credentialIdentityNotFound); return }
        let generation = requestGeneration
        let selectedOrigins = origins
        busy = true; render()
        vault.unlock { [weak self] response in
            guard let self, self.requestGeneration == generation, self.current, self.origins == selectedOrigins else { return }
            self.busy = false
            switch response {
            case .failure: self.cancel(.userCanceled)
            case .success(let values):
                self.entries = values.filter { selectedOrigins.contains($0["origin"] ?? "") }
                self.explanation = self.entries.isEmpty ? "Für diese Website ist kein Login gespeichert." : "Login für \(selectedOrigins.first!) bestätigen"
                self.table.reloadData(); self.render()
            }
        }
    }
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { entries.count }
    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        guard entries.indices.contains(indexPath.row) else { return cell }
        cell.textLabel?.text = entries[indexPath.row]["title"]
        cell.detailTextLabel?.text = entries[indexPath.row]["username"]
        cell.accessoryType = .disclosureIndicator
        return cell
    }
    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        guard current, !busy, entries.indices.contains(indexPath.row) else { cancel(.credentialIdentityNotFound); return }
        do {
            let id = entries[indexPath.row]["id"]
            guard let entry = try vault.read().first(where: { $0["id"] == id && origins.contains($0["origin"] ?? "") }), current
            else { cancel(.credentialIdentityNotFound); return }
            let credential = ASPasswordCredential(user: entry["username"]!, password: entry["password"]!)
            hideSecrets()
            extensionContext.completeRequest(withSelectedCredential: credential, completionHandler: nil)
        } catch { cancel(.failed) }
    }
    @objc private func hideSecrets() {
        requestGeneration += 1; active = false; origins = []; entries = []; busy = false
        table.reloadData(); vault.lock(); render()
    }
    @objc private func cancelRequest() { cancel(.userCanceled) }
    private func cancel(_ code: ASExtensionError.Code) {
        hideSecrets()
        extensionContext.cancelRequest(withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
    }
    deinit { NotificationCenter.default.removeObserver(self); vault.lock() }
}
