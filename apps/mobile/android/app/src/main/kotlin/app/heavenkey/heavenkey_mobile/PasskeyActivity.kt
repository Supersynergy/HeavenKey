package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.provider.*
import org.json.JSONObject

@RequiresApi(34)
class PasskeyActivity : Activity() {
    private lateinit var store: PasskeyStore
    private val handler = Handler(Looper.getMainLooper())
    private var token: String? = null
    private var completed = false
    private var resultSucceeded = false
    private var mode = ""
    private val timeout = Runnable { fail() }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        store = PasskeyStore(this)
        setResult(RESULT_CANCELED)
        mode = intent.action?.substringAfterLast('_').orEmpty()
        token = intent.data?.takeIf { it.scheme == "heavenkey" && it.host == "passkey" }?.lastPathSegment
        try {
            require(savedInstanceState == null && token != null)
            when (mode) {
                "create" -> prepareCreate()
                "unlock" -> prepareUnlock()
                "get" -> prepareGet()
                else -> fail()
            }
        } catch (_: Exception) { fail() }
    }
    private fun consent(title: String, request: PasskeyRequest, ticket: PasskeyTickets.Ticket, action: () -> Unit) {
        handler.postDelayed(timeout, (ticket.expires - SystemClock.elapsedRealtime()).coerceAtLeast(1))
        AlertDialog.Builder(this).setTitle(title).setMessage("${request.origin}\nPasskey für ${request.rpId}\nBrowser: ${request.browser}")
            .setNegativeButton("Abbrechen") { _, _ -> fail() }.setOnCancelListener { fail() }
            .setPositiveButton("Freigeben") { _, _ ->
                store.authenticate(this) { error ->
                    if (completed || isFinishing) return@authenticate
                    try {
                        require(error == null && ticket.active())
                        // Recheck browser role, installed signature and origin after user verification.
                        action()
                    } catch (_: Exception) { fail() }
                }
            }.show()
    }
    private fun prepareCreate() {
        val provider = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: error("missing_request")
        val option = provider.callingRequest as? CreatePublicKeyCredentialRequest ?: error("unsupported_request")
        require(!option.isConditional)
        val request = PasskeyCaller.validate(this, provider.callingAppInfo, option.requestJson, option.clientDataHash, true)
        val ticket = PasskeyTickets.take(token!!, "create", listOf(request))
        consent("Passkey erstellen", request, ticket) {
            val current = PasskeyCaller.validate(this, provider.callingAppInfo, option.requestJson, option.clientDataHash, true)
            require(current.identity() == request.identity())
            val response = store.create(JSONObject(request.json), request.hash, request.replayId())
            val result = Intent()
            PendingIntentHandler.setCreateCredentialResponse(result, CreatePublicKeyCredentialResponse(response))
            succeed(result)
        }
    }
    private fun prepareUnlock() {
        val provider = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent) ?: error("missing_request")
        val options = provider.beginGetCredentialOptions.filterIsInstance<BeginGetPublicKeyCredentialOption>()
        require(options.isNotEmpty() && options.size <= 32)
        val requests = options.map { PasskeyCaller.validate(this, provider.callingAppInfo, it.requestJson, it.clientDataHash, false) }
        val ticket = PasskeyTickets.take(token!!, "unlock", requests)
        consent("Passkeys anzeigen", requests.first(), ticket) {
            val entries = mutableListOf<PublicKeyCredentialEntry>()
            val records = store.metadata()
            options.zip(requests).forEach { (option, request) ->
                val current = PasskeyCaller.validate(this, provider.callingAppInfo, option.requestJson, option.clientDataHash, false)
                require(current.identity() == request.identity())
                val allowed = PasskeyProtocol.descriptors(JSONObject(request.json), "allowCredentials")
                records.filter { it.getString("rpId") == request.rpId && (allowed.isEmpty() || it.getString("id") in allowed) }.take((500 - entries.size).coerceAtLeast(0)).forEach { record ->
                    val next = PasskeyTickets.issue("get", listOf(request), record.getString("id"), ticket)
                    entries.add(PublicKeyCredentialEntry(this, record.getString("userName"),
                        PasskeyTickets.pending(this, next, "get"), option, displayName = record.getString("userDisplayName")))
                }
            }
            val result = Intent()
            PendingIntentHandler.setBeginGetCredentialResponse(result, BeginGetCredentialResponse(credentialEntries = entries))
            succeed(result)
        }
    }
    private fun prepareGet() {
        val provider = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: error("missing_request")
        val option = provider.credentialOptions.single() as? GetPublicKeyCredentialOption ?: error("unsupported_request")
        val request = PasskeyCaller.validate(this, provider.callingAppInfo, option.requestJson, option.clientDataHash, false)
        val ticket = PasskeyTickets.take(token!!, "get", listOf(request))
        consent("Mit Passkey anmelden", request, ticket) {
            val current = PasskeyCaller.validate(this, provider.callingAppInfo, option.requestJson, option.clientDataHash, false)
            require(current.identity() == request.identity())
            val response = store.assertion(ticket.id ?: error("missing_credential"), JSONObject(request.json), request.hash, request.replayId())
            val result = Intent()
            PendingIntentHandler.setGetCredentialResponse(result, GetCredentialResponse(PublicKeyCredential(response)))
            succeed(result)
        }
    }
    private fun succeed(result: Intent) {
        if (completed) return
        completed = true; resultSucceeded = true; handler.removeCallbacks(timeout); store.lock()
        setResult(RESULT_OK, result); finish()
    }
    private fun fail() {
        if (completed) return
        completed = true; handler.removeCallbacks(timeout)
        token?.let(PasskeyTickets::cancel)
        if (::store.isInitialized) store.lock()
        val result = Intent()
        if (mode == "create") PendingIntentHandler.setCreateCredentialException(result,
            CreateCredentialCancellationException("Passkey creation cancelled or unavailable"))
        else PendingIntentHandler.setGetCredentialException(result,
            GetCredentialCancellationException("Passkey request cancelled or unavailable"))
        setResult(RESULT_OK, result); finish()
    }
    @Deprecated("Android lifecycle callback")
    override fun onBackPressed() { fail() }
    override fun onDestroy() {
        handler.removeCallbacks(timeout)
        if (!(completed && mode == "unlock" && resultSucceeded)) token?.let(PasskeyTickets::cancel)
        if (::store.isInitialized) store.lock()
        super.onDestroy()
    }
}
