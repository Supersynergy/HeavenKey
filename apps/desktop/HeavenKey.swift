import AppKit
import SwiftUI
import WebKit
import Darwin

private struct VaultChoices: View {
    @State var personal: Bool
    let select: (Bool) -> Void

    var body: some View {
        VStack(spacing: 8) {
            row("Standard", icon: "tray.full", personalVault: false)
            row("Persönlich", icon: "person", personalVault: true)
        }
        .padding(4)
    }

    private func row(_ title: String, icon: String, personalVault: Bool) -> some View {
        let selected = personal == personalVault
        return Button {
            personal = personalVault
            select(personalVault)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: icon).frame(width: 24).accessibilityHidden(true)
                Text(title).font(.headline)
                Spacer()
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(selected ? Color.accentColor.opacity(0.10) : Color(nsColor: .controlBackgroundColor),
                        in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12)
                .strokeBorder(selected ? Color.accentColor : Color(nsColor: .separatorColor)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// Keep the vault UI inside the backend origin; external pages never inherit its context.
func isVaultURL(_ url: URL, port: Int) -> Bool {
    url.scheme == "http" && url.host == "localhost" && url.port == port
        && url.user == nil && url.password == nil
}

enum LaunchError: Error { case invalidArguments }
func launchOptions(_ arguments: [String]) throws -> (Int, String?) {
    var port = 18240
    var data: String?
    var index = 0
    while index < arguments.count {
        let name = arguments[index]
        guard ["--port", "--data-dir"].contains(name), index + 1 < arguments.count else { throw LaunchError.invalidArguments }
        let value = arguments[index + 1]
        if name == "--port" {
            guard let number = Int(value), (1024...65535).contains(number) else { throw LaunchError.invalidArguments }
            port = number
        } else {
            guard value.hasPrefix("/"), !value.contains("\0") else { throw LaunchError.invalidArguments }
            data = value
        }
        index += 2
    }
    return (port, data)
}

func stopBackend(_ process: Process) -> Bool {
    guard process.isRunning else { return true }
    process.interrupt()
    func wait(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.025) }
    }
    wait(5)
    if process.isRunning { process.terminate(); wait(2) }
    if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL); wait(2) }
    return !process.isRunning
}

