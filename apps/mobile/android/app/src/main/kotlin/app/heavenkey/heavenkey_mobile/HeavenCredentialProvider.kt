package app.heavenkey.heavenkey_mobile

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import android.os.SystemClock
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.*
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

internal object PasskeyCaller {
    fun origin(context: Context, caller: CallingAppInfo?): String {
        require(caller != null && caller.isOriginPopulated()) { "website_browser_required" }
        require(FillPolicy.trustedBrowser(context, caller.packageName)) { "untrusted_default_browser" }
        val pins = context.assets.open("browser_trust.json").bufferedReader().use { JSONObject(it.readText()) }
            .getJSONArray(caller.packageName)
        val signatures = JSONArray()
        for (i in 0 until pins.length()) signatures.put(JSONObject().put("build", "release")
            .put("cert_fingerprint_sha256", pins.getString(i).chunked(2).joinToString(":").uppercase()))
        val allowlist = JSONObject().put("apps", JSONArray().put(JSONObject().put("type", "android")
            .put("info", JSONObject().put("package_name", caller.packageName).put("signatures", signatures))))
        val origin = try { caller.getOrigin(allowlist.toString()) } catch (failure: Exception) { throw IllegalArgumentException("untrusted_privileged_origin", failure) }
            ?: throw IllegalArgumentException("missing_origin")
        return OriginPolicy.canonical(origin)
    }
    fun validate(context: Context, caller: CallingAppInfo?, json: String, hash: ByteArray?, create: Boolean): PasskeyRequest {
        require(hash != null && hash.size == 32) { "invalid_client_data_hash" }
        val origin = try { origin(context, caller) } catch (failure: Exception) { throw IllegalArgumentException("invalid_browser_origin", failure) }
        val options = try { PasskeyProtocol.options(json, create) } catch (failure: Exception) { throw IllegalArgumentException("invalid_webauthn_options", failure) }
        val rp = if (create) options.getJSONObject("rp").getString("id") else options.getString("rpId")
        // The browser enforces RP authorization, including Related Origin Requests.
        // The provider accepts the exact RP and verified HTTPS origin forwarded by that browser.
        return PasskeyRequest(caller!!.packageName, origin, rp, json, hash.copyOf(), create)
    }
}

internal data class PasskeyRequest(val browser: String, val origin: String, val rpId: String,
    val json: String, val hash: ByteArray, val create: Boolean) {
    fun identity(): String = PasskeyProtocol.encode(PasskeyProtocol.digest(
        (browser + "\u0000" + origin + "\u0000" + (if (create) "create" else "get") + "\u0000" + json).toByteArray(Charsets.UTF_8) + hash))
    fun replayId(): String = PasskeyProtocol.encode(PasskeyProtocol.digest(
        (browser + "\u0000" + origin + "\u0000" + rpId + "\u0000" + (if (create) "create" else "get") + "\u0000" +
            JSONObject(json).getString("challenge")).toByteArray(Charsets.UTF_8)))
}

