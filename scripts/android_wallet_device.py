"""Run the synthetic Wallet acceptance on the owned emulator of the Android gate."""

import http.client
import json
from pathlib import Path
import shlex
import ssl
import subprocess
import time
from urllib.parse import urlencode, urlsplit


ROOT = Path(__file__).resolve().parent.parent
INSTRUMENTATION = "app.heavenkey.heavenkey_mobile.test/androidx.test.runner.AndroidJUnitRunner"
TEST_CLASS = "app.heavenkey.heavenkey_mobile.MembershipWalletDeviceTest"


class BrowserSession:
    def __init__(self, directory):
        profile = json.loads((directory / "android-wallet.json").read_text())
        self.origin = profile["origin"]
        url = urlsplit(self.origin)
        if url.scheme != "https" or url.hostname != "127.0.0.1" or not url.port:
            raise RuntimeError("Expected a loopback wallet test profile.")
        self.port = url.port
        self.context = ssl.create_default_context(cafile=str(directory / "ca.pem"))
        self.cookie = ""
        self.csrf = ""

    def request(self, path, form=None, expected=200):
        connection = http.client.HTTPSConnection("127.0.0.1", self.port, context=self.context, timeout=8)
        headers = {"Accept": "application/json"}
        if self.cookie:
            headers["Cookie"] = self.cookie
        if form is not None:
            headers |= {"Content-Type": "application/x-www-form-urlencoded", "Origin": self.origin}
        data = urlencode({"csrf": self.csrf, **form}) if form is not None else None
        try:
            connection.request("POST" if form is not None else "GET", path, body=data, headers=headers)
            response = connection.getresponse()
            if response.status != expected:
                raise RuntimeError(f"Wallet fixture returned {response.status} for {path.split('/')[1]}.")
            if path == "/":
                self.cookie = response.getheader("set-cookie").split(";", 1)[0]
            value = json.loads(response.read(16384))
            if path == "/":
                self.csrf = value["csrf"]
            return value
        finally:
            connection.close()


def instrument(adb, method, **references):
    flags = [part for name, value in references.items() for part in ("-e", name, shlex.quote(value))]
    try:
        output = adb("shell", "am", "instrument", "-w", "-r", "-e", "class",
                     f"{TEST_CLASS}#{method}", *flags, INSTRUMENTATION, timeout=150)
    except (subprocess.SubprocessError, OSError):
        raise RuntimeError(f"Wallet device instrumentation did not complete: {method}.") from None
    if "OK (1 test)" not in output or "FAILURES!!!" in output:
        # The instrumentation inputs include invitation references. Avoid emitting their values.
        for reference in references.values():
            output = output.replace(reference, "[test reference]")
        raise RuntimeError(f"Wallet device instrumentation failed: {method}.\n{output[:8000]}")


def run_wallet_acceptance(directory, evidence, adb):
    browser = BrowserSession(Path(directory))
    launcher = ROOT / "scripts/membership_wallet_preview.mjs"
    with subprocess.Popen(["node", str(launcher), "serve", str(directory)], cwd=ROOT,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as fixture:
        try:
            for _ in range(30):
                if fixture.poll() is not None:
                    raise RuntimeError("Wallet fixture stopped during startup.")
                try:
                    browser.request("/")
                    break
                except OSError:
                    time.sleep(0.3)
            else:
                raise RuntimeError("Wallet fixture did not become ready.")
            local = f"tcp:{browser.port}"
            adb("reverse", local, local)
            try:
                offer = browser.request("/browser/offer", {})
                project = browser.request("/browser/request/project", {})
                instrument(adb, "realMembershipWallet", walletOffer=offer["launch"], walletProject=project["launch"])
                result = browser.request("/browser/status/" + project["request_id"])
                access = browser.request("/project")
                if result["status"] != "verified" or access != {
                    "tenant": "supersynergy-demo", "resource": "project-demo-1", "permission": "project.read",
                }:
                    raise RuntimeError("Project access was not granted to the initiating browser session.")

                invoice = browser.request("/browser/request/invoice", {})
                instrument(adb, "realInvoiceConsent", walletInvoice=invoice["launch"])
                status_path = "/browser/status/" + invoice["request_id"]
                approval = browser.request(status_path)["delegation"]
                if approval["status"] != "approved":
                    raise RuntimeError("The target did not approve the confirmed invoice draft.")
                command = [
                    "node", str(ROOT / "scripts/membership_wallet_agent.mjs"), str(directory),
                    approval["delegation_id"], approval["idempotency_key"],
                ]
                first = subprocess.check_output(command, cwd=ROOT, text=True, timeout=15)
                retry = subprocess.check_output(command, cwd=ROOT, text=True, timeout=15)
                draft = browser.request(status_path)["delegation"]
                if first != retry or draft["status"] != "executed":
                    raise RuntimeError("The invoice draft was not reconciled after retry.")
                browser.request("/browser/revoke-credential", {})
                browser.request("/project", expected=403)
            finally:
                adb("reverse", "--remove", local)

            app_evidence = json.loads((evidence / "acceptance.json").read_text())
            receipt = {
                "source_commit": app_evidence["source_commit"],
                "app_sha256": app_evidence["app_sha256"],
                "test_apk_sha256": app_evidence["test_apk_sha256"],
                "passed": True,
                "kind": "Android API 36 emulator and local TLS",
                "synthetic_only": True,
                "android_keystore_issuance": True,
                "project_access_bound_to_browser": True,
                "transaction_bound_agent_draft": True,
                "idempotent_retry": True,
                "credential_revocation": True,
                "physical_device": False,
            }
            (evidence / "membership-wallet.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print("PASS: native membership issuance, project access, agent draft and revocation.", flush=True)
        finally:
            if fixture.poll() is None:
                fixture.terminate()
                try:
                    fixture.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    fixture.kill()
                    fixture.wait(timeout=5)
