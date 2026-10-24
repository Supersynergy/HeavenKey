package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.WindowManager
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.RemoteViews

class AutofillActivity : Activity() {
    private lateinit var vault: VaultStore
    private var completing = false
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        vault = VaultStore(this)
        val nonce = intent.getStringExtra("nonce") ?: run { finish(); return }
        val target = FillRequests.take(nonce) ?: run { finish(); return }
        if (target.browser != FillPolicy.defaultBrowser(this)) { finish(); return }
        vault.authenticate(this) { error ->
            if (error != null || isFinishing || isDestroyed) { finish(); return@authenticate }
            try {
                val entries = vault.read().filter { it.getString("origin") == target.origin }
                if (entries.isEmpty()) {
                    AlertDialog.Builder(this).setTitle("Kein passender Login")
                        .setMessage("Für ${target.origin} ist kein Login gespeichert.")
                        .setPositiveButton("Schließen") { _, _ -> finish() }.setOnCancelListener { finish() }.show()
                } else {
                    AlertDialog.Builder(this).setTitle(target.origin)
                        .setItems(entries.map { "${it.getString("title")} · ${it.getString("username")}" }.toTypedArray()) { _, index ->
                            try {
                                if (target.browser != FillPolicy.defaultBrowser(this)) { finish(); return@setItems }
                                val entry = vault.read().find { it.getString("id") == entries[index].getString("id") && it.getString("origin") == target.origin }
                                    ?: run { finish(); return@setItems }
                                val label = RemoteViews(packageName, android.R.layout.simple_list_item_1)
                                label.setTextViewText(android.R.id.text1, "HeavenKey")
                                val dataset = Dataset.Builder(label)
                                    .setValue(target.username, AutofillValue.forText(entry.getString("username")))
                                    .setValue(target.password, AutofillValue.forText(entry.getString("password"))).build()
                                completing = true
                                setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
                            } catch (_: Exception) { setResult(RESULT_CANCELED) }
                            finish()
                        }.setNegativeButton("Abbrechen") { _, _ -> finish() }.setOnCancelListener { finish() }.show()
                }
            } catch (_: Exception) { finish() }
        }
    }
    override fun onStop() { vault.lock(); if (!completing) finish(); super.onStop() }
    override fun onDestroy() { vault.lock(); super.onDestroy() }
}
