"""Execute production-source JVM components with in-memory persistence seams.

No Android runtime, Keystore, TLS, or native acceptance is claimed. Production
consume/create/delete/replace/save and the exact post-network sync apply block
are compiled unchanged; Android clocks/files/authentication are test seams.
No dependency download or native journey occurs.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser()
parser.add_argument('--source-dir', type=Path)
parser.add_argument('--evidence', type=Path, required=True)
args = parser.parse_args()
native = args.source_dir or root / 'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile'
texts = {name: (native / name).read_text() for name in ('PasskeyStore.kt', 'VaultStore.kt', 'DesktopSync.kt')}
provider = (root / 'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/HeavenCredentialProvider.kt').read_text()
backup = (root / 'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/MobileBackup.kt').read_text()
compiler = shutil.which('kotlinc')
json_jar = Path(os.environ.get('HEAVENKEY_POLICY_JSON_JAR', str(root / '.platform-tools/mobile-policy-json-20250517.jar')))
cbor_jar = next(iter(sorted((Path.home() / '.gradle/caches/modules-2/files-2.1/co.nstant.in/cbor/0.9').glob('*/*.jar'))), None)
if not compiler or not json_jar.is_file() or cbor_jar is None:
    raise SystemExit('Installed kotlinc, cbor:0.9 Gradle artifact and pinned JSON fixture required. Run bun scripts/mobile_policy_deps.ts once; this check performs no downloads.')


def balanced(text, start):
    opening = text.index('{', start)
    depth, quote, escaped = 0, None, False
    for i in range(opening, len(text)):
        char = text[i]
        if quote:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == quote:
                quote = None
        elif char in ('"', "'"):
            quote = char
        elif char == '{':
            depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    raise AssertionError('Unbalanced production declaration')


def function(text, name):
    match = re.search(r'^\s*(?:@Synchronized\s+)?(?:private\s+)?fun\s+(?:<[^>]+>\s+)?' + re.escape(name) + r'\(', text, re.M)
    if not match:
        raise AssertionError('Missing production function: ' + name)
    return balanced(text, match.start()).strip()


def object_source(text, name):
    match = re.search(r'internal object ' + re.escape(name) + r'\s*\{', text)
    return balanced(text, match.start()) if match else ''


passkey, vault, sync = (texts[name] for name in ('PasskeyStore.kt', 'VaultStore.kt', 'DesktopSync.kt'))
# Start immediately after the remote CAS, exactly where the reported race occurred.
network = '        request(state, "/sync/v1/snapshot", JSONObject().put("id", state.getString("id")).put("expected_revision", revision).put("record", output))'
start = sync.index(network) + len(network)
apply_source = sync[start:sync.index('        return status()', start)]
assert 'request(' not in apply_source, 'Network work entered the local mutation boundary'
imports = '''package app.heavenkey.heavenkey_mobile
import android.os.SystemClock
import org.json.JSONObject
import org.json.JSONArray
import co.nstant.`in`.cbor.CborBuilder
import co.nstant.`in`.cbor.CborEncoder
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.net.URI
import java.security.*
import java.security.interfaces.ECPublicKey
import java.security.interfaces.ECPrivateKey
import java.security.spec.*
import java.time.Instant
import java.util.Base64
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
'''
shared = object_source(vault, 'MobileStoreTransaction')
replay = object_source(passkey, 'PasskeyReplayWindow')
protocol = object_source(passkey, 'PasskeyProtocol')
ticket_start = provider.index('internal data class PasskeyRequest')
tickets = provider[ticket_start:provider.index('    fun pending(', ticket_start)] + '}\n'
passkey_class = passkey[passkey.index('internal class PasskeyStore'):]
passkey_functions = '\n'.join(function(passkey_class, name) for name in ('exportRecords', 'delete', 'records', 'consume', 'create'))
replace = function(passkey_class, 'replaceRecords').replace('fun replaceRecords(', 'private fun applyRecords(')
vault_functions = '\n'.join(function(vault, name) for name in ('save', 'delete', 'replaceEntries'))
backup_fields = re.search(r'    private val fields = .*', backup).group(0)
backup_validate = function(backup, 'validate')
mobile = function(sync, 'mobile')
# mobile is an expression-bodied try/catch; include its catch as in production.
if mobile.endswith('}') and 'catch' not in mobile:
    offset = sync.index(mobile) + len(mobile)
    catch = re.match(r' catch \(_: Exception\) \{ null \}', sync[offset:])
    if catch:
        mobile += catch.group(0)
rows = function(sync, 'rows') if '{' in sync[sync.index('fun rows('):sync.index('fun canonical(')] else 'fun rows(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }'
canonical_start = sync.index('        fun canonical(')
canonical = balanced(sync, canonical_start).strip()

component = imports + re.search(r'internal class BackupFailure[^\n]+', backup).group(0) + '\n' + shared + '\n' + replay + '\n' + protocol + '\n' + tickets + '''
class PasskeyStore {
    private var payload = JSONObject().put("records", JSONArray()).put("used", JSONArray()).put("backedUpIds", JSONArray())
    private fun read() = JSONObject(payload.toString())
    private fun write(data: JSONObject) { payload = JSONObject(data.toString()) }
    fun seed(values: List<JSONObject>) { payload.put("records", JSONArray(values)) }
    fun history(data: JSONObject, id: String) { consume(data, id) }
    var beforeReplace: (() -> Unit)? = null
    fun replaceRecords(incoming: List<JSONObject>) { beforeReplace?.invoke(); applyRecords(incoming) }
''' + passkey_functions + '\n' + replace + '\ncompanion object { private val LOCK=Any()\n' + function(passkey_class, 'validateRecord') + '\n}\n}\n' + '''
class VaultStore {
    private var values = emptyList<JSONObject>()
    private var syncState: JSONObject? = null
    var failEntries = false
    var beforeReplace: (() -> Unit)? = null
    fun read(): List<JSONObject> = values.map { JSONObject(it.toString()) }
    private fun write(next: List<JSONObject>) { if (failEntries) error("injected_file_failure"); values = next.map { JSONObject(it.toString()) } }
    fun readSyncState(): JSONObject? = syncState?.let { JSONObject(it.toString()) }
    fun writeSyncState(value: JSONObject?) { syncState = value?.let { JSONObject(it.toString()) } }
    fun seed(value: List<JSONObject>, state: JSONObject) { values = value; syncState = JSONObject(state.toString()) }
''' + vault_functions.replace('fun replaceEntries(', 'private fun applyEntries(') + '''
    fun replaceEntries(values: List<JSONObject>) { beforeReplace?.invoke(); applyEntries(values) }
}
object MobileBackup {
''' + backup_fields + '\n' + backup_validate + '\n' + function(backup, 'fingerprint') + '\n}\n' + canonical + '\n' + rows + '\n' + mobile + '''
fun apply(vault: VaultStore, passkeys: PasskeyStore, fingerprint: String, nativeBefore: List<JSONObject>, merged: JSONObject,
          state: JSONObject, stateFingerprint: String = canonical(state), revision: Long = 1) {
''' + apply_source + '\n}\n'

tests = '''
fun entry(id:String, title:String = id) = JSONObject().put("id",id).put("title",title).put("origin","https://example.com")
    .put("username","synthetic").put("password","synthetic-only").put("notes","").put("updatedAt","2026-10-25T00:00:00Z")
fun remote(value:JSONObject) = JSONObject().put("id",value.getString("id")).put("title",value.getString("title"))
    .put("url",value.getString("origin")).put("username",value.getString("username")).put("password",value.getString("password"))
    .put("notes",value.getString("notes")).put("totp","").put("tags",JSONArray()).put("favorite",false)
fun create(store:PasskeyStore, name:String) {
    store.create(JSONObject().put("rp",JSONObject().put("id","example.com")).put("user",JSONObject().put("id","AQ").put("name",name).put("displayName",name)),ByteArray(32),name)
}
fun main() {
    val failures=mutableListOf<String>()
    fun test(name:String, action:()->Unit) { try { action(); println("PASS "+name) } catch(error:Throwable) { failures.add(name); println("FAIL "+name+": "+error.javaClass.simpleName+" "+error.message) } }
    test("replay history expires after 2000 successful operations") {
        SystemClock.now=1000
        val store=PasskeyStore(); val data=JSONObject().put("used",JSONArray())
        repeat(2000) { store.history(data,"history-$it") }
        SystemClock.now+=120001
        store.history(data,"fresh-after-window")
    }
    test("live replay duplicate is rejected") {
        val store=PasskeyStore();val data=JSONObject().put("used",JSONArray())
        store.history(data,"duplicate")
        var rejected=false;try{store.history(data,"duplicate")}catch(_:Exception){rejected=true};check(rejected)
    }
    test("live history capacity rejects admissions but recovers at exact expiry") {
        SystemClock.now+=120001
        val store=PasskeyStore();val data=JSONObject().put("used",JSONArray())
        repeat(2000){store.history(data,"bounded-$it")}
        var rejected=false;try{store.history(data,"over-capacity")}catch(_:Exception){rejected=true};check(rejected)
        SystemClock.now+=120000
        store.history(data,"after-exact-expiry")
    }
    test("legacy lifetime history migrates without permanent exhaustion") {
        val store=PasskeyStore();val old=JSONArray();repeat(2000){old.put("old-$it")}
        val data=JSONObject().put("used",old);store.history(data,"legacy-fresh")
        check(data.getJSONArray("used").length()==0)
    }
    test("provider tickets remain single-use, request-bound, expiring and cancelled") {
        val request=PasskeyRequest("com.brave.browser","https://example.com","example.com",JSONObject().put("challenge","AQ").put("timeout",999999).toString(),ByteArray(32),false)
        fun rejects(action:()->Unit){var rejected=false;try{action()}catch(_:Exception){rejected=true};check(rejected)}
        val token=PasskeyTickets.issue("unlock",listOf(request))
        val parent=PasskeyTickets.take(token,"unlock",listOf(request))
        check(parent.expires-SystemClock.now==120000L)
        rejects{PasskeyTickets.take(token,"unlock",listOf(request))}
        val childToken=PasskeyTickets.issue("get",listOf(request),"A",parent)
        val child=PasskeyTickets.take(childToken,"get",listOf(request))
        PasskeyTickets.cancel(token);check(!parent.active() && !child.active())
        val changed=PasskeyTickets.issue("get",listOf(request))
        rejects{PasskeyTickets.take(changed,"get",listOf(request.copy(hash=ByteArray(32){1})))}
        val expired=PasskeyTickets.issue("get",listOf(request))
        SystemClock.now+=120000
        rejects{PasskeyTickets.take(expired,"get",listOf(request))}
        val death=PasskeyTickets.issue("get",listOf(request))
        PasskeyTickets.clear();rejects{PasskeyTickets.take(death,"get",listOf(request))}
    }
    for (kind in listOf("passkey create","passkey delete","login save","login delete")) test("atomic sync preserves concurrent "+kind) {
        val passkeys=PasskeyStore(); create(passkeys,"A-"+kind)
        val first=passkeys.exportRecords().single()
        val original=entry("login-A");val changed=entry("login-A","remote edit")
        val state=JSONObject().put("revision",1).put("baseline",JSONObject())
        val vault=VaultStore();vault.seed(listOf(original),state)
        val before=vault.read();val keys=passkeys.exportRecords()
        val fingerprint=MobileBackup.fingerprint(before)+canonical(JSONArray(keys))
        val merged=JSONObject().put("entries",JSONArray().put(remote(changed))).put("passkeys",JSONArray(keys))
        val started=CountDownLatch(1); val done=CountDownLatch(1); val error=AtomicReference<Throwable?>()
        val mutation=Thread {
            started.countDown()
            try { when(kind) {
                "passkey create"->create(passkeys,"B-"+kind)
                "passkey delete"->passkeys.delete(first.getString("id"))
                "login save"->vault.save(entry("login-B"))
                "login delete"->vault.delete("login-A")
            } }catch(problem:Throwable){error.set(problem)}finally{done.countDown()}
        }
        val hook={
            mutation.start();check(started.await(5,TimeUnit.SECONDS))
            val end=System.nanoTime()+TimeUnit.SECONDS.toNanos(5)
            while(done.count!=0L && mutation.state!=Thread.State.BLOCKED && System.nanoTime()<end) Thread.yield()
            check(done.count==0L || mutation.state==Thread.State.BLOCKED) {"mutation neither completed nor blocked at store boundary"}
        }
        passkeys.beforeReplace=hook
        apply(vault,passkeys,fingerprint,before,merged,state)
        mutation.join(5000);check(!mutation.isAlive);error.get()?.let{throw it}
        when(kind) {
            "passkey create"->check(passkeys.exportRecords().size==2){"new credential silently removed"}
            "passkey delete"->check(passkeys.exportRecords().isEmpty()){ "deleted credential resurrected" }
            "login save"->check(vault.read().any{it.getString("id")=="login-B"}){"new login silently removed"}
            "login delete"->check(vault.read().none{it.getString("id")=="login-A"}){"deleted login resurrected"}
        }
    }
    test("stale sync state cannot reconnect a disconnected link") {
        val passkeys=PasskeyStore();val vault=VaultStore()
        val state=JSONObject().put("revision",1).put("baseline",JSONObject())
        vault.seed(emptyList(),state)
        val fingerprint=MobileBackup.fingerprint(vault.read())+canonical(JSONArray(passkeys.exportRecords()))
        vault.writeSyncState(null)
        val merged=JSONObject().put("entries",JSONArray()).put("passkeys",JSONArray())
        var rejected=false;try{apply(vault,passkeys,fingerprint,emptyList(),merged,state)}catch(_:Exception){rejected=true}
        check(rejected && vault.readSyncState()==null){"disconnected link resurrected by stale sync application"}
    }
    test("partial local failure preserves durable old baseline for retry") {
        val passkeys=PasskeyStore();create(passkeys,"failure-A")
        val original=entry("failure-login");val changed=entry("failure-login","remote edit")
        val state=JSONObject().put("revision",1).put("baseline",JSONObject().put("old",true))
        val vault=VaultStore();vault.seed(listOf(original),state)
        val before=vault.read();val fingerprint=MobileBackup.fingerprint(before)+canonical(JSONArray(passkeys.exportRecords()))
        val merged=JSONObject().put("entries",JSONArray().put(remote(changed))).put("passkeys",JSONArray(passkeys.exportRecords()))
        vault.failEntries=true
        var failed=false;try{apply(vault,passkeys,fingerprint,before,merged,state)}catch(_:Exception){failed=true}
        check(failed && vault.readSyncState()!!.getLong("revision")==1L && vault.readSyncState()!!.getJSONObject("baseline").getBoolean("old"))
    }
    check(failures.isEmpty()) { failures.joinToString("; ") }
    println("Production-source JVM component policy accepted; native storage/runtime acceptance separate")
}
'''
args.evidence.parent.mkdir(parents=True, exist_ok=True)
manifest = {name: hashlib.sha256(text.encode()).hexdigest() for name, text in texts.items()}
manifest.update({'HeavenCredentialProvider.kt':hashlib.sha256(provider.encode()).hexdigest(), 'MobileBackup.kt':hashlib.sha256(backup.encode()).hexdigest(), 'mobile_passkey_policy_check.py':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'OriginPolicy.kt':hashlib.sha256((root/'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/OriginPolicy.kt').read_bytes()).hexdigest()})
with tempfile.TemporaryDirectory(prefix='heavenkey-passkey-policy-') as scratch:
    work = Path(scratch)
    (work / 'Component.kt').write_text(component + tests)
    (work / 'SystemClock.kt').write_text('package android.os\nobject SystemClock { var now=1000L; @JvmStatic fun elapsedRealtime():Long=now }\n')
    binary = work / 'policy.jar'
    dependencies = str(json_jar) + os.pathsep + str(cbor_jar)
    compile_result = subprocess.run([compiler, str(work/'Component.kt'), str(work/'SystemClock.kt'), str(root/'apps/mobile/android/app/src/main/kotlin/app/heavenkey/heavenkey_mobile/OriginPolicy.kt'), '-cp', dependencies, '-include-runtime', '-d', str(binary)], text=True, capture_output=True, timeout=90)
    output = compile_result.stdout + compile_result.stderr
    code = compile_result.returncode
    if code == 0:
        run = subprocess.run(['java', '-cp', str(binary)+os.pathsep+dependencies, 'app.heavenkey.heavenkey_mobile.ComponentKt'], text=True, capture_output=True, timeout=60)
        output += run.stdout + run.stderr
        code = run.returncode
    args.evidence.write_text(json.dumps({'kind':'production-source JVM components with in-memory file/auth seams', 'source_hashes':manifest, 'passed':code==0},indent=2)+'\n'+output)
    print(output, end='')
    print('Evidence: '+str(args.evidence))
    raise SystemExit(code)
