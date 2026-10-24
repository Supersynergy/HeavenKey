import Foundation
import UIKit
import UniformTypeIdentifiers

final class BackupFiles: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private final class Request {
        let saving: Bool
        let complete: (Any?, String?) -> Void
        let deadline = ProcessInfo.processInfo.systemUptime + 120
        private let mutex = NSLock()
        private var cancelled = false
        private var file: FileHandle?
        private var folder: URL?
        private var importedCopy: URL?
        var transferring = false
        init(saving: Bool, complete: @escaping (Any?, String?) -> Void) { self.saving = saving; self.complete = complete }
        func check() throws {
            mutex.lock(); let stopped = cancelled; mutex.unlock()
            if stopped || ProcessInfo.processInfo.systemUptime >= deadline { throw FileFailure.cancelled }
        }
        func use(_ handle: FileHandle) throws {
            mutex.lock()
            if cancelled { mutex.unlock(); try? handle.close(); throw FileFailure.cancelled }
            file = handle; mutex.unlock()
        }
        func use(_ directory: URL) throws {
            mutex.lock()
            if cancelled { mutex.unlock(); try? FileManager.default.removeItem(at: directory); throw FileFailure.cancelled }
            folder = directory; mutex.unlock()
        }
        func useCopy(_ url: URL) throws {
            mutex.lock()
            if cancelled { mutex.unlock(); try? FileManager.default.removeItem(at: url); throw FileFailure.cancelled }
            importedCopy = url; mutex.unlock()
        }
        func cleanup() {
            mutex.lock(); cancelled = true
            let handle = file; file = nil
            let directory = folder; folder = nil
            let copy = importedCopy; importedCopy = nil
            mutex.unlock()
            try? handle?.close()
            if let copy { try? FileManager.default.removeItem(at: copy) }
            if let directory { try? FileManager.default.removeItem(at: directory) }
        }
    }
    private enum FileFailure: Error { case cancelled }
    private let maximum = 24 * 1024 * 1024
    private let worker: OperationQueue = {
        let queue = OperationQueue(); queue.name = "app.heavenkey.backup-files"; queue.maxConcurrentOperationCount = 1
        queue.qualityOfService = .utility; return queue
    }()
    private var pending: Request?
    private var timeout: DispatchWorkItem?
    private var picker: UIDocumentPickerViewController?
    private let lockVault: () -> Void
    init(lockVault: @escaping () -> Void) { self.lockVault = lockVault; super.init() }

    private func begin(saving: Bool, complete: @escaping (Any?, String?) -> Void) -> Request? {
        guard pending == nil, worker.operationCount == 0 else { complete(nil, "backup_busy"); return nil }
        let request = Request(saving: saving, complete: complete)
        pending = request
        let deadline = DispatchWorkItem { [weak self, weak request] in
            guard let self, let request else { return }
            self.finish(request, value: nil, error: "cancelled")
        }
        timeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: deadline)
        lockVault()
        return request
    }

    func save(_ envelope: String, presenter: UIViewController, complete: @escaping (Any?, String?) -> Void) {
        do { try MobileBackup.checkArchive(envelope) }
        catch { complete(nil, code(error)); return }
        guard let request = begin(saving: true, complete: complete) else { return }
        worker.addOperation { [weak self, weak presenter] in
            guard let self else { request.cleanup(); return }
            do {
                try request.check()
                let folder = FileManager.default.temporaryDirectory.appendingPathComponent("heavenkey-backup-\(UUID().uuidString)", isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false,
                    attributes: [.protectionKey: FileProtectionType.complete])
                try request.use(folder)
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                var excludedFolder = folder; try excludedFolder.setResourceValues(values)
                let day = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
                let url = folder.appendingPathComponent("HeavenKey-\(day).hkb.json")
                try Data(envelope.utf8).write(to: url, options: [.atomic, .completeFileProtection])
                try request.check()
                DispatchQueue.main.async {
                    guard self.pending === request, let presenter else {
                        self.finish(request, value: nil, error: "cancelled"); request.cleanup(); return
                    }
                    self.present(UIDocumentPickerViewController(forExporting: [url], asCopy: true), from: presenter, request: request)
                }
            } catch {
                DispatchQueue.main.async { self.finish(request, value: nil, error: self.code(error)) }
            }
        }
    }

    func load(presenter: UIViewController, complete: @escaping (Any?, String?) -> Void) {
        guard let request = begin(saving: false, complete: complete) else { return }
        present(UIDocumentPickerViewController(forOpeningContentTypes: [.json], asCopy: true), from: presenter, request: request)
    }
    private func present(_ documentPicker: UIDocumentPickerViewController, from presenter: UIViewController, request: Request) {
        guard presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
            finish(request, value: nil, error: "backup_busy"); return
        }
        documentPicker.delegate = self
        picker = documentPicker
        presenter.present(documentPicker, animated: true)
        documentPicker.presentationController?.delegate = self
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard controller === picker, let request = pending, !request.transferring else { return }
        request.transferring = true
        if request.saving { finish(request, value: true, error: nil); return }
        guard urls.count == 1, let url = urls.first, url.isFileURL else { finish(request, value: nil, error: "invalid_archive"); return }
        do { try request.useCopy(url) } catch { finish(request, value: nil, error: "cancelled"); return }
        worker.addOperation { [weak self] in
            guard let self else { request.cleanup(); return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer {
                try? FileManager.default.removeItem(at: url)
                if scoped { url.stopAccessingSecurityScopedResource() }
            }
            do {
                try request.check()
                let resources = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard resources.isRegularFile == true else { throw BackupError.invalidArchive }
                if let size = resources.fileSize, size > self.maximum { throw BackupError.tooLarge }
                let input = try FileHandle(forReadingFrom: url)
                try request.use(input)
                defer { try? input.close() }
                var data = Data()
                while true {
                    try request.check()
                    guard let chunk = try input.read(upToCount: min(64 * 1024, self.maximum - data.count + 1)), !chunk.isEmpty else { break }
                    guard data.count + chunk.count <= self.maximum else { throw BackupError.tooLarge }
                    data.append(chunk)
                }
                guard let envelope = String(data: data, encoding: .utf8) else { throw BackupError.invalidArchive }
                try MobileBackup.checkArchive(envelope)
                try request.check()
                DispatchQueue.main.async { self.finish(request, value: envelope, error: nil) }
            } catch {
                DispatchQueue.main.async { self.finish(request, value: nil, error: self.code(error)) }
            }
        }
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard controller === picker, let request = pending else { return }
        finish(request, value: request.saving ? false : nil, error: nil)
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === picker, let request = pending else { return }
        finish(request, value: request.saving ? false : nil, error: nil)
    }
    private func code(_ error: Error) -> String {
        if case BackupError.tooLarge = error { return "too_large" }
        if case FileFailure.cancelled = error { return "cancelled" }
        return "invalid_archive"
    }
    private func finish(_ request: Request, value: Any?, error: String?) {
        guard pending === request else { return }
        pending = nil
        timeout?.cancel(); timeout = nil
        let activePicker = picker; picker = nil
        activePicker?.dismiss(animated: true)
        request.cleanup()
        request.complete(value, error)
    }
    func destroy() {
        if let request = pending { finish(request, value: nil, error: "cancelled") }
        worker.cancelAllOperations()
    }
    deinit { destroy() }
}
