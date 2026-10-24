package app.heavenkey.heavenkey_mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Future
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

internal class BackupFiles(private val activity: Activity, private val lockVault: () -> Unit) {
    private class Request(val code: Int, val saving: Boolean, val payload: ByteArray?, val complete: (Any?, String?) -> Unit) {
        val deadline = SystemClock.elapsedRealtime() + 120_000
        val cancellation = CancellationSignal()
        val descriptor = AtomicReference<ParcelFileDescriptor?>()
        var future: Future<*>? = null
        var timeout: Runnable? = null
    }
    private val handler = Handler(Looper.getMainLooper())
    private val worker = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(1))
    private var pending: Request? = null
    private var nextRequestCode = 17021
    private val maximum = 24 * 1024 * 1024

    fun save(envelope: String, complete: (Any?, String?) -> Unit) {
        try { MobileBackup.checkArchive(envelope) }
        catch (error: BackupFailure) { complete(null, error.code); return }
        begin(true, envelope.toByteArray(Charsets.UTF_8), complete)
    }
    fun load(complete: (Any?, String?) -> Unit) { begin(false, null, complete) }

    private fun begin(saving: Boolean, payload: ByteArray?, complete: (Any?, String?) -> Unit) {
        if (pending != null || worker.isShutdown || worker.activeCount != 0 || worker.queue.isNotEmpty() || nextRequestCode >= 65535) {
            complete(null, "backup_busy"); return
        }
        val request = Request(nextRequestCode++, saving, payload, complete)
        pending = request
        request.timeout = Runnable { finish(request, null, "cancelled") }.also { handler.postDelayed(it, 120_000) }
        lockVault()
        val intent = Intent(if (saving) Intent.ACTION_CREATE_DOCUMENT else Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE).setType("application/json")
        if (saving) intent.putExtra(Intent.EXTRA_TITLE, "HeavenKey-${LocalDate.now(ZoneOffset.UTC)}.hkb.json")
        try { activity.startActivityForResult(intent, request.code) }
        catch (_: Exception) { finish(request, null, "cancelled") }
    }

    fun onActivityResult(code: Int, result: Int, data: Intent?): Boolean {
        if (code !in 17021 until nextRequestCode) return false
        val request = pending ?: return true
        if (code != request.code) return true
        val uri = data?.data
        if (result != Activity.RESULT_OK || uri == null) {
            finish(request, if (request.saving) false else null, null); return true
        }
        try {
            request.future = worker.submit {
                try {
                    val value = transfer(request, uri)
                    handler.post { finish(request, value, null) }
                } catch (error: BackupFailure) { handler.post { finish(request, null, error.code) } }
                  catch (_: Exception) { handler.post { finish(request, null, if (request.cancellation.isCanceled) "cancelled" else "invalid_archive") } }
            }
        } catch (_: Exception) { finish(request, null, "backup_busy") }
        return true
    }

    private fun check(request: Request) {
        if (request.cancellation.isCanceled || Thread.currentThread().isInterrupted || SystemClock.elapsedRealtime() >= request.deadline)
            throw BackupFailure("cancelled")
    }
    private fun transfer(request: Request, uri: Uri): Any {
        check(request)
        val descriptor = activity.contentResolver.openFileDescriptor(uri, if (request.saving) "wt" else "r", request.cancellation)
            ?: throw BackupFailure("invalid_archive")
        request.descriptor.set(descriptor)
        try {
            check(request)
            if (request.saving) {
                ParcelFileDescriptor.AutoCloseOutputStream(descriptor).use { output ->
                    val bytes = request.payload ?: throw BackupFailure("invalid_archive")
                    var offset = 0
                    while (offset < bytes.size) {
                        check(request)
                        val size = minOf(64 * 1024, bytes.size - offset)
                        output.write(bytes, offset, size); offset += size
                    }
                    output.flush(); check(request)
                }
                return true
            }
            if (descriptor.statSize > maximum) throw BackupFailure("too_large")
            val bytes = ByteArrayOutputStream()
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { input ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    check(request)
                    val size = input.read(buffer, 0, minOf(buffer.size, maximum - bytes.size() + 1))
                    if (size < 0) break
                    if (bytes.size() + size > maximum) throw BackupFailure("too_large")
                    bytes.write(buffer, 0, size)
                }
            }
            check(request)
            val envelope = Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes.toByteArray())).toString()
            MobileBackup.checkArchive(envelope)
            check(request)
            return envelope
        } finally { request.descriptor.compareAndSet(descriptor, null); try { descriptor.close() } catch (_: Exception) { } }
    }
    private fun finish(request: Request, value: Any?, error: String?) {
        if (pending !== request) return
        pending = null
        request.timeout?.let { handler.removeCallbacks(it) }
        request.cancellation.cancel()
        request.future?.cancel(true)
        try { request.descriptor.getAndSet(null)?.close() } catch (_: Exception) { }
        activity.finishActivity(request.code)
        request.complete(value, error)
    }
    fun destroy() {
        pending?.let { finish(it, null, "cancelled") }
        worker.shutdownNow()
    }
}
