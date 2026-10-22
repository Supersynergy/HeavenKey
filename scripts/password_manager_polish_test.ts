import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright-core";

const username = "synthetic@example.invalid", website = "https://example.invalid/login";
const secret = "Synthetic-login-secret-6#X", note = "Synthetic note only";
type Check = (name: string, pass?: boolean) => void;

async function unlocked(page: Page, master: string) {
  await page.locator("#unlock:not([disabled])").waitFor();
  await page.locator("#master").fill(master); await page.locator("#unlock").click();
  await page.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
}
async function settings(page: Page) { await page.locator("#nav-settings").click(); await page.locator("#settings-view:not([hidden])").waitFor(); }
async function entries(page: Page) { if (await page.locator("#settings-view").isVisible()) await page.locator("#close-settings").click(); }
async function hidden(page: Page, value: boolean) {
  await page.evaluate(value => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value ? "hidden" : "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  }, value);
}
async function noPrivateDetail(page: Page) {
  const dom = await page.locator("#workspace").evaluate(el => { const copy = el.cloneNode(true) as HTMLElement; copy.querySelector("#search")?.remove(); return copy.outerHTML; });
  const ax = (await page.locator("#entries").ariaSnapshot()) + (await page.locator("#detail").ariaSnapshot());
  for (const value of [username, website, note, secret, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"]) {
    assert(!dom.includes(value), `discreet DOM excludes ${value}`);
    assert(!ax.includes(value), `discreet accessibility tree excludes ${value}`);
  }
}

// Extends the same real Rust API acceptance; all data remains synthetic.
export async function polishChecks(page: Page, master: string, check: Check) {
  await page.locator("#discreet-toggle").waitFor({ state: "visible", timeout: 1500 });
  await page.locator("#search").fill(""); await page.locator('[data-testid="select-entry"]').click();
  await page.locator('[data-testid="reveal-detail-password"]').click();
  await page.locator('[data-testid="show-totp"]').click(); await page.locator('[data-testid="totp-code"]').waitFor();
  await page.locator("#discreet-toggle").click();
  assert.equal(await page.locator("#discreet-toggle").getAttribute("aria-pressed"), "true");
  await noPrivateDetail(page);
  for (const id of ["reveal-detail-password", "edit-entry", "show-totp"]) {
    const button = page.locator(`[data-testid="${id}"]`);
    if (await button.count()) {
      assert(await button.isDisabled(), `${id} disabled in discreet mode`);
      await button.evaluate(el => (el as HTMLButtonElement).click());
    }
  }
  assert.equal(await page.locator("#editor").isVisible(), false);
  assert.equal(await page.locator('[data-testid="totp-code"]').count(), 0);
  await noPrivateDetail(page);
  check("polish: discreet mode removes private DOM and accessibility values and blocks reveal, edit and TOTP");
  await page.locator("#search").fill(username); assert.equal(await page.locator("#entries > li").count(), 1);
  await noPrivateDetail(page);
  await page.locator("#search").fill(""); await page.locator("#discreet-toggle").click();
  for (const value of [username, website, note]) assert((await page.locator("#detail").textContent())!.includes(value));
  assert.equal(await page.locator('[data-testid="reveal-detail-password"]').getAttribute("aria-pressed"), "false");
  check("polish: private-value search still works and disabling discreet restores fields with password masked");

  const clockStart = Date.now(); await page.clock.install({ time: clockStart }); await page.clock.pauseAt(clockStart + 1000);
  await settings(page);
  assert.equal(await page.locator("#reveal-duration").inputValue(), "15");
  assert.equal(await page.locator("#strict-background").isChecked(), false);
  assert.deepEqual(await page.locator("#reveal-duration option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)), ["10", "15", "30"]);
  await page.locator("#reveal-duration").selectOption("10"); await entries(page);
  await page.locator('[data-testid="reveal-detail-password"]').click();
  assert((await page.locator("#detail").textContent())!.includes(secret));
  await page.clock.fastForward(9999); assert((await page.locator("#detail").textContent())!.includes(secret));
  await page.locator('[data-testid="copy-password"]').focus();
  await page.clock.fastForward(2); assert(!(await page.locator("#detail").textContent())!.includes(secret));
  assert(await page.locator('[data-testid="copy-password"]').evaluate(el => el === document.activeElement), "remasking preserves keyboard focus");
  check("polish: selected 10-second reveal remasks at its deadline under a controlled browser clock");
  await page.locator('[data-testid="reveal-detail-password"]').click();
  await page.locator('[data-testid="select-entry"]').click();
  assert(!(await page.locator("#detail").textContent())!.includes(secret));
  await page.clock.fastForward(11000); assert(!(await page.locator("#detail").textContent())!.includes(secret));
  await page.locator('[data-testid="reveal-detail-password"]').click();
  await page.locator("#search").fill("Synthetic"); assert(!(await page.locator("#detail").textContent())!.includes(secret));
  await page.locator("#search").fill("");
  await page.locator('[data-testid="reveal-detail-password"]').click();
  await page.locator('[data-testid="edit-entry"]').click(); assert(!(await page.locator("#detail").textContent())!.includes(secret));
  await page.keyboard.press("Escape");
  await page.locator('[data-testid="reveal-detail-password"]').click();
  await page.keyboard.press("Control+Alt+l"); await page.locator("#gate:not([hidden])").waitFor();
  await page.locator("#unlock:not([disabled])").waitFor();
  await page.clock.fastForward(31000);
  assert.equal(await page.locator("#detail").textContent(), "");
  assert.equal(await page.locator("#entry-password").inputValue(), "");
  check("polish: selection, filtering, editor and lock cancel reveal and stale timers cannot restore detail");
  await unlocked(page, master);
  await hidden(page, true); await page.clock.fastForward(29999);
  assert(await page.locator("#workspace").isVisible());
  await page.clock.fastForward(2); assert(await page.locator("#gate").isVisible());
  await hidden(page, false); await unlocked(page, master);
  await settings(page); await page.locator("#strict-background").check(); await entries(page);
  await hidden(page, true); await page.clock.runFor(1); assert(await page.locator("#gate").isVisible());
  await hidden(page, false); await unlocked(page, master);
  check("polish: default background lock stays at 30 seconds while strict background setting locks immediately");

  await settings(page);
  const preferences = await page.evaluate(() => JSON.parse(localStorage.getItem("heavenkey-privacy")!));
  assert.equal(preferences.strictBackground, true); assert.equal(preferences.revealSeconds, 10);
  assert(!JSON.stringify(preferences).includes(username));
  await page.locator("#strict-background").uncheck(); await page.locator("#reveal-duration").selectOption("15");
  await entries(page); await page.locator('[data-testid="copy-password"]').click();
  await page.waitForFunction(() => document.querySelector("#status")!.textContent === "Kopiert.");
  await page.clock.fastForward(6001); assert.equal(await page.locator("#status").textContent(), "");
  check("polish: privacy preferences persist only settings and concise success clears after six seconds");
  await page.route("**/api/password-vault", route => route.request().method() === "POST" ? route.fulfill({ status: 503, body: "Synthetic raw server secret" }) : route.continue());
  await page.locator('[data-testid="toggle-favorite"]').click();
  await page.waitForFunction(() => document.querySelector("#status")!.dataset.error === "true");
  const error = await page.locator("#status").textContent();
  await page.clock.fastForward(7000); assert.equal(await page.locator("#status").textContent(), error);
  await page.unroute("**/api/password-vault");
  await settings(page);
  assert((await page.locator("#activity-log").textContent())!.trim().length > 0);
  const requests: string[] = [];
  const localMetadata = ["/api/password-broker", "/api/password-broker/protected/workspaces", "/api/transfer-broker"].map(path => new URL(path, page.url()).href);
  const observe = (request: { url(): string; method(): string }) => { if (request.method() !== "GET" || !localMetadata.includes(request.url())) requests.push(request.url()); };
  page.on("request", observe);
  const event = page.waitForEvent("download"); await page.locator("#export-diagnostics").click(); const download = await event;
  page.off("request", observe); assert.deepEqual(requests, [], "diagnostics download is entirely local");
  const diagnostics = JSON.parse(await readFile((await download.path())!, "utf8"));
  assert.deepEqual(Object.keys(diagnostics).sort(), ["app", "events", "settings", "version"]);
  assert.equal(diagnostics.app, "HeavenKey"); assert.equal(typeof diagnostics.version, "string");
  assert(Array.isArray(diagnostics.events)); assert(diagnostics.events.length <= 40);
  for (const item of diagnostics.events) {
    assert(Object.keys(item).every(key => ["action", "state", "timestamp", "count"].includes(key)));
    assert(["success", "error"].includes(item.state));
    assert.equal(typeof item.timestamp, "string");
  }
  for (const value of [username, website, secret, note, master, error!, "Synthetic raw server secret", "Synthetic <img"]) assert(!JSON.stringify(diagnostics).includes(value));
  await page.locator("#clear-activity").click();
  const clearedEvent = page.waitForEvent("download"); await page.locator("#export-diagnostics").click();
  const cleared = JSON.parse(await readFile((await (await clearedEvent).path())!, "utf8"));
  assert.deepEqual(cleared.events, []);
  check("polish: errors persist; diagnostics allow only bounded session metadata and clear removes all events");
  await entries(page); await page.locator('[data-testid="copy-password"]').click();
  await page.keyboard.press("Control+Alt+l"); await page.locator("#gate:not([hidden])").waitFor();
  assert(!(await page.locator("#activity-log").textContent())!.includes("Kopiert"));
  await unlocked(page, master); await settings(page);
  assert(!(await page.locator("#activity-log").textContent())!.includes("Kopiert")); await entries(page);
  check("polish: lock clears prior session activity and unlock does not restore it");
  await page.clock.resume();
  await keyboardContexts(page, master, check);
  await page.locator("#lock").click(); await unlocked(page, master);
}

async function keyboardContexts(page: Page, master: string, check: Check) {
  const browser = page.context().browser()!;
  const origin = new URL(page.url()).origin;
  for (const [platform, token, modifier] of [["MacIntel", "Macintosh; Intel Mac OS X 10_15_7", "Meta"], ["Win32", "Windows NT 10.0; Win64; x64", "Control"], ["Linux x86_64", "X11; Linux x86_64", "Control"]]) {
    const context = await browser.newContext({ userAgent: `Mozilla/5.0 (${token}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36` });
    await context.addInitScript(platform => Object.defineProperty(navigator, "platform", { get: () => platform }), platform);
    await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const current = await context.newPage();
    const errors: string[] = []; current.on("pageerror", error => errors.push(error.message));
    try {
      await current.goto(origin); await unlocked(current, master);
      await current.locator("#new-entry").focus(); await current.keyboard.press("F1");
      const help = current.locator("#shortcuts-dialog"); await help.waitFor({ state: "visible", timeout: 2000 });
      const keys = await help.locator("kbd").allTextContents();
      assert(keys.length >= 8); assert(keys.every(key => key.trim().length && !key.includes("+")), "each physical key has its own keycap");
      assert(keys.some(key => modifier === "Meta" ? /⌘|Cmd|Command/.test(key) : /Ctrl|Control|Strg/.test(key)));
      assert.match((await help.textContent())!, platform === "MacIntel" ? /macOS|Mac/ : platform === "Win32" ? /Windows/ : /Linux/);
      await current.keyboard.press("Escape"); assert(await help.isHidden());
      assert(await current.locator("#new-entry").evaluate(el => el === document.activeElement));
      await current.keyboard.press(`${modifier}+k`); assert(await current.locator("#search").evaluate(el => el === document.activeElement));
      const browserShortcut = await current.evaluate(modifier => {
        const event = new KeyboardEvent("keydown", { key: "l", bubbles: true, cancelable: true, metaKey: modifier === "Meta", ctrlKey: modifier === "Control" });
        document.dispatchEvent(event); return event.defaultPrevented;
      }, modifier);
      assert.equal(browserShortcut, false); assert(await current.locator("#workspace").isVisible());
      await current.locator('[data-testid="edit-entry"]').click();
      await current.keyboard.press(`${modifier}+Enter`); await current.locator("#editor").waitFor({ state: "hidden" });
      await current.waitForFunction(() => document.querySelector("#workspace")!.getAttribute("aria-busy") === "false");
      await current.locator('[data-testid="edit-entry"]').click(); await current.keyboard.press("F1");
      assert(await help.isVisible()); await current.keyboard.press("Escape");
      assert(await current.locator("#editor").isVisible());
      assert(await current.locator("#entry-title").evaluate(el => el === document.activeElement));
      await current.keyboard.press("Control+Alt+l");
      await current.locator("#gate:not([hidden])").waitFor(); assert(await help.isHidden()); assert(await current.locator("#editor").isHidden());
      await unlocked(current, master); await current.keyboard.press("F1");
      await current.locator("#lock").evaluate(el => (el as HTMLButtonElement).click());
      await current.locator("#gate:not([hidden])").waitFor(); assert(await help.isHidden());
      assert.deepEqual(errors, [], `${platform} context has no uncaught browser errors`);
      check(`polish: ${platform} UA keycaps, F1/Escape focus, ModK, native ModL, editor ModEnter and CtrlAltL lock`);
    } finally { await context.close(); }
  }
}

if (import.meta.main) {
  const acceptance = Bun.spawn([process.execPath, "scripts/password_manager_e2e.mjs"], { env: { ...process.env, HEAVENKEY_PM_POLISH: "1" }, stdout: "inherit", stderr: "inherit" });
  process.exitCode = await acceptance.exited;
}
