import {
	chromium,
	type BrowserContext,
	type Page,
	type CDPSession,
} from "playwright-core";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
	encryptShare,
	readShareFragment,
} from "../apps/web/src/passwords-sharing";
import { freshBytes, encode64 } from "../apps/web/src/passwords-crypto";

const root = resolve(import.meta.dir, "..");
const binary = resolve(process.env.HEAVENKEY_BINARY || "target/debug/uac-api");
const prefix = JSON.parse(process.env.HEAVENKEY_BINARY_PREFIX || "[]");
const evidence = resolve(
	process.env.HEAVENKEY_ACCESS_REPORT ||
		"docs/evidence/password-access/browser.json",
);
const temporary = await mkdtemp(join(tmpdir(), "heavenkey-integrated-access-"));
const origin = "http://localhost:18265",
	master = "Synthetic-integrated-master-only!",
	nextMaster = "Synthetic-integrated-new-master-only!";
const cases: { name: string; pass: boolean }[] = [],
	screenshots: { path: string; sha256: string }[] = [],
	errors: string[] = [],
	bodies: string[] = [],
	urls: string[] = [];
let server: ChildProcess | undefined,
	browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
	serverOutput = "";
const check = (name: string) => {
	cases.push({ name, pass: true });
	console.log("PASS " + name);
};
async function view(page: Page, scope: string, name: string) {
	const failures = await page.locator(scope).evaluate((container) => {
		const rgb = (v: string) => (v.match(/[\d.]+/g) || []).map(Number);
		const bg = (el: Element): number[] => {
			const c = rgb(getComputedStyle(el).backgroundColor);
			return c.length < 4 || c[3] > 0
				? c
				: el.parentElement
					? bg(el.parentElement)
					: [255, 255, 255];
		};
		const lum = (c: number[]) =>
			c.slice(0, 3).reduce((sum, v, i) => {
				const n = v / 255;
				return (
					sum +
					(n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4) *
						[0.2126, 0.7152, 0.0722][i]
				);
			}, 0);
		const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT),
			failures: string[] = [];
		let count = 0;
		while (walker.nextNode()) {
			const n = walker.currentNode,
				el = n.parentElement!;
			if (
				!n.textContent?.trim() ||
				!el.getClientRects().length ||
				el.closest("[hidden],[aria-hidden=true],:disabled")
			)
				continue;
			const a = lum(rgb(getComputedStyle(el).color)),
				b = lum(bg(el));
			count++;
			if ((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) < 4.5)
				failures.push(n.textContent.trim().slice(0, 60));
		}
		if (count < 4) failures.push("missing rendered samples");
		return failures;
	});
	assert.deepEqual(failures, [], name + " visible text contrast >=4.5:1");
	const directory = process.env.HEAVENKEY_ACCESS_SCREENSHOTS;
	if (directory) {
		await mkdir(directory, { recursive: true });
		const path = join(directory, name + ".png");
		await page.screenshot({ path, fullPage: true, animations: "disabled" });
		screenshots.push({
			path,
			sha256: createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		});
	}
}
async function start() {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) =>
				!key.startsWith("UAC_") &&
				!/^HEAVENKEY_(PUBLIC_ORIGIN|ORIGIN|SHARE_ORIGIN|PASSWORD_MANAGER|DOCUMENT)/.test(
					key,
				),
		),
	);
	const folder =
		process.env.HEAVENKEY_WINDOWS_PATHS === "1"
			? "Z:" + temporary.replaceAll("/", "\\")
			: temporary;
	server = spawn(
		prefix[0] || binary,
		[
			...prefix.slice(1),
			...(prefix.length ? [binary] : []),
			"--password-manager",
			"--port",
			"18265",
			"--data-dir",
			folder,
		],
		{ cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	serverOutput = "";
	server.stdout?.on("data", (d) => (serverOutput += d));
	server.stderr?.on("data", (d) => (serverOutput += d));
	const deadline = Date.now() + 15000;
	while (true) {
		try {
			if (
				(await fetch(origin + "/health", { signal: AbortSignal.timeout(500) }))
					.ok
			)
				break;
		} catch {}
		if (Date.now() > deadline)
			throw Error("Server startup failed: " + serverOutput);
		await Bun.sleep(100);
	}
}
async function stop() {
	if (server && server.exitCode === null) {
		server.kill("SIGTERM");
		await new Promise<void>((res, rej) => {
			const timer = setTimeout(() => {
				server?.kill("SIGKILL");
				rej(Error("Server shutdown deadline"));
			}, 5000);
			server!.once("exit", () => {
				clearTimeout(timer);
				res();
			});
		});
	}
}
type Actor = {
	context: BrowserContext;
	page: Page;
	cdp: CDPSession;
	authenticatorId: string;
};
async function actor(prf: boolean): Promise<Actor> {
	const context = await browser!.newContext({
		viewport: { width: 1440, height: 1000 },
		acceptDownloads: true,
	});
	context.setDefaultTimeout(10000);
	await context.route("**/*", (route) =>
		new URL(route.request().url()).origin === origin
			? route.continue()
			: route.abort("internetdisconnected"),
	);
	context.on("request", (request) => {
		urls.push(request.url());
		if (request.url().startsWith(origin + "/api/"))
			bodies.push(request.postData() || "");
	});
	const page = await context.newPage();
	page.on("pageerror", (e) => errors.push(e.message));
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				ctap2Version: "ctap2_1",
				transport: "internal",
				hasResidentKey: true,
				hasUserVerification: true,
				isUserVerified: true,
				automaticPresenceSimulation: true,
				hasPrf: prf,
			},
		},
	);
	return { context, page, cdp, authenticatorId };
}
async function ready(page: Page) {
	await page.locator("#unlock:not([disabled])").waitFor();
}
async function unlock(page: Page, password = master, create = false) {
	await ready(page);
	await page.locator("#master").fill(password);
	if (create) await page.locator("#master-confirm").fill(password);
	await page.locator("#unlock").click();
	await page.locator("#workspace:not([hidden])[aria-busy=false]").waitFor();
}
async function settings(page: Page) {
	await page.bringToFront();
	if (await page.locator("#settings-view").isHidden())
		await page.locator("#nav-settings").click();
}
async function entries(page: Page) {
	if (await page.locator("#settings-view").isVisible())
		await page.locator("#close-settings").click();
}
async function api(
	page: Page,
	path: string,
	body?: unknown,
	method = body === undefined ? "GET" : "POST",
) {
	return page.evaluate(
		async ({ path, body, method }) => {
			const headers: Record<string, string> = {
				"X-HeavenKey-Client": "password-manager",
			};
			const config = await (
				await fetch("/api/password-vault/config", { headers })
			).json();
			headers["X-HeavenKey-Token"] = config.token;
			if (body !== undefined) headers["Content-Type"] = "application/json";
			const r = await fetch(path, {
				method,
				headers,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			return {
				status: r.status,
				value: r.headers.get("content-type")?.includes("application/json")
					? await r.json()
					: { error: await r.text() },
			};
		},
		{ path, body, method },
	);
}
async function enroll(page: Page, label: string) {
	await settings(page);
	await page.locator("#passkey-enroll").click();
	await page.locator("#passkey-label").fill(label);
	await page.locator("#passkey-master").fill(master);
	await page.locator("#password-passkey-dialog button[type=submit]").click();
}
async function shortShare(page: Page, seconds: number) {
	const id = crypto.randomUUID(),
		key = freshBytes(32);
	const sealed = await encryptShare(
		{
			version: 1,
			title: "Synthetic timed copy",
			kind: "login",
			fields: [
				{
					label: "Only selected field",
					value: "synthetic-share@example.invalid",
				},
			],
		},
		key,
		id,
	);
	const response = await api(page, "/api/password-shares", {
		id,
		source_id: "synthetic-timed",
		kind: "login",
		ttl_seconds: seconds,
		...sealed,
	});
	assert.equal(response.status, 200);
	const link =
		origin +
		"/share/#" +
		new URLSearchParams({
			id,
			token: response.value.access_token,
			key: encode64(key),
		});
	key.fill(0);
	return { id, link };
}
try {
	await mkdir(resolve(evidence, ".."), { recursive: true });
	await start();
	browser = await chromium.launch({
		headless: true,
		executablePath:
			process.env.CHROME_PATH ||
			(process.platform === "darwin"
				? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
				: "/usr/bin/google-chrome"),
	});
	const owner = await actor(true);
	await owner.page.goto(origin + "/passwords/");
	await ready(owner.page);
	assert(await owner.page.locator("#onboarding-intro").isVisible());
	assert(await owner.page.locator("#password-passkey-gate").isHidden());
	await owner.page.locator("#onboarding-restore").click();
	assert(
		await owner.page
			.locator("#locked-recovery")
			.evaluate((el: HTMLDetailsElement) => el.open),
	);
	await owner.page
		.locator("#locked-recovery")
		.evaluate((el: HTMLDetailsElement) => (el.open = false));
	check(
		"onboarding: first visit explains setup, offers recovery and has no native passkey prompt",
	);
	await view(owner.page, "#gate", "onboarding");
	await unlock(owner.page, master, true);
	assert(
		await owner.page.locator("[data-testid=setup-first-login]").isVisible(),
	);
	await owner.page.locator("[data-testid=setup-guide]").click();
	assert(await owner.page.locator("#onboarding-dialog").isVisible());
	await view(owner.page, "#onboarding-dialog", "onboarding-guide");
	await owner.page.keyboard.press("Escape");
	assert(await owner.page.locator("#onboarding-dialog").isHidden());
	await owner.page.locator("[data-testid=setup-first-login]").click();
	await owner.page.locator("#entry-title").fill("Synthetic integrated account");
	await owner.page
		.locator("#entry-username")
		.fill("synthetic-access@example.invalid");
	await owner.page
		.locator("#entry-password")
		.fill("Synthetic-secret-never-shared!");
	await owner.page.locator("#entry-url").fill("https://example.invalid/login");
	await owner.page.locator("#save-entry").click();
	await owner.page.locator("#editor").waitFor({ state: "hidden" });
	check(
		"onboarding: guide Escape restores the entry path and first login persists in real encrypted vault",
	);
	await enroll(owner.page, "Synthetic everyday passkey");
	await owner.page
		.locator("#password-passkey-dialog")
		.waitFor({ state: "hidden" });
	await owner.page.locator("#password-passkeys li").waitFor();
	await view(owner.page, "#settings-view", "passkey-settings");
	assert.equal(
		(await api(owner.page, "/api/password-passkeys")).value.credentials.length,
		1,
	);
	check(
		"passkey: actual PRF creation and verified assertion enroll without exporting master to API",
	);
	const credential = (await api(owner.page, "/api/password-passkeys")).value.credentials[0];
	const beforeRename = (await api(owner.page, "/api/password-vault")).value;
	const staleRename = await api(owner.page, "/api/password-passkeys/" + encodeURIComponent(credential.id), { label: "Stale label", revision: beforeRename.revision + 1, vault_salt: beforeRename.record.salt });
	assert.equal(staleRename.status, 409);
	await owner.page.getByRole("button", { name: "Passkey Synthetic everyday passkey umbenennen", exact: true }).click();
	await owner.page.locator("#passkey-rename-label").fill("Synthetic renamed passkey");
	await owner.page.locator("#passkey-rename-dialog button[type=submit]").click();
	await owner.page.locator("#passkey-rename-dialog").waitFor({ state: "hidden" });
	await owner.page.locator("#password-passkeys").getByText("Synthetic renamed passkey", { exact: true }).waitFor();
	assert.equal((await api(owner.page, "/api/password-passkeys")).value.credentials[0].id, credential.id);
	assert.deepEqual((await api(owner.page, "/api/password-vault")).value, beforeRename);
	check("passkey: rename rejects stale revisions and changes only the label, preserving credential and encrypted vault");
	await entries(owner.page);
	await owner.page.locator("#lock").click();
	await owner.page.locator("#passkey-unlock:not([disabled])").waitFor();
	await owner.page.locator("#passkey-unlock").click();
	await owner.page
		.locator("#workspace:not([hidden])[aria-busy=false]")
		.waitFor();
	assert.match(
		await owner.page.locator("#entries").innerText(),
		/Synthetic integrated account/,
	);
	check("passkey: real native assertion decrypts the original master vault");
	await stop();
	await start();
	await owner.page.reload();
	await ready(owner.page);
	assert(await owner.page.locator("#onboarding-intro").isHidden());
	await owner.page.locator("#passkey-unlock:not([disabled])").waitFor();
	await owner.page.locator("#passkey-unlock").click();
	await owner.page
		.locator("#workspace:not([hidden])[aria-busy=false]")
		.waitFor();
	check(
		"passkey: persisted credential and encrypted wrap unlock after a real Rust process restart",
	);
	await owner.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
		authenticatorId: owner.authenticatorId,
		enabled: false,
	});
	await settings(owner.page);
	await owner.page.locator("#passkey-enroll").click();
	await owner.page
		.locator("#passkey-label")
		.fill("Cancelled synthetic enrollment");
	await owner.page.locator("#passkey-master").fill(master);
	const pending = owner.page.waitForRequest((r) =>
		r.url().endsWith("/enroll/start"),
	);
	await owner.page
		.locator("#password-passkey-dialog button[type=submit]")
		.click();
	await pending;
	await owner.page.keyboard.press("Control+Alt+l");
	await ready(owner.page);
	await owner.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
		authenticatorId: owner.authenticatorId,
		enabled: true,
	});
	await unlock(owner.page);
	assert.equal(
		(await api(owner.page, "/api/password-passkeys")).value.credentials.length,
		1,
	);
	check(
		"passkey: explicit lock cancels pending native enrollment and keeps the existing credential",
	);
	const unsupported = await actor(false);
	await unsupported.page.goto(origin + "/passwords/");
	await unlock(unsupported.page);
	await enroll(unsupported.page, "Synthetic non-PRF key");
	await unsupported.page
		.locator("#password-passkey-dialog [role=status]")
		.filter({ hasText: /PRF/ })
		.waitFor();
	await unsupported.page
		.locator("#password-passkey-dialog [data-cancel]")
		.click();
	assert.equal(
		(await api(unsupported.page, "/api/password-passkeys")).value.credentials
			.length,
		1,
	);
	await unsupported.page.locator("#lock").click();
	await unlock(unsupported.page);
	check(
		"passkey: missing native PRF fails without activation and master fallback remains usable",
	);
	await unsupported.context.close();
	await owner.page.bringToFront();
	await entries(owner.page);
	await owner.page.locator("[data-testid=share-entry]").click();
	const sharing = owner.page.locator("#password-share-dialog");
	assert.match(
		await sharing.locator("#share-availability").innerText(),
		/nur auf diesem Computer/,
	);
	await sharing.getByLabel("Nutzername", { exact: true }).check();
	await sharing.locator("#share-ttl").selectOption("300");
	await sharing.locator("#share-consent").check();
	await view(owner.page, "#password-share-dialog", "timed-share");
	await owner.page.keyboard.press("Escape");
	await owner.page.locator("#theme-toggle").click();
	await owner.page.locator("[data-testid=share-entry]").click();
	await view(owner.page, "#password-share-dialog", "timed-share-dark");
	await sharing.getByLabel("Nutzername", { exact: true }).check();
	await sharing.locator("#share-ttl").selectOption("300");
	await sharing.locator("#share-consent").check();
	await sharing.locator("button[type=submit]").click();
	await sharing.locator("[data-result]:not([hidden])").waitFor();
	const link = await sharing.locator("#share-link").inputValue(),
		parts = readShareFragment(new URL(link).hash);
	parts.key.fill(0);
	assert(new URL(link).hash.includes("key=") && !new URL(link).search);
	await sharing.locator("[data-result-close]").click();
	check(
		"sharing: owner explicitly selects one real login field and receives a fragment-only encrypted link",
	);
	const recipient = await actor(false);
	await recipient.page.goto(link);
	assert.equal(new URL(recipient.page.url()).hash, "");
	assert.equal(
		await recipient.page.locator("#share-fields textarea").count(),
		0,
	);
	await recipient.page.locator("#share-open").click();
	await recipient.page.locator("#share-fields textarea").waitFor();
	assert.equal(
		await recipient.page.locator("#share-fields textarea").count(),
		1,
	);
	assert.equal(
		await recipient.page.locator("#share-fields textarea").inputValue(),
		"synthetic-access@example.invalid",
	);
	assert(
		!(await recipient.page.locator("body").innerText()).includes(
			"Synthetic-secret-never-shared!",
		),
	);
	check(
		"sharing: independent recipient claims with its own verified passkey and decrypts only the selected field",
	);
	await view(recipient.page, "#gate", "recipient");
	await recipient.page.locator("#share-theme").click();
	await view(recipient.page, "#gate", "recipient-dark");
	const stranger = await actor(false);
	await stranger.page.goto(link);
	const strangerStart = stranger.page.waitForResponse((r) =>
		r.url().endsWith("/recipient/start"),
	);
	await stranger.page.locator("#share-open").click();
	await strangerStart;
	assert.equal(
		(
			await stranger.cdp.send("WebAuthn.getCredentials", {
				authenticatorId: stranger.authenticatorId,
			})
		).credentials.length,
		0,
	);
	assert.equal(
		await stranger.page.locator("#share-fields textarea").count(),
		0,
	);
	await stranger.page.locator("#share-clear").click();
	check(
		"sharing: an empty recipient authenticator releases no fields while awaiting native verification; cancel clears it",
	);
	const used = bodies
		.map((b) => (b ? JSON.parse(b) : {}))
		.find(
			(b) =>
				b.credential?.response?.authenticatorData &&
				b.access_token &&
				b.request_id,
		);
	assert(used, "observed genuine recipient assertion");
	assert.equal(
		(await api(owner.page, "/api/password-shares/recipient/finish", used))
			.status,
		403,
	);
	check("sharing: a consumed genuine recipient assertion cannot be replayed");
	const denied = await api(owner.page, "/api/password-shares/recipient/start", {
		id: parts.id,
		access_token: "A".repeat(43),
	});
	assert.equal(denied.status, 403);
	check("sharing: wrong access token is rejected without releasing ciphertext");
	await recipient.page.goto(link);
	await recipient.page.locator("#share-open").click();
	await recipient.page.locator("#share-fields textarea").waitFor();
	check(
		"sharing: returning recipient verifies its existing bound passkey before another server release",
	);
	await owner.page.bringToFront();
	await api(
		owner.page,
		"/api/password-shares/" + parts.id,
		undefined,
		"DELETE",
	);
	await recipient.page.goto(link);
	await recipient.page.locator("#share-open").click();
	await recipient.page
		.locator("#share-status")
		.filter({ hasText: /nicht verfügbar/ })
		.waitFor();
	assert.equal(
		await recipient.page.locator("#share-fields textarea").count(),
		0,
	);
	check(
		"sharing: server revocation denies a fresh recipient access and releases no fields",
	);
	const timed = await shortShare(owner.page, 2);
	await Bun.sleep(2200);
	await recipient.page.goto(timed.link);
	await recipient.page.locator("#share-open").click();
	await recipient.page
		.locator("#share-status")
		.filter({ hasText: /nicht verfügbar/ })
		.waitFor();
	assert.equal(
		await recipient.page.locator("#share-fields textarea").count(),
		0,
	);
	check(
		"sharing: real short server TTL expires and rejects access without a clock mock",
	);
	await owner.page.bringToFront();
	await settings(owner.page);
	await owner.page
		.locator("#rekey-form")
		.evaluate(
			(el) => ((el.closest("details") as HTMLDetailsElement).open = true),
		);
	await owner.page.locator("#new-master").fill(nextMaster);
	await owner.page.locator("#new-master-confirm").fill(nextMaster);
	await owner.page.locator("#rekey").click();
	await owner.page.waitForFunction(
		() =>
			document.querySelector("#workspace")?.getAttribute("aria-busy") ===
			"false",
	);
	assert.equal(
		(await api(owner.page, "/api/password-passkeys")).value.credentials.length,
		0,
	);
	const all = (await api(owner.page, "/api/password-shares")).value.shares;
	assert(all.every((s: { revoked: boolean }) => s.revoked));
	check(
		"passkey: master rotation atomically invalidates passkey wraps and revokes outstanding snapshots",
	);
	for (const width of [320, 375, 414, 768, 1440]) {
		await owner.page.setViewportSize({ width, height: 900 });
		assert(
			await owner.page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
		);
	}
	await owner.page.setViewportSize({ width: 1440, height: 1000 });
	await owner.page.locator("#lock").click();
	await ready(owner.page);
	assert(await owner.page.locator("#password-passkey-gate").isHidden());
	await unlock(owner.page, nextMaster);
	check(
		"onboarding: responsive views fit and rekeyed master unlocks with a clear passkey setup state",
	);
	const stored = await readFile(join(temporary, "passwords.sqlite"));
	for (const secret of [
		master,
		nextMaster,
		"Synthetic-secret-never-shared!",
		"synthetic-access@example.invalid",
	])
		assert(
			!stored.includes(Buffer.from(secret)),
			"plaintext absent from SQLite",
		);
	for (const body of bodies) {
		assert(
			!body.includes(master) &&
				!body.includes(nextMaster) &&
				!body.includes("Synthetic-secret-never-shared!") &&
				!body.includes("synthetic-access@example.invalid"),
		);
		if (body) {
			const value = JSON.parse(body);
			assert(!value.credential?.clientExtensionResults?.prf);
		}
	}
	assert(
		urls.every((url) => !url.includes("#") && !/[?&](key|token)=/.test(url)),
	);
	assert.deepEqual(errors, []);
	check(
		"security: stored bytes and API bodies contain no plaintext, PRF outputs or fragment keys; no page errors",
	);
	const report = {
		pass: true,
		binary,
		binary_sha256: createHash("sha256")
			.update(await readFile(binary))
			.digest("hex"),
		synthetic_only: true,
		real_rust: true,
		real_virtual_webauthn: true,
		prf_not_mocked: true,
		native_hardware: false,
		screenshots,
		cases,
		errors,
	};
	await writeFile(evidence, JSON.stringify(report, null, 2) + "\n");
	console.log(
		JSON.stringify({ pass: true, cases: cases.length, report: evidence }),
	);
} catch (error) {
	console.error(error);
	await writeFile(
		evidence,
		JSON.stringify({ pass: false, cases, errors: [String(error)] }, null, 2) +
			"\n",
	);
	throw error;
} finally {
	await browser?.close();
	await stop();
	await rm(temporary, { recursive: true, force: true });
}
