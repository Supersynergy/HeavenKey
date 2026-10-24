package app.heavenkey.heavenkey_mobile

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.CancellationSignal
import android.os.SystemClock
import android.service.autofill.Dataset
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillId
import android.widget.RemoteViews
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private fun trace(context: Context, event: String) {
    if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
        android.util.Log.d("HeavenKeyAutofill", event)
}

internal data class FillTarget(val scope: WebHostScope, val browser: String,
    val username: AutofillId, val password: AutofillId)
internal data class PendingFill(val target: FillTarget, val challenge: FillChallenge)
internal object FillRequests {
    private val requests = ConcurrentHashMap<String, PendingFill>()
    @Synchronized fun add(pending: PendingFill): String {
        val now = SystemClock.elapsedRealtime()
        requests.entries.removeIf { !it.value.challenge.live(now) }
        if (requests.size >= 16) {
            requests.values.forEach { it.challenge.cancel() }; requests.clear()
        }
        val nonce = UUID.randomUUID().toString()
        requests[nonce] = pending
        return nonce
    }
    fun remove(nonce: String) { requests.remove(nonce)?.challenge?.cancel() }
    fun take(nonce: String): PendingFill? = requests.remove(nonce)
        ?.takeIf { it.challenge.live(SystemClock.elapsedRealtime()) }
}
internal object FillPolicy {
    @Suppress("DEPRECATION")
    fun defaultBrowser(context: Context): String? {
        val resolved = context.packageManager.resolveActivity(Intent(Intent.ACTION_VIEW,
            Uri.parse("https://heavenkey.example")).addCategory(Intent.CATEGORY_BROWSABLE), PackageManager.MATCH_DEFAULT_ONLY)
            ?.activityInfo?.packageName
        return resolved?.takeUnless { it == "android" || it == context.packageName }
    }
    fun trustedBrowser(context: Context, browser: String): Boolean =
        browser == defaultBrowser(context) && BrowserTrust.trusted(context, browser)

    fun target(context: Context, structure: AssistStructure): FillTarget? {
        val browser = structure.activityComponent?.packageName ?: return null
        if (!trustedBrowser(context, browser)) { trace(context, "browser rejected"); return null }
        val hosts = mutableSetOf<String>()
        val usernames = mutableSetOf<AutofillId>()
        val passwords = mutableSetOf<AutofillId>()
        var focused = false
        var count = 0
        var invalid = false
        fun visit(node: AssistStructure.ViewNode, depth: Int) {
            if (invalid) return
            if (++count > 4096 || depth > 32) { invalid = true; return }
            val scope = if (node.webDomain != null) WebOriginPolicy.legacy(node.webScheme, node.webDomain) else null
            if (node.webDomain != null && scope == null) { invalid = true; return }
            scope?.let { hosts.add(it.host) }
            val attributes = node.htmlInfo?.attributes?.mapNotNull { attribute ->
                attribute.first?.lowercase()?.let { it to attribute.second.orEmpty().lowercase() }
            }?.toMap().orEmpty()
            val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
            val autocomplete = attributes["autocomplete"].orEmpty().split(' ')
            val variation = node.inputType and InputType.TYPE_MASK_VARIATION
            val excluded = "new-password" in autocomplete || "new-password" in hints || "newpassword" in hints ||
                "one-time-code" in autocomplete || attributes["type"] == "hidden" ||
                "readonly" in attributes || "disabled" in attributes
            val password = hints.any { it == "password" } || "current-password" in autocomplete ||
                attributes["type"] == "password" || variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            val username = hints.any { it == "username" || it == "emailaddress" } ||
                "username" in autocomplete || "email" in autocomplete || attributes["type"] == "email"
            if (!excluded && (password || username) && node.visibility == View.VISIBLE && node.isEnabled && node.autofillId != null) {
                if (scope == null || node.htmlInfo == null) { invalid = true; return }
                if (password) passwords.add(node.autofillId!!) else usernames.add(node.autofillId!!)
                if (node.isFocused) focused = true
            }
            for (index in 0 until node.childCount) {
                if (invalid) break
                visit(node.getChildAt(index), depth + 1)
            }
        }
        for (index in 0 until structure.windowNodeCount) {
            if (invalid) break
            visit(structure.getWindowNodeAt(index).rootViewNode, 0)
        }
        trace(context, "parsed nodes=$count hosts=${hosts.size} usernames=${usernames.size} passwords=${passwords.size} focused=$focused invalid=$invalid")
        if (invalid || !focused || hosts.size != 1 || usernames.size != 1 || passwords.size != 1) return null
        return FillTarget(WebHostScope(hosts.single()), browser, usernames.single(), passwords.single())
    }
}

class HeavenAutofillService : AutofillService() {
    override fun onConnected() { super.onConnected(); trace(this, "connected") }
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        trace(this, "fill request contexts=${request.fillContexts.size} cancelled=${cancellationSignal.isCanceled}")
        if (cancellationSignal.isCanceled) { callback.onSuccess(null); return }
        val target = request.fillContexts.lastOrNull()?.structure?.let { FillPolicy.target(this, it) }
        if (target == null) { callback.onSuccess(null); return }
        val pending = PendingFill(target, FillChallenge(SystemClock.elapsedRealtime() + 30_000))
        val nonce = FillRequests.add(pending)
        cancellationSignal.setOnCancelListener { pending.challenge.cancel(); FillRequests.remove(nonce) }
        val intent = Intent(this, AutofillActivity::class.java).putExtra("nonce", nonce)
            .setData(Uri.parse("heavenkey-autofill://challenge/$nonce"))
        val sender = PendingIntent.getActivity(this, 0, intent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE).intentSender
        val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1)
        presentation.setTextViewText(android.R.id.text1, "Domainfreigabe mit HeavenKey prüfen")
        val lockedDataset = Dataset.Builder(presentation)
            .setValue(target.username, null).setValue(target.password, null)
            .setAuthentication(sender).build()
        callback.onSuccess(FillResponse.Builder().addDataset(lockedDataset).build())
    }
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        callback.onFailure("Neue Logins bitte in HeavenKey speichern.")
    }
}