@MainActor
final class HeavenKeyApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var backend: Process?
    var output: Pipe?
    var port = 18240
    var dataDirectory: String?
    var ready = false
    var quitting = false
    var startupTimer: Timer?
    var startupOutput = ""
    var downloads: [WKDownload] = []
    var failed = false
    var webCrashCount = 0

    var choosing = false

    private func command(_ path: String, _ arguments: [String]) -> String? {
        let process = Process(), pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func selectProfile() -> (port: Int, directory: String, title: String)? {
        choosing = true
        defer { choosing = false }
        let alert = NSAlert()
        alert.messageText = "Tresor auswählen"
        alert.informativeText = "Du entsperrst den gewählten Tresor im nächsten Schritt."
        var personal = ready && port == 18246
        let choices = NSHostingView(rootView: VaultChoices(personal: personal) { personal = $0 })
        choices.frame = NSRect(x: 0, y: 0, width: 290, height: 112)
        alert.accessoryView = choices
        alert.addButton(withTitle: "Weiter")
        alert.addButton(withTitle: "Abbrechen").keyEquivalent = "\u{1b}"
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return (personal ? 18246 : 18240, support.appendingPathComponent(personal ? "HeavenKey-Persoenlich" : "HeavenKey").path, personal ? "Persönlich" : "Standard")
    }

    // Activate only our native app holding this database, never trust the port alone.
    private func activateExisting(port: Int, directory: String) -> Bool {
        guard let pid = command("/usr/sbin/lsof", ["-nP", "-t", "-iTCP:\(port)", "-sTCP:LISTEN"]),
              Int32(pid) != nil,
              command("/usr/sbin/lsof", ["-a", "-p", pid, directory + "/passwords.sqlite"]) != nil,
              let parent = command("/bin/ps", ["-p", pid, "-o", "ppid="]).flatMap(Int32.init),
              let owner = NSRunningApplication(processIdentifier: parent),
              owner.bundleURL?.standardizedFileURL == Bundle.main.bundleURL.standardizedFileURL else { return false }
        return owner.activate(options: [.activateAllWindows])
    }

    @objc func switchProfile() {
        guard !choosing, let profile = selectProfile() else { return }
        if activateExisting(port: profile.port, directory: profile.directory) { return }
        let options = NSWorkspace.OpenConfiguration()
        options.createsNewApplicationInstance = true
        options.arguments = ["--port", String(profile.port), "--data-dir", profile.directory]
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: options)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if ready && !choosing { switchProfile() }
        return false
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        installMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 840),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "HeavenKey"
        window.minSize = NSSize(width: 820, height: 600)
        window.contentView = web
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        do { (port, dataDirectory) = try launchOptions(Array(CommandLine.arguments.dropFirst())) }
        catch { fail("Ungültige Startoptionen. Verwende --port 1024…65535 und einen absoluten --data-dir-Pfad."); return }
        if CommandLine.arguments.dropFirst().isEmpty {
            guard let profile = selectProfile() else { NSApp.terminate(nil); return }
            if activateExisting(port: profile.port, directory: profile.directory) { NSApp.terminate(nil); return }
            port = profile.port
            dataDirectory = profile.directory
            window.title = "HeavenKey · " + profile.title
        }
        startBackend()
    }

    func installMenu() {
        let menu = NSMenu()
        let app = NSMenuItem(); menu.addItem(app)
        let appMenu = NSMenu(); app.submenu = appMenu
        appMenu.addItem(withTitle: "Über HeavenKey", action: #selector(about), keyEquivalent: "")
        appMenu.addItem(withTitle: "Tresor auswählen …", action: #selector(switchProfile), keyEquivalent: "o")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "HeavenKey beenden", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let edit = NSMenuItem(); menu.addItem(edit)
        let editMenu = NSMenu(title: "Bearbeiten"); edit.submenu = editMenu
        for (title, action, key) in [("Rückgängig", "undo:", "z"), ("Ausschneiden", "cut:", "x"), ("Kopieren", "copy:", "c"), ("Einfügen", "paste:", "v"), ("Alles auswählen", "selectAll:", "a")] {
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let view = NSMenuItem(); menu.addItem(view)
        let viewMenu = NSMenu(title: "Ansicht"); view.submenu = viewMenu
        viewMenu.addItem(withTitle: "Im Browser öffnen (z. B. für Passkeys)", action: #selector(openBrowser), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Neu laden und Tresor sperren", action: #selector(reload), keyEquivalent: "r")
        NSApp.mainMenu = menu
    }

    @objc func openBrowser() {
        if ready { NSWorkspace.shared.open(URL(string: "http://localhost:\(port)/passwords/")!) }
    }
    @objc func about() { NSApp.orderFrontStandardAboutPanel(options: [:]) }
    @objc func reload() { if ready { webCrashCount = 0; web.reload() } }

    func startBackend() {
        guard let executable = Bundle.main.url(forResource: "heavenkey", withExtension: nil) else {
            fail("Die App ist unvollständig. Lade das vollständige HeavenKey-Paket erneut."); return
        }
        let process = Process()
        process.executableURL = executable
        process.arguments = ["--password-manager", "--port", String(port)]
        if let dataDirectory { process.arguments! += ["--data-dir", dataDirectory] }
        // Finder can inherit development overrides. The app always starts a local vault.
        var environment = ProcessInfo.processInfo.environment
        for key in ["UAC_DATA", "UAC_PORT", "HEAVENKEY_ORIGIN", "HEAVENKEY_PUBLIC_ORIGIN", "HEAVENKEY_SHARE_ORIGIN"] { environment.removeValue(forKey: key) }
        process.environment = environment
        let pipe = Pipe(); process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        output = pipe; backend = process
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let bytes = handle.availableData
            guard !bytes.isEmpty else { handle.readabilityHandler = nil; return }
            let text = String(decoding: bytes, as: UTF8.self)
            DispatchQueue.main.async { self?.receive(text) }
        }
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                self.fail("Der lokale Tresor wurde beendet oder der Port \(self.port) ist belegt. Beende eine bereits laufende HeavenKey-Instanz und starte die App erneut. Deine gespeicherten Daten bleiben erhalten.")
            }
        }
        do { try process.run() }
        catch { fail("Der lokale Tresor konnte nicht gestartet werden. Prüfe, ob das vollständige App-Paket vorhanden ist."); return }
        startupTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: false) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.ready else { return }
                self.fail("Der lokale Tresor antwortet nicht. Beende die App und versuche es erneut.")
            }
        }
    }

    func receive(_ text: String) {
        guard !ready, !quitting else { return }
        startupOutput += text
        guard startupOutput.utf8.count <= 8192 else { fail("Unerwartete Startantwort."); return }
        let expected = "http://localhost:\(port)/passwords/"
        guard startupOutput.split(separator: "\n").contains(where: { $0.hasPrefix("HeavenKey ") && $0.hasSuffix(": " + expected) }), backend?.isRunning == true else { return }
        ready = true; startupOutput = ""; startupTimer?.invalidate()
        web.load(URLRequest(url: URL(string: expected)!))
    }

    func fail(_ message: String) {
        guard !quitting && !failed else { return }
        failed = true; ready = false; startupTimer?.invalidate()
        web.isHidden = true
        let alert = NSAlert(); alert.messageText = "HeavenKey konnte nicht starten"
        alert.informativeText = message
        alert.addButton(withTitle: "Beenden")
        alert.beginSheetModal(for: window) { _ in NSApp.terminate(nil) }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if ready && isVaultURL(url, port: port) {
            decisionHandler(action.shouldPerformDownload ? .download : .allow); return
        }
        if action.shouldPerformDownload && url.scheme == "blob" && url.absoluteString.hasPrefix("blob:http://localhost:\(port)/") {
            decisionHandler(.download); return
        }
        decisionHandler(.cancel)
        if action.navigationType == .linkActivated && url.scheme == "https" && url.user == nil && url.password == nil {
            NSWorkspace.shared.open(url)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self; downloads.append(download) }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self; downloads.append(download) }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel(); panel.nameFieldStringValue = (suggestedFilename as NSString).lastPathComponent
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func downloadDidFinish(_ download: WKDownload) { downloads.removeAll { $0 === download } }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) { downloads.removeAll { $0 === download } }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Reload starts with a locked vault; decrypted browser state is gone.
        if ready && !quitting {
            webCrashCount += 1
            if webCrashCount <= 1 { webView.reload() }
            else { fail("Die App-Ansicht wurde wiederholt beendet. Starte HeavenKey erneut. Dein Tresor bleibt verschlüsselt gespeichert.") }
        }
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard !quitting else { return .terminateNow }
        quitting = true; startupTimer?.invalidate(); output?.fileHandleForReading.readabilityHandler = nil
        guard let backend, backend.isRunning else { return .terminateNow }
        ready = false; web.isHidden = true
        DispatchQueue.global().async {
            let stopped = stopBackend(backend)
            DispatchQueue.main.async {
                sender.reply(toApplicationShouldTerminate: stopped)
                if !stopped {
                    self.quitting = false; self.failed = false
                    self.fail("Der eigene lokale Dienst konnte nicht beendet werden. HeavenKey bleibt geöffnet. Prüfe den Prozess, bevor du das Programm aktualisierst.")
                }
            }
        }
        return .terminateLater
    }
}

