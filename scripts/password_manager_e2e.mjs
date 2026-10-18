import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

const binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const prefix = JSON.parse(process.env.HEAVENKEY_BINARY_PREFIX || "[]");
const temporary = await mkdtemp(join(tmpdir(), "heavenkey-passwords-"));
const origin = "http://localhost:18246";
const master = "synthetic-master-passphrase-only";
const newMaster = "synthetic-new-master-passphrase-only";
const secret = "Synthetic-login-secret-6#X";
const cases = [], errors = [], posts = [];
let server, browser, output = "";
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(UAC_|HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|PASSWORD_MANAGER|KEY_FILE|DOCUMENT))/.test(key)));
async function start() {
  output = "";
  const data = join(temporary, "data");
  const windows = process.env.HEAVENKEY_WINDOWS_PATHS === "1";
  const dataPath = windows ? "Z:" + data.replaceAll("/", "\\") : data;
  server = spawn(prefix[0] || binary, prefix.length ? [...prefix.slice(1), binary, "--password-manager", "--port", "18246", "--data-dir", dataPath] : ["--password-manager", "--port", "18246", "--data-dir", dataPath], { cwd: temporary, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", bytes => output += bytes); server.stderr.on("data", bytes => output += bytes);
  const deadline = Date.now() + 45000;
  while (true) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${output}`);
    if (Date.now() >= deadline) throw new Error(`Startup timeout: ${output}`);
    try { if (output.includes(origin + "/passwords/") && (await fetch(origin + "/health", { signal: AbortSignal.timeout(1000) })).ok) return; }
    catch (error) { if (Date.now() >= deadline) throw new Error(`Startup timeout: ${error.message}; ${output}`); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const stopped = new Promise(resolve => server.once("exit", resolve)); server.kill("SIGINT");
  await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (server.exitCode === null) { server.kill("SIGKILL"); await stopped; }
}
let page;
const check = (name, condition = true) => { assert(condition, name); cases.push({ name, pass: true }); console.log(`PASS ${name}`); };
function observePage(current) {
  current.on("pageerror", error => errors.push(error.message));
  current.on("request", request => { if (request.method() === "POST") posts.push(request.postData() || ""); assert.equal(new URL(request.url()).origin, origin); });
}
async function ready() { await page.locator("#unlock").waitFor({ state: "visible" }); await page.waitForFunction(() => !document.querySelector("#unlock").disabled); }
async function status(text) { await page.waitForFunction(text => document.querySelector("#status").textContent.includes(text), text); }
async function unlock(password, create = false) { await ready(); await page.locator("#master").fill(password); if (create) await page.locator("#master-confirm").fill(password); await page.locator("#unlock").click(); }
async function entries() { if (await page.locator("#settings-view").isVisible()) await page.locator("#close-settings").click(); }
async function settingsSection(text) {
  if (!(await page.locator("#settings-view").isVisible())) await page.locator("#nav-settings").click();
  if (text) { const summary = page.locator("#settings-view summary").filter({ hasText: text }); if (!(await summary.evaluate(el => el.parentElement.open))) await summary.click(); }
}
async function recovery() { if (!(await page.locator("#locked-recovery").evaluate(el => el.open))) await page.locator("#locked-recovery > summary").click(); await page.locator("#locked-restore-form").waitFor({ state: "visible", timeout: 1500 }); }
async function count(expected) { await page.waitForFunction(expected => document.querySelectorAll("#entries > li").length === expected && document.querySelector("#workspace").getAttribute("aria-busy") === "false", expected); await entries(); }
async function snapshot() { return page.evaluate(async () => { const headers = { "X-HeavenKey-Client": "password-manager" }; const { token } = await (await fetch("/api/password-vault/config", { headers })).json(); return (await fetch("/api/password-vault", { headers: { ...headers, "X-HeavenKey-Token": token } })).json(); }); }
try {
  await mkdir("docs/evidence/password-manager", { recursive: true });
  await start();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || (process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome"), headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("internetdisconnected"));
  page = await context.newPage();
  observePage(page);
  await page.goto(origin); await ready();
  check("portable startup redirects to local vault without OS keys", page.url() === origin + "/passwords/");
  await unlock(master, true); await count(0); check("create vault without account or passkey");
  await page.locator("#new-entry").click(); await page.locator("#entry-title").fill("Synthetic <img src=x onerror=alert(1)>");
  await page.locator("#entry-username").fill("synthetic@example.invalid"); await page.locator("#entry-password").fill(secret);
  await page.locator("#entry-url").fill("https://example.invalid/login"); await page.locator("#entry-notes").fill("Synthetic note only");
  await page.locator("#entry-tags").fill("test, lokal"); await page.locator("#entry-favorite").check();
  await page.locator("#entry-totp").fill("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  await page.locator("#save-entry").click(); await count(1);
  check("structured credential saved and title is rendered as text", await page.locator("#entries img").count() === 0);
  await page.locator("[data-testid=show-totp]").click(); await page.locator("[data-testid=totp-code]").waitFor();
  check("TOTP displayed", /^\d{6} /.test(await page.locator("[data-testid=totp-code]").textContent()));
  const { designChecks } = await import("./password_manager_design_test.ts");
  await designChecks(page, master, check);
  if (process.env.HEAVENKEY_PM_POLISH === "1") {
    const { polishChecks } = await import("./password_manager_polish_test.ts");
    const polishContext = await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
    await polishContext.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort("internetdisconnected"));
    await polishContext.grantPermissions(["clipboard-read","clipboard-write"],{origin});
    const polishPage = await polishContext.newPage();
    observePage(polishPage);
    try {
      await polishPage.goto(origin);
      await polishPage.locator("#unlock:not([disabled])").waitFor();
      await polishPage.locator("#master").fill(master); await polishPage.locator("#unlock").click();
      await polishPage.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
      await polishChecks(polishPage, master, check);
    } finally { await polishContext.close(); }
    await page.bringToFront();
    await page.reload(); await unlock(master); await count(1);
    const fixtureState = await page.evaluate(() => ({visibilityOverride:Object.hasOwn(document,"visibilityState"),dateNow:Date.now()}));
    console.log("POLISH_HANDOFF " + JSON.stringify({...fixtureState,wallNow:Date.now()}));
    assert.equal(fixtureState.visibilityOverride, false, "polish must return a native browser visibility getter");
    assert(Math.abs(fixtureState.dateNow-Date.now()) < 5000, "polish must not leave virtual time in the baseline context");
  }
  if (process.env.HEAVENKEY_PM_WORKFLOWS === "1") {
    const { workflowChecks } = await import("./password_manager_workflows_test.ts");
    await workflowChecks(page, master, check, snapshot);
  }
  await page.locator("#search").fill("missing"); await count(0); await page.locator("#search").fill("lokal"); await count(1); check("search includes encrypted tags after unlock");
  await page.locator("#search").fill(""); await page.locator("[data-testid=edit-entry]").click();
  check("edit restores secret only inside unlocked editor", await page.locator("#entry-password").inputValue() === secret);
  await page.locator("#entry-notes").fill("Updated synthetic note"); await page.locator("#save-entry").click(); await status("Login verschlüsselt gespeichert");
  await settingsSection(); const downloadEvent = page.waitForEvent("download"); await page.locator("#export-backup").click(); const download = await downloadEvent;
  const backup = join(temporary, "backup.json"); await download.saveAs(backup); const backupBytes = await readFile(backup, "utf8");
  check("backup contains ciphertext and no credential plaintext", !backupBytes.includes(secret) && !backupBytes.includes("synthetic@example.invalid") && JSON.parse(backupBytes).version === 2 && JSON.parse(backupBytes).kdf === "Argon2id" && JSON.parse(backupBytes).memory_kib === 65536);
  await entries();
  await page.screenshot({ path: "docs/evidence/password-manager/unlocked.png", fullPage: true });
  await page.locator("#lock").click(); await ready();
  check("lock clears credentials and form state", await page.locator("#entries").textContent() === "" && await page.locator("#entry-password").inputValue() === "");
  await unlock("synthetic-wrong-password-only"); await status("Passwort falsch"); check("wrong master rejected");
  await unlock(master); await count(1); check("correct master restores persisted login");
  const second = await context.newPage(); await second.goto(origin); await second.waitForFunction(() => !document.querySelector("#unlock").disabled);
  await second.locator("#master").fill(master); await second.locator("#unlock").click(); await second.locator("#new-entry").waitFor();
  await page.locator("[data-testid=toggle-favorite]").click(); await status("Favorit gespeichert");
  await second.locator("#new-entry").click(); await second.locator("#entry-title").fill("stale write"); await second.locator("#save-entry").click();
  await second.waitForFunction(() => document.querySelector("#status").textContent.includes("Speicherkonflikt")); check("stale tab cannot overwrite current revision"); await second.close();
  await page.locator("[data-testid=delete-entry]").click(); await page.locator("#delete-confirm").click(); await count(0); check("delete persists with confirmation");
  await settingsSection("Verschlüsselte Sicherung wiederherstellen");
  await page.locator("#restore-file").setInputFiles(backup); await page.locator("#restore-master").fill(master); await page.locator("#restore-confirm").check(); await page.locator("#restore-backup").click(); await count(1); check("encrypted backup restored");
  const before = await snapshot();
  const tampered = JSON.parse(backupBytes); tampered.ciphertext = (tampered.ciphertext[0] === "A" ? "B" : "A") + tampered.ciphertext.slice(1);
  await settingsSection("Verschlüsselte Sicherung wiederherstellen");
  await page.locator("#restore-file").setInputFiles({ name: "tampered.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(tampered)) });
  await page.locator("#restore-master").fill(master); await page.locator("#restore-confirm").check(); await page.locator("#restore-backup").click(); await status("Passwort falsch");
  check("tampered restore leaves stored vault unchanged", JSON.stringify(await snapshot()) === JSON.stringify(before));
  await settingsSection("CSV aus Enpass / Bitwarden importieren");
  await page.locator("#import-file").setInputFiles({ name: "valid.csv", mimeType: "text/csv", buffer: Buffer.from('name,login_username,login_password,login_uri,notes\nCSV test,csv@example.invalid,SyntheticCSVSecret,https://example.invalid,"quoted, note"\n') });
  await page.locator("#import-csv").click(); await page.locator("#confirm-import").click(); await count(2); check("quoted synthetic Bitwarden CSV imports atomically");
  const beforeInvalid = await snapshot();
  await settingsSection("CSV aus Enpass / Bitwarden importieren");
  await page.locator("#import-file").setInputFiles({ name: "invalid.csv", mimeType: "text/csv", buffer: Buffer.from('title,password,url\nValid row,test,https://example.invalid\nInvalid row,test,javascript:alert(1)\n') });
  await page.locator("#import-csv").click(); await page.waitForFunction(() => document.querySelector("#status").dataset.error === "true");
  check("invalid later CSV row imports nothing", JSON.stringify(await snapshot()) === JSON.stringify(beforeInvalid));
  await settingsSection("Masterpasswort ändern"); await page.locator("#new-master").fill(newMaster); await page.locator("#new-master-confirm").fill(newMaster); await page.locator("#rekey").click(); await status("Masterpasswort geändert");
  await page.locator("#lock").click(); await ready(); await unlock(master); await status("Passwort falsch"); await unlock(newMaster); await count(2); check("master password change retires old key");
  await page.locator("[data-testid=edit-entry]").first().click(); await page.locator("#generate").click(); check("generator fills a fresh 24-character password", (await page.locator("#entry-password").inputValue()).length === 24);
  await page.locator("#cancel-entry").click();
  await stop(); await start(); await page.reload(); await unlock(newMaster); await count(2); check("real process restart preserves encrypted vault");
  const requestsBefore = posts.length;
  await page.locator("[data-testid=select-entry]").filter({ hasText: "Synthetic <img" }).click();
  await context.setOffline(true); await page.locator("[data-testid=show-totp]").click(); await page.locator("[data-testid=totp-code]").waitFor(); check("TOTP needs no network after unlock");
  await context.setOffline(false); check("no plaintext secret or master sent to API", posts.every(post => !post.includes(secret) && !post.includes(master) && !post.includes(newMaster)) && requestsBefore > 0);
  await page.setViewportSize({ width: 390, height: 844 }); check("mobile-width layout has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: "docs/evidence/password-manager/mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  while (await page.locator("#entries > li").count()) {
    const remaining = await page.locator("#entries > li").count(); await page.locator("[data-testid=select-entry]").first().click();
    await page.locator("[data-testid=delete-entry]").first().click(); await page.locator("#delete-confirm").click(); await count(remaining - 1);
  }
  await settingsSection("CSV aus Enpass / Bitwarden importieren");
  const largeCsv = "Title,Username,Password,URL,Notes\n" + Array.from({ length: 1000 }, (_, i) => `Synthetic ${i},user${i}@example.invalid,SyntheticLarge${i},https://example.invalid,Unicode Schlüssel ${i}`).join("\n");
  await page.locator("#import-file").setInputFiles({ name: "1000-synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(largeCsv) });
  await page.locator("#import-csv").click(); await page.locator("#confirm-import").click(); await count(1000); check("1000 synthetic logins imported with external web requests blocked");
  await page.locator("#lock").click(); await unlock(newMaster); await count(1000); check("1000-entry vault lock and decrypt roundtrip");
  await settingsSection(); const largeDownloadEvent = page.waitForEvent("download"); await page.locator("#export-backup").click(); const largeDownload = await largeDownloadEvent;
  const largeBackup = join(temporary, "1000-backup.json"); await largeDownload.saveAs(largeBackup);
  await settingsSection("Verschlüsselte Sicherung wiederherstellen");
  await page.locator("#restore-file").setInputFiles(largeBackup); await page.locator("#restore-master").fill(newMaster); await page.locator("#restore-confirm").check(); await page.locator("#restore-backup").click(); await status("1000 Logins wiederhergestellt");
  await stop(); await start(); await page.reload(); await unlock(newMaster); await count(1000); check("1000-entry backup restore and cold process restart");
  await page.evaluate(async () => {
    const headers = { "X-HeavenKey-Client": "password-manager", "Content-Type": "application/json" };
    const { token } = await (await fetch("/api/password-vault/config", { headers })).json(); headers["X-HeavenKey-Token"] = token;
    const { revision, record } = await (await fetch("/api/password-vault", { headers })).json();
    record.ciphertext = (record.ciphertext[0] === "A" ? "B" : "A") + record.ciphertext.slice(1);
    const response = await fetch("/api/password-vault", { method: "POST", headers, body: JSON.stringify({ expected_revision: revision, record }) });
    if (!response.ok) throw new Error("corruption fixture rejected");
  });
  await page.locator("#lock").click(); await unlock(newMaster); await status("Passwort falsch");
  await recovery(); check("locked recovery is reachable without successful unlock");
  await page.locator("#locked-restore-file").setInputFiles(largeBackup); await page.locator("#locked-restore-master").fill("synthetic-wrong-backup-password"); await page.locator("#locked-restore-confirm").check();
  const corruptSnapshot = await snapshot(); await page.locator("#locked-restore-submit").click(); await status("Passwort falsch");
  await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
  check("locked restore with wrong backup password preserves damaged current file", JSON.stringify(await snapshot()) === JSON.stringify(corruptSnapshot));
  await page.locator("#locked-restore-master").fill(newMaster); await page.locator("#locked-restore-submit").click(); await status("Sicherung wiederhergestellt");
  await stop(); await start(); await page.reload(); await unlock(newMaster); await count(1000); check("valid backup recovers corrupted vault from locked screen and survives restart");
  for (const corruption of ["invalid-base64", "invalid-json"]) {
    await stop();
    const db = new Database(join(temporary, "data/passwords.sqlite"));
    const current = db.query("SELECT record FROM password_manager WHERE id=1").get();
    const bad = JSON.parse(current.record); bad.ciphertext = "!";
    db.query("UPDATE password_manager SET record=? WHERE id=1").run(corruption === "invalid-json" ? "invalid old JSON" : JSON.stringify(bad)); db.close();
    await start(); await page.reload();
    await page.waitForFunction(() => document.querySelector("#status").dataset.error === "true" && document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    check(`${corruption} prevents ordinary unlock`, await page.locator("#unlock").isDisabled());
    await recovery();
    await page.locator("#locked-restore-file").setInputFiles(largeBackup); await page.locator("#locked-restore-master").fill(newMaster); await page.locator("#locked-restore-confirm").check();
    await page.locator("#locked-restore-submit").click(); await status("Sicherung wiederhergestellt"); await unlock(newMaster); await count(1000);
    check(`${corruption} can be replaced by validated encrypted backup`);
  }
  // Exercise a pre-Argon2 backup through the real legacy unlock and migration controls.
  const { derive, sealVault, freshBytes, encode64 } = await import("../apps/web/src/passwords-crypto.ts");
  const legacySalt = freshBytes(16), legacyKey = await derive(newMaster, legacySalt);
  const legacy = await sealVault({version:1,entries:[{id:"legacy",title:"Legacy migration",username:"old@example.invalid",password:secret,url:"https://example.invalid",notes:"",totp:"",tags:[],favorite:false}]}, legacyKey, encode64(legacySalt));
  await page.evaluate(async record => {
    const headers = {"X-HeavenKey-Client":"password-manager","Content-Type":"application/json"};
    const {token} = await (await fetch("/api/password-vault/config",{headers})).json(); headers["X-HeavenKey-Token"]=token;
    const {revision} = await (await fetch("/api/password-vault",{headers})).json();
    const saved = await fetch("/api/password-vault",{method:"POST",headers,body:JSON.stringify({record,expected_revision:revision})});
    if(!saved.ok) throw Error("Legacy fixture rejected");
  }, legacy);
  await page.reload(); await unlock(newMaster); await count(1);
  check("legacy PBKDF2 backup unlocks without automatic rewrite", (await snapshot()).record.version === 1);
  await page.locator("[data-testid=toggle-favorite]").click(); await status("Favorit gespeichert");
  check("ordinary legacy save preserves PBKDF2 metadata", (await snapshot()).record.kdf === "PBKDF2-SHA256");
  await settingsSection("Masterpasswort ändern");
  check("legacy trust marker explains explicit upgrade", (await page.locator("#vault-kdf").textContent()).includes("PBKDF2-SHA256"));
  await page.locator("#new-master").fill(newMaster); await page.locator("#new-master-confirm").fill(newMaster); await page.locator("#rekey").click(); await status("Masterpasswort geändert");
  const migrated = (await snapshot()).record;
  check("explicit same-password migration replaces KDF and salt atomically", migrated.version === 2 && migrated.kdf === "Argon2id" && migrated.salt !== legacy.salt);
  check("trust marker reports actual Argon2id parameters", (await page.locator("#vault-kdf").textContent()).includes("64 MiB"));
  await stop(); await start(); await page.reload(); await unlock(newMaster); await count(1);
  await page.locator("[data-testid=edit-entry]").click();
  check("legacy credential survives Argon2 migration and process restart", await page.locator("#entry-password").inputValue() === secret);
  await page.locator("#cancel-entry").click();
  await page.locator("#lock").click(); await ready(); check("lock returns focus to master", await page.locator("#master").evaluate(element => element === document.activeElement));
  await page.screenshot({ path: "docs/evidence/password-manager/locked.png", fullPage: true });
  check("no uncaught browser errors", errors.length === 0);
  const db = await readFile(join(temporary, "data/passwords.sqlite")); check("stored file contains no plaintext credentials", !db.includes(Buffer.from(secret)) && !db.includes(Buffer.from("synthetic@example.invalid")));
  const report = { pass: true, binary, binary_sha256: createHash("sha256").update(await readFile(binary)).digest("hex"), cases, errors, online_service_used: false, synthetic_only: true };
  await writeFile(process.env.HEAVENKEY_PM_REPORT || "docs/evidence/password-manager/browser.json", JSON.stringify(report, null, 2) + "\n"); console.log(JSON.stringify(report));
} catch (error) {
  const state = await page?.evaluate(() => ({status:document.querySelector("#status")?.textContent,
    gateHidden:document.querySelector("#gate")?.hidden,workspaceHidden:document.querySelector("#workspace")?.hidden,
    busy:document.querySelector("#workspace")?.getAttribute("aria-busy"),visibility:document.visibilityState,
    visibilityOverride:Object.hasOwn(document,"visibilityState"),dateNow:Date.now(),performanceNow:performance.now(),
    preferences:localStorage.getItem("heavenkey-privacy")})).catch(() => null);
  console.error("FAILURE_STATE " + JSON.stringify(state));
  await page?.screenshot({ path: "docs/evidence/password-manager/failure.png", fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); await stop(); await rm(temporary, { recursive: true, force: true }); }
