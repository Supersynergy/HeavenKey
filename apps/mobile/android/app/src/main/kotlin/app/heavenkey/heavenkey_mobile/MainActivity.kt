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
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        vault = VaultStore(this)
        super.onCreate(savedInstanceState)
    }
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "heavenkey/vault").setMethodCallHandler { call, result ->
            fun fail(code: String) = result.error(code, "HeavenKey konnte die Aktion nicht ausführen.", null)
            try {
                when (call.method) {
                    "status" -> result.success(mapOf("available" to true, "secureDevice" to vault.secureDevice(),
                        "autofillEnabled" to (getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true), "platform" to "android"))
                    "unlock" -> vault.authenticate(this) { error ->
                        if (error != null) fail(error) else try {
                            result.success(vault.read().map { value -> value.keys().asSequence().associateWith { value.getString(it) } })
                        } catch (failure: VaultFailure) { vault.lock(); fail(failure.code) }
                          catch (_: Exception) { vault.lock(); fail("corrupt_vault") }
                    }
                    "save" -> { vault.save(JSONObject(call.arguments as? Map<*, *> ?: throw VaultFailure("invalid_entry"))); result.success(null) }
                    "delete" -> { vault.delete(call.argument<String>("id") ?: throw VaultFailure("invalid_entry")); result.success(null) }
                    "copyPassword" -> { vault.copy(call.argument<String>("id") ?: throw VaultFailure("invalid_entry")); result.success(null) }
                    "lock" -> { vault.lock(); result.success(null) }
                    "enableAutofill" -> {
                        startActivity(Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE,
                            Uri.parse("package:${ComponentName(this, HeavenAutofillService::class.java).packageName}")))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (failure: VaultFailure) { fail(failure.code) }
              catch (_: Exception) { vault.lock(); fail("vault_error") }
        }
    }
    override fun onStop() { vault.lock(); super.onStop() }
    override fun onDestroy() { vault.lock(); super.onDestroy() }
}
