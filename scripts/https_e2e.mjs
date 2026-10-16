import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chromium } from "playwright-core";

const origin = process.env.HEAVENKEY_TEST_ORIGIN;
const data = process.env.HEAVENKEY_TEST_DATA;
const output = process.env.HEAVENKEY_TEST_EVIDENCE;
const localTLS = process.env.HEAVENKEY_LOCAL_TLS_TEST === "1" && /^https:\/\/heaven\.test:\d+$/.test(origin || "");
if (!origin || (!/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(origin) && !localTLS) || !data || !output) {
  throw new Error("explicit owned HTTPS test origin, isolated data and evidence directory required");
}
await mkdir(output, { recursive: true });
const document = await readFile(process.env.HEAVENKEY_DOCUMENT, "utf8");
const cases = [];
const responses = [];
const actors = [];
let browser;
let failure;
async function test(name, action) {
  try { await action(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); throw error; }
}
async function actor(name) {
  const context = await browser.newContext({ ignoreHTTPSErrors: localTLS });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  page.on("response", r => {
    if (r.url().includes("/api/")) responses.push({ actor: name, path: new URL(r.url()).pathname, status: r.status() });
  });
  await page.goto(origin);
  await page.locator("#name").fill(name);
  const value = { context, page, name }; actors.push(value); return value;
}
async function action(a, selector, endpoint) {
  const response = a.page.waitForResponse(r => r.url() === origin + endpoint, { timeout: 15000 });
  await a.page.locator(selector).click();
  const result = await response; assert.equal(result.status(), 200, await result.text()); return result.json();
}
async function confirm(a, selector, endpoint) {
  const response = a.page.waitForResponse(r => r.url() === origin + endpoint, { timeout: 15000 });
  await a.page.locator(selector).click();
  await a.page.locator("#management-confirm").click();
  const result = await response; assert.equal(result.status(), 200, await result.text()); return result.json();
}
async function post(a, path, body) {
  return a.page.evaluate(async ({ path, body }) => {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }, { path, body });
}
async function get(a, path) {
  return a.page.evaluate(async path => {
    const response = await fetch(path);
    return { status: response.status, text: await response.text() };
  }, path);
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: localTLS ? ["--host-resolver-rules=MAP heaven.test 127.0.0.1", "--no-proxy-server", "--ignore-certificate-errors"] : [] });
  const owner = await actor("owner");
  const guest = await actor("guest");
  let grant;
  await test("trusted HTTPS and exact public RP ID", async () => {
    assert.equal(await owner.page.evaluate(() => isSecureContext), true);
    const health = await get(owner, "/health");
    assert.equal(JSON.parse(health.text).mode, "https-passkey-pilot");
    const start = await post(guest, "/api/register/start", { name: "rp-probe" });
    assert.equal(start.body.options.publicKey.rp.id, new URL(origin).hostname);
  });
  await test("document is absent from anonymous routes and web assets", async () => {
    for (const path of ["/", "/main.js", "/style.css", "/document", "/protected-document.txt", "/owner-bootstrap.txt"]) {
      const response = await get(owner, path);
      assert.equal(response.text.includes(document), false, path);
    }
    assert.equal((await get(owner, "/api/grants")).status, 401);
  });
  await test("first visitor cannot claim owner", async () => {
    assert.equal((await post(guest, "/api/register/start", { name: "owner" })).status, 403);
  });
  await test("owner enrolls with one-use operator code and verified passkey", async () => {
    await owner.page.locator("#bootstrap").fill((await readFile(data + "/owner-bootstrap.txt", "utf8")).trim());
    await action(owner, "#register", "/api/register/finish");
    await action(owner, "#login", "/api/auth/finish");
  });
  await test("guest enrolls own passkey and has no access initially", async () => {
    await action(guest, "#register", "/api/register/finish");
    await action(guest, "#login", "/api/auth/finish");
    await guest.page.locator("#grants .empty").waitFor();
  });
  await test("owner issues read access after passkey confirmation", async () => {
    grant = await confirm(owner, "#issue", "/api/grants");
    await owner.page.locator(".grant a").waitFor();
  });
  await test("share link opens recipient account without a bearer credential", async () => {
    const link = await owner.page.locator(".grant a").getAttribute("href");
    assert.equal(link, origin + "/?guest=guest");
    await guest.page.goto(link);
    assert.equal(await guest.page.locator("#name").inputValue(), "guest");
    await action(guest, "#login", "/api/auth/finish");
    await guest.page.locator(".grant button").first().waitFor();
  });
  await test("document opens only after recipient passkey and grant verification", async () => {
    const result = await action(guest, ".grant button:first-child", "/api/auth/finish");
    assert.equal(result.authorized, true); assert.equal(result.data, document);
    const sessionResult = await action(guest, ".grant button:last-child", "/api/read");
    assert.equal(sessionResult.allowed, true); assert.equal(sessionResult.data, document);
    await guest.page.screenshot({ path: output + "/https-document-open.png", fullPage: true });
  });
  await test("fresh ceremony prepared before revocation cannot survive it", async () => {
    const invocation = { grant: grant.grant, resource: "urn:uac:lab:document", action: "Read", arguments: { document: "overview" } };
    const pending = await post(guest, "/api/auth/start", { name: "guest", invocation });
    assert.equal(pending.status, 200);
    const credential = await guest.page.evaluate(async options => {
      const decode = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      options.publicKey.challenge = decode(options.publicKey.challenge);
      for (const c of options.publicKey.allowCredentials || []) c.id = decode(c.id);
      return (await navigator.credentials.get(options)).toJSON();
    }, pending.body.options);
    await confirm(owner, ".grant button:first-child", "/api/grants/revoke");
    const denied = await post(guest, "/api/auth/finish", { request_id: pending.body.request_id, credential, invocation });
    assert.equal(denied.status, 403); assert.equal(denied.body.data, undefined);
    await writeFile(output + "/revocation-response.json", JSON.stringify({ status: denied.status, error: denied.body.error }, null, 2));
  });
  await test("stale recipient page cannot fetch document after revocation", async () => {
    const response = guest.page.waitForResponse(r => r.url() === origin + "/api/auth/start");
    await guest.page.locator(".grant button").first().click();
    assert.equal((await response).status(), 403);
    await guest.page.waitForFunction(() => document.querySelector("#status").dataset.error === "true");
    assert.equal(await guest.page.locator("#result").innerText(), "—");
    await guest.page.screenshot({ path: output + "/https-document-denied.png", fullPage: true });
  });
  await test("reload and recipient login preserve revocation", async () => {
    await guest.page.reload(); await action(guest, "#login", "/api/auth/finish");
    await guest.page.getByText("Widerrufen", { exact: true }).waitFor();
    assert.equal(await guest.page.locator(".grant button").first().isDisabled(), true);
    await guest.page.screenshot({ path: output + "/https-revoked-persistent.png", fullPage: true });
  });
} catch (error) { failure = error; console.error(error); }
finally {
  await browser?.close();
  await writeFile(output + "/HTTPS-ACCEPTANCE.json", JSON.stringify({ pass: !failure, origin, local_tls_with_test_certificate: localTLS, cases, responses, verifier: "real Rust WebAuthn verifier", authenticator: "virtual CTAP2", hardware_verified: false, document_sha256: createHash("sha256").update(document).digest("hex") }, null, 2) + "\n");
}
if (failure) process.exitCode = 1;
