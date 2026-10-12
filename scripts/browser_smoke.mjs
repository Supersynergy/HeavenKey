import { chromium, firefox, webkit } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const temporary = await mkdtemp(join(tmpdir(), "heavenkey-browser-smoke-"));
const binary = resolve(process.env.HEAVENKEY_BINARY || "target/aarch64-apple-darwin/release/uac-api");
const server = spawn(binary, ["--data-dir", join(temporary, "data"), "--port", "18240"], { cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
server.stdout.on("data", bytes => output += bytes);
server.stderr.on("data", bytes => output += bytes);
const cases = [];
let currentBrowser;
try {
  const deadline = Date.now() + 15000;
  while (true) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    try { if ((await fetch("http://localhost:18240/health", { signal: AbortSignal.timeout(1000) })).ok) break; } catch (error) {
      if (Date.now() >= deadline) throw new Error(`Server startup timeout: ${error.message}; ${output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const [name, engine] of Object.entries({ chromium, firefox, webkit })) {
    currentBrowser = await engine.launch({ headless: true });
    const page = await currentBrowser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const response = await page.goto("http://localhost:18240/");
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    const support = await page.evaluate(() => ({ secure: isSecureContext, webauthn: typeof PublicKeyCredential !== "undefined", overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(support.secure, true);
    assert.equal(support.webauthn, true);
    assert.equal(support.overflow, false);
    await page.locator("#bootstrap").focus();
    assert.equal(await page.locator("#bootstrap").evaluate(input => input === document.activeElement), true);
    assert.deepEqual(errors, []);
    cases.push({ browser: name, pass: true, startup_from_empty_directory: true, ...support, errors });
    await currentBrowser.close();
    currentBrowser = undefined;
  }
  const child = spawn(process.execPath, ["scripts/extension_smoke.mjs"], { cwd: resolve("."), stdio: "inherit" });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0);
  await writeFile("docs/evidence/browser-compatibility.json", JSON.stringify({ pass: true, binary, cases }, null, 2) + "\n");
  console.log(JSON.stringify(cases));
} finally {
  await currentBrowser?.close();
  if (server.exitCode === null) {
    server.kill("SIGINT");
    const stopped = new Promise(resolve => server.once("exit", resolve));
    await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) { server.kill("SIGKILL"); await stopped; }
  }
  await rm(temporary, { recursive: true, force: true });
}