internal object PasskeyTickets {
    class Ticket(val mode: String, val identities: Set<String>, val id: String?, val expires: Long, val parent: Ticket?) {
        @Volatile var cancelled = false
        var claimed = false
        fun active(): Boolean = !cancelled && SystemClock.elapsedRealtime() < expires && (parent?.active() != false)
    }
    private val tickets = mutableMapOf<String, Ticket>()
    @Synchronized fun issue(mode: String, requests: List<PasskeyRequest>, id: String? = null, parent: Ticket? = null): String {
        val now = SystemClock.elapsedRealtime()
        tickets.entries.removeAll { it.value.expires <= now }
        check(tickets.size < 1024)
        val token = PasskeyProtocol.encode(ByteArray(32).also { SecureRandom().nextBytes(it) })
        val ttl = requests.minOf { JSONObject(it.json).optDouble("timeout", 120_000.0).coerceAtMost(120_000.0).toLong() }
        tickets[token] = Ticket(mode, requests.map { it.identity() }.toSet(), id, minOf(now + ttl, parent?.expires ?: Long.MAX_VALUE), parent)
        return token
    }
    @Synchronized fun cancel(token: String) { tickets.remove(token)?.cancelled = true }
    @Synchronized fun take(token: String, mode: String, requests: List<PasskeyRequest>): Ticket {
        val ticket = tickets[token] ?: throw IllegalArgumentException("replayed_or_cancelled")
        require(!ticket.claimed && ticket.active() && ticket.mode == mode &&
            ticket.identities == requests.map { it.identity() }.toSet()) { "request_changed_or_expired" }
        ticket.claimed = true
        return ticket
    }
    @Synchronized fun clear() { tickets.values.forEach { it.cancelled = true }; tickets.clear() }
    fun pending(context: Context, token: String, mode: String): PendingIntent {
        val intent = Intent(context, PasskeyActivity::class.java).setAction("app.heavenkey.PASSKEY_$mode")
            .setData(Uri.parse("heavenkey://passkey/$token"))
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}

@RequiresApi(34)
class HeavenCredentialProvider : CredentialProviderService() {
    override fun onBeginCreateCredentialRequest(request: BeginCreateCredentialRequest, cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>) {
        var token: String? = null
        try {
            require(request is BeginCreatePublicKeyCredentialRequest)
            cancellationSignal.throwIfCanceled()
            val validated = PasskeyCaller.validate(this, request.callingAppInfo, request.requestJson, request.clientDataHash, true)
            token = PasskeyTickets.issue("create", listOf(validated))
            val current = token
            cancellationSignal.setOnCancelListener { PasskeyTickets.cancel(current) }
            cancellationSignal.throwIfCanceled()
            callback.onResult(BeginCreateCredentialResponse(listOf(CreateEntry("HeavenKey", PasskeyTickets.pending(this, token, "create")))))
        } catch (failure: Exception) {
            rejected("begin_create", failure)
            token?.let(PasskeyTickets::cancel)
            callback.onError(CreateCredentialUnknownException("Passkey request is unavailable"))
        }
    }
    override fun onBeginGetCredentialRequest(request: BeginGetCredentialRequest, cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>) {
        var token: String? = null
        try {
            cancellationSignal.throwIfCanceled()
            val options = request.beginGetCredentialOptions.filterIsInstance<BeginGetPublicKeyCredentialOption>()
            require(options.isNotEmpty() && options.size <= 32)
            val requests = options.map { PasskeyCaller.validate(this, request.callingAppInfo, it.requestJson, it.clientDataHash, false) }
            token = PasskeyTickets.issue("unlock", requests)
            val current = token
            cancellationSignal.setOnCancelListener { PasskeyTickets.cancel(current) }
            cancellationSignal.throwIfCanceled()
            callback.onResult(BeginGetCredentialResponse(authenticationActions = listOf(AuthenticationAction(
                "HeavenKey entsperren", PasskeyTickets.pending(this, token, "unlock")))))
        } catch (failure: Exception) {
            rejected("begin_get", failure)
            token?.let(PasskeyTickets::cancel)
            callback.onError(GetCredentialUnknownException("Passkey request is unavailable"))
        }
    }
    override fun onClearCredentialStateRequest(request: ProviderClearCredentialStateRequest, cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>) {
        PasskeyTickets.clear()
        callback.onResult(null)
    }
    private fun rejected(phase: String, failure: Exception) {
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE == 0) return
        val known = setOf("invalid_client_data_hash", "website_browser_required", "untrusted_default_browser", "missing_origin", "invalid_browser_origin", "invalid_webauthn_options", "unsupported_extensions", "untrusted_privileged_origin")
        val code = failure.message?.takeIf { it in known } ?: "invalid_request_options"
        val cause = failure.cause?.message?.takeIf { it in known } ?: "unspecified"
        android.util.Log.w("HeavenKeyPasskeys", "$phase:$code:$cause")
    }
}
