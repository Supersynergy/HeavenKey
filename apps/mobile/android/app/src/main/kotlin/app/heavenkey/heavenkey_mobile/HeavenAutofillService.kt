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
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.view.View
import android.view.autofill.AutofillId
import android.widget.RemoteViews
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

private fun trace(context: Context, event: String) {
    if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
        android.util.Log.d("HeavenKeyAutofill", event)
}

internal data class FillField(val id: AutofillId, val maximum: Int?)
internal data class FillTarget(val scope: WebHostScope?, val app: NativeAppIdentity,
    val fields: Map<String, List<FillField>>) {
    val signup: Boolean get() = "newPassword" in fields
    val hasLogin: Boolean get() = signup || "password" in fields || "username" in fields
    val profileFields: Set<String> get() = fields.keys.intersect(FormProfiles.dataFields)
    val label: String get() = scope?.host ?: app.packageName
    fun current(context: Context): Boolean = app.current(context) &&
        (if (scope != null) FillPolicy.trustedBrowser(context, app.packageName) else !NativeAppIdentity.isBrowser(context, app.packageName))
}
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
        val packageName = structure.activityComponent?.packageName ?: return null
        val app = NativeAppIdentity.read(context, packageName) ?: return null
        val browser = NativeAppIdentity.isBrowser(context, packageName)
        if (browser && !trustedBrowser(context, packageName)) return null
        val hosts = mutableSetOf<String>()
        val fields = linkedMapOf<String, MutableList<FillField>>()
        val seen = mutableSetOf<AutofillId>()
        var focused = false
        var count = 0
        var invalid = false
        fun visit(node: AssistStructure.ViewNode, depth: Int, ancestorsVisible: Boolean = true) {
            if (invalid) return
            if (++count > 4096 || depth > 32) { invalid = true; return }
            val scope = if (node.webDomain != null) WebOriginPolicy.legacy(node.webScheme, node.webDomain) else null
            if ((node.webDomain != null && scope == null) || (!browser && (node.webDomain != null || node.htmlInfo != null))) {
                invalid = true; return
            }
            scope?.let { hosts.add(it.host) }
            val attributes = node.htmlInfo?.attributes?.mapNotNull { attribute ->
                attribute.first?.lowercase()?.let { it to attribute.second.orEmpty() }
            }?.toMap().orEmpty()
            val visible = ancestorsVisible && node.visibility == View.VISIBLE && node.isEnabled
            val field = AutofillFields.classify(node.autofillHints?.toList().orEmpty(), attributes, node.inputType)
            if (field != null && visible && (browser || node.isFocusable) && node.autofillType == View.AUTOFILL_TYPE_TEXT && node.autofillId != null) {
                // A browser must supply a valid origin on every actual field; never infer it from an ancestor.
                if (browser && (scope == null || node.htmlInfo == null)) { invalid = true; return }
                val id = node.autofillId!!
                if (!seen.add(id)) { invalid = true; return }
                val maximum = attributes["maxlength"]?.toIntOrNull()?.takeIf { it >= 0 }
                fields.getOrPut(field) { mutableListOf() }.add(FillField(id, maximum))
                if (node.isFocused) focused = true
            }
            for (index in 0 until node.childCount) {
                if (invalid) break
                visit(node.getChildAt(index), depth + 1, visible)
            }
        }
        for (index in 0 until structure.windowNodeCount) {
            if (invalid) break
            visit(structure.getWindowNodeAt(index).rootViewNode, 0)
        }
        trace(context, "parsed nodes=$count fields=${fields.size} focused=$focused invalid=$invalid")
        if (invalid || !focused || !AutofillFields.unambiguous(fields.mapValues { it.value.size }) ||
            (browser && hosts.size != 1)) return null
        return FillTarget(if (browser) WebHostScope(hosts.single()) else null, app, fields)
    }
}

class HeavenAutofillService : AutofillService() {
    private var attribution: PendingIntent? = null
    override fun onDestroy() { attribution?.cancel(); super.onDestroy() }
    override fun onConnected() { super.onConnected(); trace(this, "connected") }
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        trace(this, "fill request contexts=${request.fillContexts.size} flags=${request.flags} cancelled=${cancellationSignal.isCanceled}")
        if (cancellationSignal.isCanceled) { callback.onSuccess(null); return }
        val target = request.fillContexts.lastOrNull()?.structure?.let { FillPolicy.target(this, it) }
        if (target == null) { callback.onSuccess(null); return }
        val pending = PendingFill(target, FillChallenge(SystemClock.elapsedRealtime() + 120_000))
        val nonce = FillRequests.add(pending)
        cancellationSignal.setOnCancelListener { pending.challenge.cancel(); FillRequests.remove(nonce) }
        val intent = Intent(this, AutofillActivity::class.java).putExtra("nonce", nonce)
            .setData(Uri.parse("heavenkey-autofill://challenge/$nonce"))
        val sender = PendingIntent.getActivity(this, 0, intent,
            PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE).intentSender
        val presentation = RemoteViews(packageName, android.R.layout.simple_list_item_1)
        presentation.setTextViewText(android.R.id.text1, "Mit HeavenKey ausfüllen")
        val builder = Dataset.Builder(presentation)
        target.fields.values.flatten().forEach { builder.setValue(it.id, null) }
        // A neutral locked chip reveals no account/profile data to the keyboard.
        // Unsupported IME templates retain the standard Android dropdown.
        try {
            val inline = request.inlineSuggestionsRequest
            val spec = inline?.inlinePresentationSpecs?.firstOrNull()
            // Explicit requests (including long-press Autofill) must remain usable
            // with a closed IME. Offer the dropdown instead of a keyboard-only chip.
            val manual = request.flags and FillRequest.FLAG_MANUAL_REQUEST != 0
            if (!manual && inline != null && inline.maxSuggestionCount > 0 && spec != null &&
                UiVersions.INLINE_UI_VERSION_1 in UiVersions.getVersions(spec.style)) {
                val source = attribution ?: PendingIntent.getActivity(this, 7130,
                    Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                    .also { attribution = it }
                val content = InlineSuggestionUi.newContentBuilder(source).setTitle("HeavenKey")
                    .setContentDescription("Mit HeavenKey ausfüllen").build()
                builder.setInlinePresentation(InlinePresentation(content.slice, spec, false))
            }
        } catch (_: Exception) { /* Malformed keyboard styling cannot disable the dropdown. */ }
        val lockedDataset = builder.setAuthentication(sender).build()
        callback.onSuccess(FillResponse.Builder().addDataset(lockedDataset).build())
    }
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        callback.onFailure("Neue Logins bitte in HeavenKey speichern.")
    }
}
