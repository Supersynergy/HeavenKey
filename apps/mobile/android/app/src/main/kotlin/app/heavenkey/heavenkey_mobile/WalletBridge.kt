package app.heavenkey.heavenkey_mobile

import android.app.KeyguardManager
import android.content.Intent
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import com.nimbusds.jose.JOSEException
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import org.json.JSONException
import java.io.IOException
import java.security.UnrecoverableKeyException
import java.text.ParseException
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

internal class WalletBridge(
    private val activity: MainActivity,
    private val vaultUnlocked: () -> Boolean,
) : MethodChannel.MethodCallHandler {
    private val profile = runCatching { WalletProfile.load() }.getOrNull()
    private val store = WalletStore(activity)
    private val protocol = profile?.let { MembershipProtocol(it, store) }
    private val keyguard = activity.getSystemService(KeyguardManager::class.java)
    private val epoch = AtomicLong()
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(1))
    private var channel: MethodChannel? = null
    @Volatile private var link: WalletLink? = null
    private var plan: ConsentPlan? = null
    private var preparedAt = 0L
    private var prompt: CancellationSignal? = null
    private var busy = false
    @Volatile private var foreground = false

    fun attach(channel: MethodChannel) {
        this.channel = channel
        channel.setMethodCallHandler(this)
    }

    fun start() { foreground = true }

    fun stop() {
        foreground = false
        lock()
    }

    fun lock() {
        epoch.incrementAndGet()
        plan = null
        preparedAt = 0L
        prompt?.cancel()
        prompt = null
    }

    fun destroy() {
        stop()
        channel?.setMethodCallHandler(null)
        channel = null
        worker.shutdownNow()
    }

    fun incoming(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val text = intent.dataString ?: return
        val incoming = try { profile?.parseLink(text) } catch (_: Exception) { return }
        if (incoming == null || link != null || busy) return
        link = incoming
        channel?.invokeMethod("changed", null)
    }

    private fun guard(token: Long) {
        walletCheck(epoch.get() == token && foreground && vaultUnlocked() && !keyguard.isDeviceLocked,
            "wallet_locked")
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method == "status") {
            if (protocol == null || call.argument<Boolean>("include_aya") != true || !foreground || !vaultUnlocked() || busy) {
                result.success(status())
            } else {
                launch(result, finished = { outcome ->
                    val (pending, aya) = outcome.getOrThrow()
                    if (link == null && pending != null) {
                        link = pending
                        channel?.invokeMethod("changed", null)
                    }
                    status(aya)
                }) { guard -> store.pending(guard) to store.aya(guard) }
            }
            return
        }
        try {
            val client = protocol ?: throw WalletFailure("wallet_unavailable")
            val trust = profile ?: throw WalletFailure("wallet_unavailable")
            guard(epoch.get())
            when (call.method) {
                "list" -> launch(result) { guard ->
                    val records = store.records(guard)
                    val bits = if (records.isEmpty()) null else runCatching { client.statusBits(guard) }.getOrNull()
                    records.mapNotNull { record ->
                        runCatching { client.credential(record, requireHolder = false) }.getOrNull()?.let {
                            val protection = if (it.holderBound) {
                                runCatching { store.holderProtection(record.id) }.getOrDefault("unknown")
                            } else "key_lost"
                            it.summary(client.credentialStatus(it, bits)) + ("holder_protection" to protection)
                        }
                    }
                }
                "enqueue" -> {
                    walletCheck(!busy && link == null, "wallet_busy")
                    link = trust.parseLink(call.argument<String>("uri") ?: throw WalletFailure("invalid_request"))
                    result.success(null)
                    channel?.invokeMethod("changed", null)
                }
                "prepare" -> {
                    val queued = link
                    launch(result, finished = { outcome ->
                        plan = outcome.getOrNull()
                        preparedAt = android.os.SystemClock.elapsedRealtime()
                        if (outcome.isFailure) link = null
                        plan?.summary()
                    }) { guard ->
                        val pending = queued ?: store.pending(guard)
                        pending?.let {
                            try {
                                val prepared = if (it.issuance) client.prepareIssue(it, guard)
                                    else client.preparePresentation(it, guard)
                                store.savePending(it, guard)
                                prepared
                            } catch (error: Exception) {
                                store.savePending(null, guard)
                                throw error
                            }
                        }
                    }
                }
                "approve" -> {
                    val shown = approvedPlan(call)
                    val token = epoch.get()
                    walletCheck(walletNow() < shown.expiresAt &&
                        android.os.SystemClock.elapsedRealtime() - preparedAt < 90_000L, "wallet_expired")
                    walletCheck(!busy && prompt == null, "wallet_busy")
                    val signal = CancellationSignal()
                    prompt = signal
                    val title = if (shown.kind == "issuance") "Nachweis annehmen" else "Freigabe bestätigen"
                    BiometricPrompt.Builder(activity).setTitle(title)
                        .setSubtitle("HeavenKey · Supersynergy-Testprofil")
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG or
                            BiometricManager.Authenticators.DEVICE_CREDENTIAL)
                        .build().authenticate(signal, activity.mainExecutor,
                            object : BiometricPrompt.AuthenticationCallback() {
                                override fun onAuthenticationSucceeded(authentication: BiometricPrompt.AuthenticationResult) {
                                    if (prompt === signal) prompt = null
                                    try {
                                        guard(token)
                                        walletCheck(plan === shown, "wallet_changed")
                                        // Consume this UI plan before issuing a request or signing any payload.
                                        plan = null
                                        link = null
                                        launch(result) { current ->
                                            val approvalGuard = {
                                                current()
                                                walletCheck(walletNow() < shown.expiresAt, "wallet_expired")
                                            }
                                            store.savePending(null, approvalGuard)
                                            val receipt = when (shown) {
                                                is ConsentPlan.Issue -> client.issue(shown, approvalGuard)
                                                is ConsentPlan.Present -> client.present(shown, approvalGuard)
                                            }
                                            receipt.summary()
                                        }
                                    } catch (error: Exception) {
                                        fail(result, error)
                                    }
                                }
                                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                                    if (prompt === signal) prompt = null
                                    fail(result, WalletFailure("wallet_auth_cancelled"))
                                }
                            })
                }
                "cancel" -> {
                    walletCheck(!busy, "wallet_busy")
                    approvedPlan(call)
                    lock()
                    link = null
                    launch(result) { guard -> store.savePending(null, guard); null }
                }
                "setAya" -> {
                    val enabled = call.argument<Boolean>("enabled") ?: throw WalletFailure("invalid_request")
                    launch(result) { guard -> store.setAya(enabled, guard); null }
                }
                "activity" -> launch(result) { guard ->
                    store.receipts(guard).asReversed().map(WalletReceipt::summary)
                }
                "getRequestStatus" -> {
                    val id = call.argument<String>("id")
                    launch(result) { guard ->
                        val receipt = store.receipts(guard).let { receipts ->
                            if (id == null) receipts.lastOrNull() else receipts.singleOrNull { it.id == id }
                        }
                        if (receipt == null) null
                        else runCatching { client.reconcile(receipt, guard) }.getOrDefault(receipt).summary()
                    }
                }
                else -> result.notImplemented()
            }
        } catch (error: Exception) {
            fail(result, error)
        }
    }

    private fun status(aya: Boolean = false): Map<String, Boolean> =
        mapOf("available" to (profile != null), "pending" to (link != null), "aya_enabled" to aya)

    private fun approvedPlan(call: MethodCall): ConsentPlan {
        val shown = plan ?: throw WalletFailure("wallet_changed")
        walletCheck(shown.link.id == call.argument<String>("id") &&
            shown.fingerprint == call.argument<String>("fingerprint"), "wallet_changed")
        return shown
    }

    private fun <T> launch(
        result: MethodChannel.Result,
        finished: (Result<T>) -> Any? = { it.getOrThrow() },
        work: (() -> Unit) -> T,
    ) {
        if (busy || prompt != null) { fail(result, WalletFailure("wallet_busy")); return }
        val token = epoch.get()
        try { guard(token) } catch (error: Exception) { fail(result, error); return }
        busy = true
        worker.execute {
            val outcome = runCatching { work { guard(token) } }
            activity.runOnUiThread {
                busy = false
                try {
                    guard(token)
                    val summary = finished(outcome)
                    outcome.getOrThrow()
                    result.success(summary)
                } catch (error: Exception) {
                    fail(result, error)
                }
            }
        }
    }

    private fun fail(result: MethodChannel.Result, error: Exception) {
        val code = when (error) {
            is WalletFailure -> error.code
            is UnrecoverableKeyException -> "wallet_key_lost"
            is android.security.keystore.UserNotAuthenticatedException -> "wallet_locked"
            is IOException -> "wallet_unreachable"
            is JSONException, is ParseException, is JOSEException, is IllegalArgumentException -> "invalid_request"
            else -> "wallet_failed"
        }
        result.error(code, "HeavenKey konnte den Wallet-Vorgang nicht abschließen.", null)
    }
}
