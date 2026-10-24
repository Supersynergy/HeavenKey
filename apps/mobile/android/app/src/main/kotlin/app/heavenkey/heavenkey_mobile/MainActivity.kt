package app.heavenkey.heavenkey_mobile

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.WindowManager
import android.view.autofill.AutofillManager
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONObject

class MainActivity : FlutterActivity() {
    private lateinit var vault: VaultStore
    private lateinit var backupFiles: BackupFiles
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        vault = VaultStore(this)
        backupFiles = BackupFiles(this) { vault.lock() }
        super.onCreate(savedInstanceState)
    }
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "heavenkey/vault").setMethodCallHandler { call, result ->
            fun fail(code: String) = result.error(code, "HeavenKey konnte die Aktion nicht ausführen.", null)
            try {
                when (call.method) {
                    "status" -> {
                        val browser = FillPolicy.defaultBrowser(this)
                        result.success(mapOf("available" to true, "secureDevice" to vault.secureDevice(),
                            "autofillEnabled" to (getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true),
                            "browserTrusted" to (browser != null && BrowserTrust.trusted(this, browser)),
                            "windowFocused" to hasWindowFocus(), "platform" to "android"))
                    }
                    "unlock" -> vault.authenticate(this) { error ->
                        if (error != null) fail(error) else try {
                            result.success(vault.read().map { value -> value.keys().asSequence().associateWith { value.getString(it) } })
                        } catch (failure: VaultFailure) { vault.lock(); fail(failure.code) }
                          catch (_: Exception) { vault.lock(); fail("corrupt_vault") }
                    }
                    "save" -> { vault.save(JSONObject(call.arguments as? Map<*, *> ?: throw VaultFailure("invalid_entry"))); result.success(null) }
                    "delete" -> { vault.delete(call.argument<String>("id") ?: throw VaultFailure("invalid_entry")); result.success(null) }
                    "copyPassword" -> { vault.copy(call.argument<String>("id") ?: throw VaultFailure("invalid_entry")); result.success(null) }
                    "newBackupKey" -> result.success(vault.newBackupKey())
                    "copyBackupKey" -> { vault.copyBackupKey(call.argument<String>("recoveryKey") ?: throw BackupFailure("invalid_key")); result.success(null) }
                    "createBackup" -> result.success(vault.createBackup(call.argument<String>("recoveryKey") ?: throw BackupFailure("invalid_key")))
                    "saveBackupFile" -> backupFiles.save(call.argument<String>("envelope") ?: throw BackupFailure("invalid_archive")) { value, error ->
                        if (error == null) result.success(value) else fail(error)
                    }
                    "loadBackupFile" -> backupFiles.load { value, error -> if (error == null) result.success(value) else fail(error) }
                    "inspectBackup" -> result.success(vault.inspectBackup(call.argument<String>("envelope") ?: throw BackupFailure("invalid_archive"),
                        call.argument<String>("recoveryKey") ?: throw BackupFailure("invalid_key")))
                    "restoreBackup" -> {
                        val replace = call.argument<Any>("replaceExisting")
                        if (replace != null && replace !is Boolean) throw BackupFailure("invalid_archive")
                        val restored = vault.restoreBackup(call.argument<String>("envelope") ?: throw BackupFailure("invalid_archive"),
                            call.argument<String>("recoveryKey") ?: throw BackupFailure("invalid_key"),
                            call.argument<String>("vaultFingerprint") ?: throw BackupFailure("vault_changed"),
                            call.argument<String>("archiveFingerprint") ?: throw BackupFailure("vault_changed"), replace == true)
                        result.success(restored.map { value -> value.keys().asSequence().associateWith { value.getString(it) } })
                    }
                    "lock" -> { vault.lock(); result.success(null) }
                    "enableAutofill" -> {
                        startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE,
                            Uri.parse("package:${ComponentName(this, HeavenAutofillService::class.java).packageName}")))
                        result.success(null)
                    }
                    "configureBrowser" -> {
                        val browser = FillPolicy.defaultBrowser(this) ?: throw VaultFailure("browser_untrusted")
                        if (!BrowserTrust.trusted(this, browser)) throw VaultFailure("browser_untrusted")
                        val settings = Intent(Intent.ACTION_APPLICATION_PREFERENCES)
                            .addCategory(Intent.CATEGORY_DEFAULT).addCategory(Intent.CATEGORY_APP_BROWSER)
                            .addCategory(Intent.CATEGORY_PREFERENCE).setPackage(browser)
                        if (settings.resolveActivity(packageManager) == null) throw VaultFailure("browser_configuration_unavailable")
                        startActivity(settings)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (failure: BackupFailure) { fail(failure.code) }
              catch (failure: VaultFailure) { fail(failure.code) }
              catch (_: Exception) { vault.lock(); fail("vault_error") }
        }
    }
    override fun onPause() { vault.clearClipboard(); super.onPause() }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) vault.clearClipboard()
    }
    override fun onStop() { vault.lock(); super.onStop() }
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        backupFiles.onActivityResult(requestCode, resultCode, data)
    }
    override fun onDestroy() { backupFiles.destroy(); vault.lock(); super.onDestroy() }
}
