import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

const root = resolve(".");
const evidence = resolve(process.env.HEAVEN_DEMO_EVIDENCE || "docs/evidence");
await mkdir(evidence, { recursive: true });
const cases = [];
const started = performance.now();
let server, browser, fatal;
let origin = process.env.HEAVEN_DEMO_ORIGIN;
if (origin && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("demo tests require a loopback origin");
async function test(name, action) {
  const start = performance.now();
  try { await action(); cases.push({ name, pass: true, elapsed_ms: Math.round(performance.now() - start) }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); throw error; }
}
async function ready(page, url = origin) {
  await page.goto(url);
  await page.waitForFunction(() => document.documentElement.dataset.ready === "true", null, { timeout: 5000 });
}
async function settled(page) {
  await page.waitForFunction(() => document.documentElement.dataset.busy !== "true");
}
async function click(page, selector) {
  await page.locator(selector).click();
  await settled(page);
}
async function fresh(init) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1024 } });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await ready(page);
  return { context, page };
}
async function reset(page) {
  await click(page, "#reset");
  await click(page, "#reset-confirm");
  assert.equal(await page.locator("#grant-status").innerText(), "Noch kein Zugang");
}
try {
  if (!origin) {
    const reserve = createServer();
    await new Promise((done, reject) => { reserve.once("error", reject); reserve.listen(0, "127.0.0.1", done); });
    const port = reserve.address().port;
    await new Promise(done => reserve.close(done));
    server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", join(root, "apps/demo")], { stdio: ["ignore", "pipe", "pipe"] });
    let error;
    server.on("error", value => { error = value; });
    server.stdout.resume(); server.stderr.resume();
    origin = `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + 5000;
    let up = false;
    while (Date.now() < deadline) {
      if (error || server.exitCode !== null) throw error || new Error("demo server exited");
      try { up = (await fetch(origin, { signal: AbortSignal.timeout(500) })).ok; } catch { up = false; }
      if (up) break;
      await new Promise(done => setTimeout(done, 50));
    }
    assert.ok(up, "demo server ready within five seconds");
  }
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"), headless: true, args: ["--disable-background-networking"], timeout: 30000 });
  const { context, page } = await fresh();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  await test("initial access denied without grant", async () => {
    await click(page, "#open-document");
    assert.equal(await page.locator("#document").isVisible(), false);
    assert.match(await page.locator("#open-feedback").innerText(), /Kein Zugriff/);
    assert.equal(await page.locator("#revoke").isEnabled(), false);
  });
  await test("share opens guest path and moves keyboard focus", async () => {
    await click(page, "#share");
    assert.equal(await page.locator("#grant-status").innerText(), "Zugang ist aktiv");
    assert.equal(await page.evaluate(() => document.activeElement.id), "open-document");
    assert.equal(await page.locator("#share").isEnabled(), false);
    assert.equal(await page.locator("#recipient").isEnabled(), false);
    assert.equal(await page.locator("#step-open").getAttribute("aria-current"), "step");
  });
  await test("authorized guest reads document", async () => {
    await click(page, "#open-document");
    assert.equal(await page.locator("#document").isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), "document-title");
    assert.equal(await page.locator("#step-revoke").getAttribute("aria-current"), "step");
    await page.screenshot({ path: join(evidence, "demo-open.png"), fullPage: true });
  });
  await test("different guest cannot reuse grant", async () => {
    await page.locator("#viewer").selectOption("ben");
    assert.equal(await page.locator("#document").isVisible(), false);
    await click(page, "#open-document");
    assert.match(await page.locator("#open-feedback").innerText(), /Ben/);
    assert.equal(await page.locator("#document").isVisible(), false);
    await page.locator("#viewer").selectOption("anna");
    await click(page, "#open-document");
  });
  await test("revocation immediately hides open document and denies retry", async () => {
    await click(page, "#revoke");
    assert.equal(await page.locator("#document").isVisible(), false);
    assert.equal(await page.locator("#grant-status").innerText(), "Zugang widerrufen");
    assert.equal(await page.evaluate(() => document.activeElement.id), "open-document");
    await click(page, "#open-document");
    assert.match(await page.locator("#open-feedback").innerText(), /Kein Zugriff/);
    await page.screenshot({ path: join(evidence, "demo-revoked.png"), fullPage: true });
  });
  await test("revocation survives reload", async () => {
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    assert.equal(await page.locator("#grant-status").innerText(), "Zugang widerrufen");
    await click(page, "#open-document");
    assert.equal(await page.locator("#document").isVisible(), false);
  });
  await test("reset supports cancel escape and confirmed restart", async () => {
    await click(page, "#reset");
    assert.equal(await page.evaluate(() => document.activeElement.id), "reset-cancel");
    await click(page, "#reset-cancel");
    assert.equal(await page.locator("#grant-status").innerText(), "Zugang widerrufen");
    assert.equal(await page.evaluate(() => document.activeElement.id), "reset");
    await click(page, "#reset");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#reset-dialog").isVisible(), false);
    await reset(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "share");
    assert.equal(await page.locator("#events li").count(), 1);
    assert.equal((await page.locator("#events").textContent()).trim(), "Noch keine Aktion.");
  });
  await test("full flow works by keyboard", async () => {
    await page.locator("#share").focus();
    await page.keyboard.press("Enter"); await settled(page);
    assert.equal(await page.evaluate(() => document.activeElement.id), "open-document");
    await page.keyboard.press("Enter"); await settled(page);
    assert.equal(await page.locator("#document").isVisible(), true);
    await page.locator("#revoke").focus();
    await page.keyboard.press("Enter"); await settled(page);
    assert.equal(await page.locator("#document").isVisible(), false);
  });
  await test("revocation synchronizes a second browser tab", async () => {
    await reset(page); await click(page, "#share");
    const guest = await context.newPage(); await ready(guest);
    await click(guest, "#open-document");
    assert.equal(await guest.locator("#document").isVisible(), true);
    await click(page, "#revoke");
    await guest.locator("#document").waitFor({ state: "hidden" });
    assert.equal(await guest.locator("#grant-status").innerText(), "Zugang widerrufen");
    await guest.close();
  });
  await test("stale tab cannot overwrite a pending revocation", async () => {
    await reset(page); await click(page, "#share");
    const stale = await context.newPage();
    await stale.addInitScript(() => {
      const listen = window.addEventListener.bind(window);
      window.addEventListener = (type, ...args) => { if (type !== "storage") listen(type, ...args); };
    });
    await ready(stale);
    await click(page, "#revoke");
    await click(stale, "#open-document");
    assert.equal(await stale.locator("#document").isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("heaven-browserdemo:v1")).grant.revoked), true);
    await stale.close();
  });
  await test("saved Ben grant restores recipient duration and guest", async () => {
    await reset(page);
    await page.locator("#recipient").selectOption("ben");
    await page.locator("#duration").selectOption("60");
    await click(page, "#share"); await click(page, "#open-document");
    await page.reload(); await page.waitForFunction(() => document.documentElement.dataset.ready === "true");
    assert.equal(await page.locator("#viewer").inputValue(), "ben");
    assert.equal(await page.locator("#recipient").inputValue(), "ben");
    assert.equal(await page.locator("#duration").inputValue(), "60");
    assert.equal(await page.locator("#document").isVisible(), true);
  });
  await test("stale denied read cannot revive a revoked grant", async () => {
    await reset(page); await click(page, "#share");
    const stale = await context.newPage();
    await stale.addInitScript(() => {
      const listen = window.addEventListener.bind(window);
      window.addEventListener = (type, ...args) => { if (type !== "storage") listen(type, ...args); };
    });
    await ready(stale); await stale.locator("#viewer").selectOption("ben");
    await click(page, "#revoke"); await click(stale, "#open-document");
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("heaven-browserdemo:v1")).grant.revoked), true);
    await stale.close();
  });
  await test("stale read cannot restore a reset grant", async () => {
    await reset(page); await click(page, "#share");
    const stale = await context.newPage();
    await stale.addInitScript(() => {
      const listen = window.addEventListener.bind(window);
      window.addEventListener = (type, ...args) => { if (type !== "storage") listen(type, ...args); };
    });
    await ready(stale); await reset(page); await click(stale, "#open-document");
    assert.equal(await stale.locator("#document").isVisible(), false);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("heaven-browserdemo:v1")).grant), null);
    await stale.close();
  });
  await test("mobile flow has no horizontal overflow", async () => {
    await reset(page);
    for (const width of [320, 360, 700, 900, 1280, 1920]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 360, height: 800 });
    await click(page, "#share"); await click(page, "#open-document");
    assert.equal(await page.locator("#document").isVisible(), true);
    await click(page, "#revoke");
    assert.equal(await page.locator("#document").isVisible(), false);
    await page.screenshot({ path: join(evidence, "demo-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1024 });
  });
  await test("expiry closes a document already being read", async () => {
    const clockContext = await browser.newContext();
    const clockPage = await clockContext.newPage();
    await clockPage.clock.install();
    await ready(clockPage);
    await clockPage.locator("#duration").selectOption("60");
    await click(clockPage, "#share"); await click(clockPage, "#open-document");
    await clockPage.clock.fastForward(61000); await settled(clockPage);
    assert.equal(await clockPage.locator("#document").isVisible(), false);
    assert.equal(await clockPage.locator("#grant-status").innerText(), "Zugang abgelaufen");
    await click(clockPage, "#open-document");
    assert.match(await clockPage.locator("#open-feedback").innerText(), /Kein Zugriff/);
    await clockContext.close();
  });
  await test("malformed stored state fails closed", async () => {
    const broken = await fresh(() => localStorage.setItem("heaven-browserdemo:v1", '{"version":1,"grant":{"recipient":"anna"},"openedFor":"anna","events":[]}'));
    assert.equal(await broken.page.locator("#document").isVisible(), false);
    assert.equal(await broken.page.locator("#grant-status").innerText(), "Noch kein Zugang");
    assert.match(await broken.page.locator("#announcement").innerText(), /ungültig/);
    await broken.context.close();
  });
  await test("out of range stored timestamp fails closed", async () => {
    const broken = await fresh(() => localStorage.setItem("heaven-browserdemo:v1", JSON.stringify({ version: 1, grant: null, openedFor: null, events: [{ kind: "opened", recipient: "anna", at: Number.MAX_SAFE_INTEGER }] })));
    assert.equal(await broken.page.locator("#grant-status").innerText(), "Noch kein Zugang");
    assert.match(await broken.page.locator("#announcement").innerText(), /ungültig/);
    await broken.context.close();
  });
  await test("unavailable browser storage keeps current tab usable", async () => {
    const restricted = await fresh(() => { Object.defineProperty(Storage.prototype, "getItem", { value() { throw new DOMException("blocked", "SecurityError"); } }); Object.defineProperty(Storage.prototype, "setItem", { value() { throw new DOMException("blocked", "SecurityError"); } }); });
    assert.match(await restricted.page.locator("#storage-note").innerText(), /kein Speichern/);
    await click(restricted.page, "#share"); await click(restricted.page, "#open-document");
    assert.equal(await restricted.page.locator("#document").isVisible(), true);
    await click(restricted.page, "#revoke");
    assert.equal(await restricted.page.locator("#document").isVisible(), false);
    await restricted.context.close();
  });
  await test("browser without Web Locks uses isolated tab state", async () => {
    const restricted = await fresh(() => Object.defineProperty(navigator, "locks", { value: undefined }));
    assert.match(await restricted.page.locator("#storage-note").innerText(), /kein Speichern/);
    await click(restricted.page, "#share"); await click(restricted.page, "#open-document");
    assert.equal(await restricted.page.locator("#document").isVisible(), true);
    await click(restricted.page, "#revoke");
    assert.equal(await restricted.page.locator("#document").isVisible(), false);
    await restricted.context.close();
  });
  await test("contended tab lock times out and permits retry", async () => {
    const blocked = await fresh();
    const holder = await blocked.context.newPage(); await ready(holder);
    const held = holder.evaluate(() => navigator.locks.request("heaven-browserdemo:v1", () => new Promise(resolve => { window.demoLockHeld = true; window.releaseDemoLock = resolve; })));
    await holder.waitForFunction(() => window.demoLockHeld === true);
    const attempted = click(blocked.page, "#share");
    await blocked.page.waitForFunction(() => document.documentElement.dataset.busy === "true");
    assert.equal(await blocked.page.locator("#share").isEnabled(), false);
    await attempted;
    assert.match(await blocked.page.locator("#announcement").innerText(), /anderer Tab/);
    assert.equal(await blocked.page.locator("#grant-status").innerText(), "Noch kein Zugang");
    await holder.evaluate(() => window.releaseDemoLock()); await held;
    await click(blocked.page, "#share");
    assert.equal(await blocked.page.locator("#grant-status").innerText(), "Zugang ist aktiv");
    await blocked.context.close();
  });
  await test("static demo opens directly from disk", async () => {
    const offline = await browser.newContext(); const filePage = await offline.newPage();
    await ready(filePage, pathToFileURL(join(root, "apps/demo/index.html")).href);
    await click(filePage, "#share"); await click(filePage, "#open-document");
    assert.equal(await filePage.locator("#document").isVisible(), true);
    await click(filePage, "#revoke");
    assert.equal(await filePage.locator("#document").isVisible(), false);
    await click(filePage, ".wordmark");
    assert.equal(new URL(filePage.url()).pathname.endsWith("/index.html"), true);
    await filePage.waitForFunction(() => document.documentElement.dataset.ready === "true");
    await offline.close();
  });
  await test("no unhandled page errors", async () => assert.deepEqual(errors, []));
  await reset(page);
  await page.screenshot({ path: join(evidence, "demo-ready.png"), fullPage: true });
  await context.close();
} catch (error) { fatal = error; console.error(error.message); }
finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) {
    const stopped = new Promise(done => server.once("exit", done));
    server.kill("SIGTERM");
    const timer = setTimeout(() => server.kill("SIGKILL"), 3000);
    await stopped; clearTimeout(timer);
  }
  const sources = {};
  for (const file of ["apps/demo/index.html", "apps/demo/main.js", "apps/demo/style.css", "scripts/demo_e2e.mjs"]) sources[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
  await writeFile(join(evidence, "demo-browser.json"), JSON.stringify({ pass: !fatal, origin, elapsed_ms: Math.round(performance.now() - started), cases, sources, browser_kind: "real Chrome, isolated headless contexts", hardware_verified: false }, null, 2) + "\n");
}
if (fatal) process.exitCode = 1;
