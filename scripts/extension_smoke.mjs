import { chromium } from "playwright-core";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";

const extension = resolve("dist/extension-chromium");
const profile = await mkdtemp(join(tmpdir(), "heavenkey-extension-"));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROME_PATH || chromium.executablePath(),
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const manager = await context.newPage();
  await manager.goto("chrome://extensions");
  const item = manager.locator("extensions-item").filter({ hasText: "HeavenKey" });
  await item.waitFor();
  const id = await item.getAttribute("id");
  assert.match(id, /^[a-p]{32}$/);
  const popup = await context.newPage();
  const errors = [];
  popup.on("pageerror", error => errors.push(error.message));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator("#port").fill("18240");
  const created = context.waitForEvent("page");
  await popup.getByRole("button", { name: "HeavenKey öffnen" }).click();
  const opened = await created;
  await opened.waitForURL("http://localhost:18240/passwords/");
  await popup.locator("#status").filter({ hasText: "Masterpasswort" }).waitFor();
  assert.deepEqual(errors, []);
  await popup.locator("#port").fill("65536");
  assert.equal(await popup.locator("#port").evaluate(input => input.checkValidity()), false);
  const result = { browser: "Chromium", manifest_v3_loaded: true, tab_url: opened.url(), invalid_port_rejected: true, page_errors: errors, pass: true };
  await writeFile("docs/evidence/extension-chromium.json", JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result));
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
