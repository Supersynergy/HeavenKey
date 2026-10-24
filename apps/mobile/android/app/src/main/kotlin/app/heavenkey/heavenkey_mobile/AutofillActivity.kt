package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.service.autofill.Dataset
import android.view.WindowManager
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.RemoteViews

class AutofillActivity : Activity() {
    private lateinit var vault: VaultStore
    private var pending: PendingFill? = null
    private var completing = false
    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        vault = VaultStore(this)
        val nonce = intent.getStringExtra("nonce") ?: run { finish(); return }
        val request = FillRequests.take(nonce) ?: run { finish(); return }
        pending = request
        val target = request.target
        if (!FillPolicy.trustedBrowser(this, target.browser)) { finish(); return }
        AlertDialog.Builder(this).setTitle("Domain einmalig freigeben?")
            .setMessage("Der Browser meldet HTTPS und die Domain ${target.scope.host}. Er übermittelt keine verlässliche Trennung nach Port oder nach eingebetteten Formularen derselben Domain.\n\nDie Freigabe gilt nur für diesen Vorgang und umfasst andere HTTPS-Ports dieser Domain. Prüfe die Website vor dem Fortfahren.")
            .setPositiveButton("Einmal freigeben") { _, _ ->
                if (request.challenge.confirm(SystemClock.elapsedRealtime()) && FillPolicy.trustedBrowser(this, target.browser)) unlock(request) else finish()
            }.setNegativeButton("Abbrechen") { _, _ -> finish() }
            .setOnCancelListener { finish() }.show()
    }
    private fun valid(request: PendingFill): Boolean = request.challenge.authorized(SystemClock.elapsedRealtime()) &&
        FillPolicy.trustedBrowser(this, request.target.browser) && !isFinishing && !isDestroyed

    private fun unlock(request: PendingFill) {
        vault.authenticate(this) { error ->
            if (error != null || !valid(request)) { finish(); return@authenticate }
            val target = request.target
            try {
                val entries = vault.read().filter { target.scope.matches(it.getString("origin")) }
                if (entries.isEmpty()) {
                    AlertDialog.Builder(this).setTitle("Kein passender Login")
                        .setMessage("Für ${target.scope.host} ist kein HTTPS-Login gespeichert.")
                        .setPositiveButton("Schließen") { _, _ -> finish() }.setOnCancelListener { finish() }.show()
                } else {
                    AlertDialog.Builder(this).setTitle("Login für ${target.scope.host} auswählen")
                        .setItems(entries.map { "${it.getString("title")} · ${it.getString("username")}\n${it.getString("origin")}" }.toTypedArray()) { _, index ->
                            try {
                                if (!valid(request)) { finish(); return@setItems }
                                val entry = vault.read().find { it.getString("id") == entries[index].getString("id") && target.scope.matches(it.getString("origin")) }
                                    ?: run { finish(); return@setItems }
                                val label = RemoteViews(packageName, android.R.layout.simple_list_item_1)
                                label.setTextViewText(android.R.id.text1, "HeavenKey")
                                val dataset = Dataset.Builder(label)
                                    .setValue(target.username, AutofillValue.forText(entry.getString("username")))
                                    .setValue(target.password, AutofillValue.forText(entry.getString("password"))).build()
                                if (!request.challenge.consume(SystemClock.elapsedRealtime())) { finish(); return@setItems }
                                completing = true
                                setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
                            } catch (_: Exception) { setResult(RESULT_CANCELED) }
                            finish()
                        }.setNegativeButton("Abbrechen") { _, _ -> finish() }.setOnCancelListener { finish() }.show()
                }
            } catch (_: Exception) { finish() }
        }
    }
    override fun onStop() { pending?.challenge?.cancel(); vault.lock(); if (!completing) finish(); super.onStop() }
    override fun onDestroy() { pending?.challenge?.cancel(); vault.lock(); super.onDestroy() }
}
