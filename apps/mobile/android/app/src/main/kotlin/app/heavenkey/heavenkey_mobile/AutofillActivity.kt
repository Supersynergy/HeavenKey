package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.service.autofill.Dataset
import android.text.InputType
import android.view.WindowManager
import android.view.View
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RemoteViews
import android.widget.ScrollView
import android.widget.Toast
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

class AutofillActivity : Activity() {
    private lateinit var vault: VaultStore
    private var pending: PendingFill? = null
    private var completing = false

    private fun debug(event: String) {
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
            android.util.Log.d("HeavenKeyAutofill", event)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= 31) window.setHideOverlayWindows(true)
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        vault = VaultStore(this)
        val nonce = intent.getStringExtra("nonce") ?: run { finish(); return }
        val request = FillRequests.take(nonce) ?: run { finish(); return }
        pending = request
        val target = request.target
        if (!target.current(this)) { finish(); return }
        val description = if (target.scope != null)
            "Der Browser meldet HTTPS und die Domain ${target.scope.host}. Er übermittelt keine verlässliche Trennung nach Port oder nach eingebetteten Formularen derselben Domain. Die Freigabe umfasst andere HTTPS-Ports dieser Domain. Prüfe die Website."
        else "Ziel-App: ${target.app.packageName}\n\nSignatur (SHA-256):\n${target.app.certificates.replace(",", "\n")}\n\nEin App-Name belegt keine Zugehörigkeit zu einer Website. Wähle nur Daten, die du dieser App anvertrauen möchtest."
        show(AlertDialog.Builder(this).setTitle("Ausfüllen einmalig freigeben?")
            .setMessage("$description\n\nDanach entsperrst du HeavenKey und wählst die Daten. Das Formular wird nicht abgesendet.")
            .setPositiveButton("Weiter") { _, _ ->
                if (request.challenge.confirm(SystemClock.elapsedRealtime()) && target.current(this)) unlock(request) else finish()
            }.setNegativeButton("Abbrechen") { _, _ -> finish() })
    }

    private fun show(builder: AlertDialog.Builder): AlertDialog {
        val dialog = builder.setOnCancelListener { finish() }.create()
        dialog.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog.show()
        listOf(AlertDialog.BUTTON_POSITIVE, AlertDialog.BUTTON_NEGATIVE, AlertDialog.BUTTON_NEUTRAL)
            .forEach { dialog.getButton(it)?.filterTouchesWhenObscured = true }
        dialog.listView?.filterTouchesWhenObscured = true
        return dialog
    }

    private fun valid(request: PendingFill): Boolean = request.challenge.authorized(SystemClock.elapsedRealtime()) &&
        request.target.current(this) && !isFinishing && !isDestroyed

    private fun unlock(request: PendingFill) {
        vault.authenticate(this) { error ->
            if (error != null || !valid(request)) { finish(); return@authenticate }
            try { menu(request) } catch (_: Exception) { fail() }
        }
    }

    private fun fail(message: String = "Freigabe abgelaufen oder Daten nicht verfügbar. Bitte erneut versuchen.") {
        if (isFinishing || isDestroyed) return
        show(AlertDialog.Builder(this).setTitle("Nicht ausgefüllt").setMessage(message)
            .setPositiveButton("Schließen") { _, _ -> finish() })
    }

    private fun menu(request: PendingFill) {
        if (!valid(request)) { finish(); return }
        val target = request.target
        val actions = mutableListOf<Pair<String, () -> Unit>>()
        if (target.hasLogin && !target.signup) {
            actions.add("Gespeicherten Login ausfüllen" to { chooseLogin(request, false) })
            if (target.scope == null) actions.add("Weiteren Login dieser App zuordnen" to { chooseLogin(request, true) })
        }
        if (target.signup) actions.add("Neues Passwort erzeugen und sichern" to { chooseGenerator(request) })
        if (target.profileFields.isNotEmpty()) actions.add("Formularprofil auswählen" to { chooseProfile(request) })
        if (actions.isEmpty()) { fail("Dieses Formular enthält keine eindeutig unterstützten Felder."); return }
        show(AlertDialog.Builder(this).setTitle("HeavenKey · ${target.label}")
            .setMessage(null)
            .setItems(actions.map { it.first }.toTypedArray()) { _, index ->
                try { if (valid(request)) actions[index].second() else finish() }
                catch (_: Exception) { fail() }
            }.setNegativeButton("Abbrechen") { _, _ -> finish() })
    }

    private fun chooseLogin(request: PendingFill, associate: Boolean) {
        if (!valid(request)) { finish(); return }
        val target = request.target
        val entries = when {
            target.scope != null -> vault.read().filter { target.scope.matches(it.getString("origin")) }
            associate -> vault.read()
            else -> vault.associatedEntries(target.app)
        }
        if (entries.isEmpty()) {
            if (target.scope == null && !associate) { chooseLogin(request, true); return }
            fail("Kein passender Login gespeichert. Lege zuerst einen Login in HeavenKey an."); return
        }
        show(AlertDialog.Builder(this).setTitle(if (associate) "Login für diese App wählen" else "Login auswählen")
            .setItems(entries.map { "${it.getString("title")} · ${it.getString("username")}\n${it.getString("origin")}" }.toTypedArray()) { _, index ->
                try {
                    if (!valid(request)) { finish(); return@setItems }
                    val entry = vault.read().find { it.getString("id") == entries[index].getString("id") }
                        ?: run { finish(); return@setItems }
                    if (target.scope != null && !target.scope.matches(entry.getString("origin"))) { finish(); return@setItems }
                    if (associate) {
                        show(AlertDialog.Builder(this).setTitle("Login dieser App anvertrauen?")
                            .setMessage("${entry.getString("origin")}\n${entry.getString("username")}\n\n→ ${target.app.packageName}\n\nDie Zuordnung gilt für diese installierte Signatur. Du kannst sie unter Autofill widerrufen. Jeder Vorgang benötigt weiterhin deine Freigabe.")
                            .setPositiveButton("Zuordnen und ausfüllen") { _, _ ->
                                try {
                                    if (!valid(request)) { finish(); return@setPositiveButton }
                                    vault.bindApp(entry.getString("id"), target.app)
                                    fillLogin(request, entry)
                                } catch (_: Exception) { fail() }
                            }.setNegativeButton("Abbrechen") { _, _ -> finish() })
                    } else fillLogin(request, entry)
                } catch (_: Exception) { fail() }
            }.setNegativeButton("Abbrechen") { _, _ -> finish() })
    }

    private fun fillLogin(request: PendingFill, entry: JSONObject) {
        val username = if ("username" in request.target.fields) "username" else "email"
        deliver(request, mapOf(username to entry.getString("username"),
            (if (request.target.signup) "newPassword" else "password") to entry.getString("password")))
    }

    private fun chooseProfile(request: PendingFill) {
        val profiles = vault.profiles().filter { profile -> request.target.profileFields.any { profile.getString(it).isNotBlank() } }
        if (profiles.isEmpty()) { fail("Kein passendes Formularprofil. Speichere zuerst Name, Kontakt oder Adresse unter Autofill in HeavenKey."); return }
        show(AlertDialog.Builder(this).setTitle("Formularprofil auswählen")
            .setItems(profiles.map { it.getString("label") }.toTypedArray()) { _, index ->
                try {
                    if (!valid(request)) { finish(); return@setItems }
                    val profile = vault.profiles().find { it.getString("id") == profiles[index].getString("id") }
                        ?: run { finish(); return@setItems }
                    val names = request.target.profileFields.filter { profile.getString(it).isNotBlank() }.sorted()
                    val checked = BooleanArray(names.size) { true }
                    show(AlertDialog.Builder(this).setTitle("Felder für ${request.target.label}")
                        .setMultiChoiceItems(names.map { "${AutofillFields.labels[it]}: ${profile.getString(it)}" }.toTypedArray(), checked) { _, which, selected -> checked[which] = selected }
                        .setPositiveButton("Ausgewählte Felder ausfüllen") { _, _ ->
                            try { deliver(request, names.filterIndexed { i, _ -> checked[i] }.associateWith { profile.getString(it) }) }
                            catch (_: Exception) { fail() }
                        }.setNegativeButton("Abbrechen") { _, _ -> finish() })
                } catch (_: Exception) { fail() }
            }.setNegativeButton("Abbrechen") { _, _ -> finish() })
    }

    private fun chooseGenerator(request: PendingFill) {
        if (!valid(request)) { finish(); return }
        show(AlertDialog.Builder(this).setTitle("Passwort erzeugen")
            .setItems(arrayOf("24 zufällige Zeichen", "6 merkbare Wörter · ca. 77,5 Bit", "8 merkbare Wörter · ca. 103,4 Bit")) { _, index ->
                try {
                    if (!valid(request)) { finish(); return@setItems }
                    val password = if (index == 0) PasswordGenerator.characters() else PasswordGenerator.phrase(this, if (index == 1) 6 else 8)
                    val limits = request.target.fields.getValue("newPassword").mapNotNull { it.maximum }
                    if (limits.any { password.length > it }) {
                        fail("Das Formular erlaubt zu wenige Zeichen für dieses Passwort. Wähle einen kürzeren Zeichengenerator in HeavenKey. Es wird nichts gekürzt."); return@setItems
                    }
                    saveGenerated(request, password)
                } catch (_: Exception) { fail() }
            }.setNegativeButton("Abbrechen") { _, _ -> finish() })
    }

    private fun saveGenerated(request: PendingFill, generated: String) {
        vault.read()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setPadding(32, 8, 32, 8)
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        fun input(label: String, value: String, type: Int): EditText = EditText(this).apply {
            hint = label; contentDescription = label; setText(value); inputType = type; isSingleLine = true
            isSaveEnabled = false; setSelectAllOnFocus(true); filterTouchesWhenObscured = true
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            layout.addView(this)
        }
        val origin = input("HTTPS-Website, ggf. mit Port", request.target.scope?.let { "https://${it.host}" }.orEmpty(), InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        val username = input("Benutzername oder E-Mail", "", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        val password = input("Erzeugtes Passwort", generated, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD).apply { isFocusable = false }
        layout.addView(CheckBox(this).apply {
            text = "Passwort anzeigen"; filterTouchesWhenObscured = true
            setOnCheckedChangeListener { _, checked -> password.inputType = InputType.TYPE_CLASS_TEXT or if (checked) InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD else InputType.TYPE_TEXT_VARIATION_PASSWORD }
        })
        val dialog = show(AlertDialog.Builder(this).setTitle("Vor dem Ausfüllen sichern")
            .setMessage("Das Passwort wird zuerst im Tresor gespeichert. Die Registrierung schließt du selbst ab. Englische EFF-Wortliste, CC BY 4.0. Freigabe läuft nach einer Minute ab.")
            .setView(ScrollView(this).apply { addView(layout) })
            .setPositiveButton("Sichern und ausfüllen", null).setNegativeButton("Abbrechen") { _, _ -> finish() })
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            try {
                if (!valid(request)) { debug("generation request no longer authorized"); finish(); return@setOnClickListener }
                val canonical = OriginPolicy.canonical(origin.text.toString().trim())
                if (request.target.scope != null && !request.target.scope.matches(canonical)) { origin.error = "Die Website muss zur angezeigten Domain gehören."; return@setOnClickListener }
                if (username.text.length > 320) { username.error = "Maximal 320 Zeichen."; return@setOnClickListener }
                val entry = JSONObject().put("id", UUID.randomUUID().toString()).put("title", request.target.label)
                    .put("origin", canonical).put("username", username.text.toString()).put("password", generated)
                    .put("notes", "Für Registrierung erzeugt. Abschluss beim Anbieter selbst prüfen.")
                    .put("updatedAt", Instant.now().toString())
                vault.save(entry)
                debug("generated login saved; usernamePresent=${entry.getString("username").isNotEmpty()}")
                if (request.target.scope == null) vault.bindApp(entry.getString("id"), request.target.app)
                Toast.makeText(this, "Passwort im Tresor gespeichert", Toast.LENGTH_SHORT).show()
                dialog.dismiss()
                fillLogin(request, entry)
            } catch (failure: VaultFailure) {
                if (failure.code == "invalid_entry") origin.error = "Eine gültige HTTPS-Website eingeben."
                else fail()
            } catch (_: Exception) { fail() }
        }
    }

    private fun deliver(request: PendingFill, values: Map<String, String>) {
        if (!valid(request)) { debug("delivery request no longer authorized"); finish(); return }
        vault.read() // The native authentication deadline remains authoritative.
        val selected = values.filterKeys { it in request.target.fields }
        debug("delivering field types=${selected.keys.sorted()}")
        if (selected.isEmpty()) { finish(); return }
        val label = RemoteViews(packageName, android.R.layout.simple_list_item_1)
        label.setTextViewText(android.R.id.text1, "HeavenKey")
        val dataset = Dataset.Builder(label)
        for ((name, value) in selected) for (field in request.target.fields.getValue(name)) {
            if (field.maximum != null && value.length > field.maximum) { fail("Ein ausgewählter Wert ist zu lang für das Formular. Es wird nichts gekürzt."); return }
            dataset.setValue(field.id, AutofillValue.forText(value))
        }
        if (!valid(request) || !request.challenge.consume(SystemClock.elapsedRealtime())) { finish(); return }
        completing = true
        setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset.build()))
        finish()
    }

    override fun onStop() { pending?.challenge?.cancel(); vault.lock(); if (!completing) finish(); super.onStop() }
    override fun onDestroy() { pending?.challenge?.cancel(); vault.lock(); super.onDestroy() }
}