@main
struct Launcher {
    @MainActor static func main() {
        if CommandLine.arguments.contains("--self-test") {
            precondition(isVaultURL(URL(string: "http://localhost:18240/passwords/")!, port: 18240))
            for value in ["https://localhost:18240/", "http://localhost:18241/", "http://localhost.evil:18240/", "http://127.0.0.1:18240/", "file:///etc/passwd", "http://attacker@localhost:18240/"] {
                precondition(!isVaultURL(URL(string: value)!, port: 18240), value)
            }
            precondition((try! launchOptions(["--port", "18243", "--data-dir", "/tmp/test"])).0 == 18243)
            for args in [["--port", "0"], ["--port", "65536"], ["--port", "invalid"], ["--data-dir", "relative"], ["--port"], ["--unknown"]] {
                do { _ = try launchOptions(args); preconditionFailure("Invalid launch accepted") } catch { }
            }
            let stubborn = Process()
            stubborn.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
            stubborn.arguments = ["-c", "import signal,time; signal.signal(signal.SIGINT,signal.SIG_IGN); signal.signal(signal.SIGTERM,signal.SIG_IGN); print('ready',flush=True); time.sleep(30)"]
            let pipe = Pipe(); stubborn.standardOutput = pipe
            try! stubborn.run()
            _ = pipe.fileHandleForReading.availableData
            precondition(stopBackend(stubborn), "Owned stubborn backend survived shutdown escalation")
            print("Native navigation, launch and forced-shutdown boundaries: 15 cases passed")
        } else {
            let app = NSApplication.shared
            let delegate = HeavenKeyApp()
            app.delegate = delegate
            app.setActivationPolicy(.regular)
            app.run()
        }
    }
}
