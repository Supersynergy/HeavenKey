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
import android.view.autofill.AutofillId
import android.widget.RemoteViews
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

internal data class FillTarget(val origin: String, val browser: String,
    val username: AutofillId, val password: AutofillId)
internal data class PendingFill(val target: FillTarget, val expires: Long)
internal object FillRequests {
    private val requests = ConcurrentHashMap<String, PendingFill>()
    @Synchronized fun add(target: FillTarget): String {
        val now = SystemClock.elapsedRealtime()
        requests.entries.removeIf { it.value.expires <= now }
        if (requests.size >= 16) requests.clear()
        val nonce = UUID.randomUUID().toString()
        requests[nonce] = PendingFill(target, now + 30_000)
        return nonce
    }
    fun remove(nonce: String) { requests.remove(nonce) }
    fun take(nonce: String): FillTarget? = requests.remove(nonce)
        ?.takeIf { it.expires > SystemClock.elapsedRealtime() }?.target
}
internal object FillPolicy {
    @Suppress("DEPRECATION")
    fun defaultBrowser(context: Context): String? {
        val resolved = context.packageManager.resolveActivity(Intent(Intent.ACTION_VIEW,
            Uri.parse("https://heavenkey.example")).addCategory(Intent.CATEGORY_BROWSABLE), PackageManager.MATCH_DEFAULT_ONLY)
            ?.activityInfo?.packageName
        return resolved?.takeUnless { it == "android" || it == context.packageName }
    }
    fun target(context: Context, structure: AssistStructure): FillTarget? {
        val browser = structure.activityComponent?.packageName ?: return null
        if (browser != defaultBrowser(context)) return null
        val origins = mutableSetOf<String>()
        val usernames = mutableSetOf<AutofillId>()
        val passwords = mutableSetOf<AutofillId>()
        var count = 0
        var invalid = false
        fun visit(node: AssistStructure.ViewNode, depth: Int) {
            if (++count > 4096 || depth > 32) { invalid = true; return }
            val domain = node.webDomain
            if (domain != null) {
                if (node.webScheme != "https") invalid = true
                else try {
                    val origin = OriginPolicy.canonical("https://$domain")
                    if (origin != "https://$domain".lowercase()) invalid = true else origins.add(origin)
                } catch (_: VaultFailure) { invalid = true }
            }
            val hints = node.autofillHints?.map { it.lowercase() }.orEmpty()
            val attributes = node.htmlInfo?.attributes?.mapNotNull { attribute ->
                val name = attribute.first?.lowercase()
                val value = attribute.second?.lowercase()
                if (name == null || value == null) null else name to value
            }?.toMap().orEmpty()
            val autocomplete = attributes["autocomplete"].orEmpty().split(' ')
            val variation = node.inputType and InputType.TYPE_MASK_VARIATION
            val isPassword = hints.any { it == "password" } || "current-password" in autocomplete ||
                attributes["type"] == "password" || variation == InputType.TYPE_TEXT_VARIATION_PASSWORD ||
                variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD
            val isUsername = hints.any { it == "username" || it == "emailaddress" } ||
                "username" in autocomplete || "email" in autocomplete || attributes["type"] == "email"
            if (node.autofillId != null && node.visibility == android.view.View.VISIBLE) {
                if (isPassword) passwords.add(node.autofillId!!)
                else if (isUsername) usernames.add(node.autofillId!!)
            }
            for (index in 0 until node.childCount) visit(node.getChildAt(index), depth + 1)
        }
        for (index in 0 until structure.windowNodeCount) visit(structure.getWindowNodeAt(index).rootViewNode, 0)
        if (invalid || origins.size != 1 || usernames.size != 1 || passwords.size != 1) return null
        return FillTarget(origins.single(), browser, usernames.single(), passwords.single())
    }
}

class HeavenAutofillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        if (cancellationSignal.isCanceled) { callback.onSuccess(null); return }
        val target = request.fillContexts.lastOrNull()?.structure?.let { FillPolicy.target(this, it) }
        if (target == null) { callback.onSuccess(null); return }
        val nonce = FillRequests.add(target)
        cancellationSignal.setOnCancelListener { FillRequests.remove(nonce) }
        val intent = Intent(this, AutofillActivity::class.java).putExtra("nonce", nonce)
            .setData(Uri.parse("heavenkey-autofill://challenge/$nonce"))
        val sender = PendingIntent.getActivity(this, 0, intent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE).intentSender
        val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1)
        presentation.setTextViewText(android.R.id.text1, "Mit HeavenKey entsperren")
        val lockedDataset = Dataset.Builder(presentation)
            .setValue(target.username, null).setValue(target.password, null)
            .setAuthentication(sender).build()
        callback.onSuccess(FillResponse.Builder().addDataset(lockedDataset).build())
    }
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        callback.onFailure("Neue Logins bitte in HeavenKey speichern.")
    }
}
