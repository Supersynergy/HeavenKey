import { localRequest, type AccessContext } from "./passwords-access";
import { decode64, encode64, freshBytes, totp, type Login } from "./passwords-crypto";

type Client = { id: string; label: string; expires_at: number };
type Request = Client & { client_id: string; origin: string; scope: "login_read"; status: string };
type Session = Client & { client_id: string; origin: string };
type Audit = { at: number; action: string; result: string };
type Broker = {
	version: 1; enabled: boolean; unlocked: boolean; epoch: number; public_key: string;
	clients: Client[]; requests: Request[]; sessions: Session[]; audit: Audit[];
	browser_available: boolean; limits: { session_seconds: number };
};
const utf8 = new TextEncoder();
const base = "/api/password-broker";
const aborted = () => new DOMException("Abgebrochen", "AbortError");
function exactOrigin(url: string): string {
	const parsed = new URL(url);
	if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw aborted();
	return parsed.origin;
}

/** Seal one chosen login; the owner API receives only metadata and ciphertext. */
export async function sealBrokerLogin(
	login: Login, publicKey: string, requestId: string, epoch: number, revision: number,
	guard: () => void,
): Promise<{ key: string; iv: string; ciphertext: string }> {
	guard();
	const raw = freshBytes(32), iv = freshBytes(12);
	let plain: Uint8Array<ArrayBuffer> | undefined;
	try {
		let otp: string | undefined;
		if (login.totp) { guard(); otp = (await totp(login.totp)).code; guard(); }
		plain = utf8.encode(JSON.stringify({ version: 1, url: login.url, username: login.username, password: login.password, ...(otp ? { otp } : {}) }));
		const rsa = await crypto.subtle.importKey("spki", decode64(publicKey, 1024), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
		guard();
		const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
		guard();
		const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode("HeavenKey broker v1\0" + requestId + "\0" + epoch + "\0" + revision) }, aes, plain);
		guard();
		const key = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw);
		guard();
		return { key: encode64(new Uint8Array(key)), iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) };
	} finally { raw.fill(0); plain?.fill(0); }
}

function checkedBroker(value: Broker): Broker {
	if (!value || value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.unlocked !== "boolean" ||
		!Number.isSafeInteger(value.epoch) || value.epoch < 0 || typeof value.public_key !== "string" ||
		typeof value.browser_available !== "boolean" || !value.limits || value.limits.session_seconds !== 300) throw aborted();
	for (const [items, limit] of [[value.clients, 8], [value.requests, 32], [value.sessions, 2], [value.audit, 100]] as const) {
		if (!Array.isArray(items) || items.length > limit) throw aborted();
	}
	for (const row of [...value.clients, ...value.requests, ...value.sessions]) {
		if (!row || typeof row.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(row.id) || typeof row.label !== "string" || row.label.length > 200 || !Number.isSafeInteger(row.expires_at) || row.expires_at < 0) throw aborted();
	}
	for (const row of value.requests) {
		if (row.scope !== "login_read" || typeof row.status !== "string" || typeof row.client_id !== "string" || exactOrigin(row.origin) !== row.origin) throw aborted();
	}
	for (const row of value.sessions) if (typeof row.client_id !== "string" || exactOrigin(row.origin) !== row.origin) throw aborted();
	for (const row of value.audit) if (!row || !Number.isSafeInteger(row.at) || typeof row.action !== "string" || typeof row.result !== "string" || row.action.length > 100 || row.result.length > 100) throw aborted();
	return value;
}

export function initPasswordBroker(ctx: AccessContext) {
	let controller = new AbortController(), lifetime = 0, approval = 0, epoch = 0,
		leaseGeneration = -1, busy = false, working = false, refreshing = false,
		unlocking = false, heartbeating = false, dispatching: string | null = null,
		state: Broker | null = null, selectedRequest: Request | null = null,
		returnFocus: HTMLElement | null = null;
	let heartbeatTimer: ReturnType<typeof setInterval> | undefined,
		pollTimer: ReturnType<typeof setInterval> | undefined,
		pairTimer: ReturnType<typeof setTimeout> | undefined,
		approvalTimer: ReturnType<typeof setTimeout> | undefined;
	const settings = document.getElementById("settings-view")!;
	const make = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) => {
		const node = document.createElement(tag);
		if (text !== undefined) node.textContent = text;
		if (className) node.className = className;
		return node;
	};
	const button = (text: string, action: () => void, className = "secondary") => {
		const node = make("button", text, className); node.type = "button"; node.addEventListener("click", action); return node;
	};
	const card = make("section", undefined, "settings-card"); card.id = "broker-settings"; card.tabIndex = -1;
	const status = make("p", "Broker wird nach lokalem Entsperren verfügbar.", "note"); status.setAttribute("role", "status");
	const pairResult = make("p", undefined, "note"); pairResult.id = "broker-pairing-code"; pairResult.setAttribute("role", "status");
	const pair = button("Agent koppeln", () => void createPairing()); pair.id = "broker-pair";
	const hidePair = button("Kopplungscode ausblenden", clearPairing); hidePair.hidden = true; hidePair.dataset.cancel = "";
	const pairActions = make("div", undefined, "actions"); pairActions.append(pair, hidePair);
	const requests = make("ul"), clients = make("ul"), sessions = make("ul"), audit = make("ul");
	requests.id = "broker-requests"; clients.id = "broker-clients"; sessions.id = "broker-sessions"; audit.id = "broker-audit";
	const trust = make("ul", undefined, "broker-trust");
	for (const text of ["Tresor: lokal verschlüsselt", "Broker: keine Zwischenablage / begrenzte Textansicht", "Shell-Agenten: nur über --broker-sandbox einschließen; kein weiterer Host-Zugriff", "Herausgeber nicht signiert", "Interner Review; kein externes Audit", "Zielwebsite, Host und Administrator gehören zur Vertrauensgrenze"])
		trust.append(make("li", text));
	card.append(make("h2", "Agent-Zugriff"), make("p", "Kopple einen Agenten und entscheide für jede Anmeldung einzeln. Der Agent darf die freigegebene Website bis zu 5 Minuten lesen. Zugangsdaten verlassen den Tresor nur verschlüsselt für den lokalen Browser-Ausführer.", "note"), status, trust, pairActions, pairResult,
		make("h3", "Anfragen"), requests, make("h3", "Gekoppelte Agenten"), clients, make("h3", "Aktive Sitzungen"), sessions, make("h3", "Letzte Broker-Ereignisse"), audit);
	settings.append(card);
	const dialog = make("dialog"); dialog.id = "broker-approval-dialog"; dialog.setAttribute("aria-labelledby", "broker-approval-heading");
	const heading = make("h2", "Anmeldung freigeben"); heading.id = "broker-approval-heading";
	const originText = make("p"); originText.id = "broker-origin";
	const clientText = make("p", undefined, "note"); clientText.id = "broker-client-label";
	const form = make("form"), accountLabel = make("label", "Login ausdrücklich auswählen"); accountLabel.htmlFor = "broker-account";
	const account = make("select"); account.id = "broker-account"; account.required = true;
	const consentLabel = make("label", undefined, "checkbox"), consent = make("input"); consent.type = "checkbox"; consent.id = "broker-consent"; consent.required = true;
	consentLabel.append(consent, document.createTextNode(" Ich erlaube diesem Agenten einmalig: Anmelden und Seite lesen, höchstens 5 Minuten."));
	const message = make("p"); message.setAttribute("role", "status");
	const submit = make("button", "Anmelden und Seite lesen"); submit.type = "submit"; submit.id = "broker-approve";
	const cancel = button("Abbrechen", cancelApproval); cancel.dataset.cancel = "";
	const actions = make("div", undefined, "actions"); actions.append(submit, cancel);
	form.append(accountLabel, account, consentLabel, message, actions);
	dialog.append(heading, originText, clientText,
		make("p", "Nur die angezeigte Website und genau dieser Login werden freigegeben. Kein Zugriff auf Zwischenablage, Cookies, Tresorexport oder rohe Browser-APIs. Klassische Formularanmeldung; externes SSO und Website-Passkeys werden nicht unterstützt.", "note"),
		make("p", "Die Zielwebsite erhält die Anmeldedaten. Eine bösartige Website sowie Programme desselben OS-Benutzers und Administratoren liegen außerhalb dieser Schutzgrenze. Die Agentenbezeichnung ist nicht überprüft.", "note"), form);
	document.body.append(dialog);
	function usable() { return ctx.unlocked() && !!ctx.get().vault && !!ctx.get().token && !ctx.get().discreet; }
	function guard(run: number, generation: number, expectedEpoch = epoch) {
		if (run !== lifetime || !ctx.current(generation) || !usable() || controller.signal.aborted || !expectedEpoch || epoch !== expectedEpoch || leaseGeneration !== generation) throw aborted();
	}
	function clearPairing() { clearTimeout(pairTimer); pairResult.textContent = ""; hidePair.hidden = true; }
	function closeApproval() {
		approval++; clearTimeout(approvalTimer); selectedRequest = null; dispatching = null; account.replaceChildren(); form.reset(); message.textContent = "";
		if (dialog.open) dialog.close();
		if (returnFocus?.isConnected) {
			if (returnFocus instanceof HTMLButtonElement && returnFocus.disabled) card.focus();
			else returnFocus.focus();
		}
		returnFocus = null;
	}
	function cancelApproval() {
		const id = dispatching, run = lifetime, generation = ctx.get().generation;
		closeApproval();
		if (!id || !usable() || !epoch || run !== lifetime || !ctx.current(generation)) return;
		void localRequest(ctx, base + "/requests/" + encodeURIComponent(id), controller.signal, undefined, "DELETE").then(() => {
			if (run === lifetime && ctx.current(generation)) void refresh();
		}, () => { if (run === lifetime) status.textContent = "Abbruch konnte nicht bestätigt werden. Aktive Sitzungen prüfen oder den Tresor sperren."; });
	}
	function setBusy(value: boolean) {
		busy = value;
		const disabled = value || working || !usable() || !epoch;
		for (const control of card.querySelectorAll<HTMLButtonElement>("button")) control.disabled = control.hasAttribute("data-cancel") ? false : disabled;
		pair.disabled = disabled || !state?.browser_available || !state.enabled;
		account.disabled = disabled; consent.disabled = disabled;
		submit.disabled = disabled || !account.value || !consent.checked;
		cancel.disabled = false;
		form.setAttribute("aria-busy", String(working));
	}
	account.addEventListener("change", () => { consent.checked = false; setBusy(busy); });
	consent.addEventListener("change", () => setBusy(busy));
	function sendLock(token: string) {
		if (!token) return;
		void fetch(base + "/lock", { method: "POST", credentials: "omit", cache: "no-store", keepalive: true, headers: { "Content-Type": "application/json", "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": token }, body: "{}" }).catch(() => {});
	}
	function clear(notify = true) {
		if (notify) sendLock(ctx.get().token); lifetime++; controller.abort(); controller = new AbortController();
		clearInterval(heartbeatTimer); clearInterval(pollTimer); clearPairing(); returnFocus = null; closeApproval();
		epoch = 0; leaseGeneration = -1; state = null; refreshing = false; unlocking = false; heartbeating = false; working = false;
		for (const list of [requests, clients, sessions, audit]) list.replaceChildren();
		status.textContent = "Broker gesperrt. Alle Anfragen und Sitzungen werden beendet."; setBusy(busy);
	}
	async function unlocked() {
		if (!usable() || unlocking) return;
		if (epoch && leaseGeneration === ctx.get().generation) { await refresh(); return; }
		if (epoch) clear();
		const run = lifetime, generation = ctx.get().generation, token = ctx.get().token;
		unlocking = true;
		try {
			const result = await localRequest<{ epoch: number }>(ctx, base + "/unlock", controller.signal, {});
			if (run !== lifetime || !ctx.current(generation) || !usable()) { sendLock(token); return; }
			if (!Number.isSafeInteger(result.epoch) || result.epoch <= 0) throw aborted();
			epoch = result.epoch; leaseGeneration = generation;
			heartbeatTimer = setInterval(() => void heartbeat(), 10000);
			pollTimer = setInterval(() => { if (!settings.hidden && !document.hidden) void refresh(); }, 3000);
			await refresh();
		} catch { if (run === lifetime) { status.textContent = "Broker konnte nicht entsperrt werden. Tresor erneut sperren und entsperren."; setBusy(busy); } }
		finally { if (run === lifetime) unlocking = false; }
	}
	async function heartbeat() {
		if (heartbeating) return;
		const run = lifetime, generation = ctx.get().generation, expected = epoch;
		heartbeating = true;
		try { guard(run, generation, expected); await localRequest(ctx, base + "/heartbeat", controller.signal, { epoch: expected }); guard(run, generation, expected); }
		catch { if (run === lifetime) { clear(); ctx.announce("Broker-Verbindung beendet. Bitte den Tresor erneut entsperren.", true); } }
		finally { if (run === lifetime) heartbeating = false; }
	}
	function expiry(seconds: number) { return new Date(seconds * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }); }
	function empty(list: HTMLUListElement, text: string) { if (!list.childElementCount) list.append(make("li", text, "note")); }
	function render() {
		if (!state) return;
		const focused = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
		for (const list of [requests, clients, sessions, audit]) list.replaceChildren();
		status.textContent = !state.enabled ? "Broker deaktiviert." : !state.browser_available ? "Kein unterstützter Chrome-/Chromium-Browser verfügbar." : "Broker bereit. Jede Anmeldung benötigt deine Freigabe.";
		for (const request of state.requests) {
			const row = make("li"), description = make("p", request.origin + " · " + request.label + " (Bezeichnung nicht überprüft) · " + request.status + " · bis " + expiry(request.expires_at));
			row.append(description);
			if (request.status === "pending" && request.expires_at * 1000 > Date.now()) {
				const allow = button("Anfrage prüfen", () => openApproval(request)); allow.id = "broker-review-" + request.id; allow.disabled = !state.browser_available;
				const deny = button("Ablehnen", () => void remove("requests", request.id)); deny.id = "broker-deny-" + request.id;
				const controls = make("div", undefined, "actions"); controls.append(allow, deny); row.append(controls);
			}
			requests.append(row);
		}
		for (const client of state.clients) {
			const row = make("li"), revoke = button("Kopplung widerrufen", () => void remove("clients", client.id)); revoke.id = "broker-revoke-" + client.id;
			row.append(make("p", client.label + " (Bezeichnung nicht überprüft) · bis " + expiry(client.expires_at)), revoke); clients.append(row);
		}
		for (const session of state.sessions) {
			const row = make("li"), close = button("Sitzung beenden", () => void remove("sessions", session.id)); close.id = "broker-close-" + session.id;
			row.append(make("p", session.origin + " · " + session.label + " (Bezeichnung nicht überprüft) · bis " + expiry(session.expires_at)), close); sessions.append(row);
		}
		for (const item of state.audit.slice(-10).reverse()) audit.append(make("li", expiry(item.at) + " · " + item.action + " · " + item.result));
		empty(requests, "Keine offenen Anfragen."); empty(clients, "Noch kein Agent gekoppelt."); empty(sessions, "Keine aktive Sitzung."); empty(audit, "Noch keine Broker-Ereignisse.");
		setBusy(busy);
		if (!dialog.open && focused) document.getElementById(focused)?.focus();
	}
	async function refresh() {
		if (!usable()) { if (epoch) clear(); return; }
		setBusy(busy);
		if (!epoch || refreshing || settings.hidden || document.hidden) return;
		const run = lifetime, generation = ctx.get().generation, expected = epoch;
		refreshing = true;
		try {
			guard(run, generation, expected);
			const response = await localRequest<Broker>(ctx, base, controller.signal);
			guard(run, generation, expected); state = checkedBroker(response);
			if (!state.unlocked || state.epoch !== expected) { clear(); return; }
			if (selectedRequest && !state.requests.some(row => row.id === selectedRequest!.id && row.status === "pending" && row.origin === selectedRequest!.origin)) closeApproval();
			render();
		} catch { if (run === lifetime) status.textContent = "Broker-Status konnte nicht geladen werden."; }
		finally { if (run === lifetime) refreshing = false; }
	}
	async function createPairing() {
		if (busy || working || !state?.browser_available || !state.enabled) return;
		const run = lifetime, generation = ctx.get().generation;
		working = true; clearPairing(); setBusy(busy);
		try {
			guard(run, generation);
			const response = await localRequest<{ code: string; expires_in: number }>(ctx, base + "/pairing", controller.signal, {});
			guard(run, generation);
			if (settings.hidden || typeof response.code !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(response.code) || response.expires_in !== 120) throw aborted();
			pairResult.textContent = "Einmaliger Kopplungscode: " + response.code + " · gültig für 2 Minuten. Nur mit dem gewünschten lokalen Agenten teilen.";
			hidePair.hidden = false; pairTimer = setTimeout(clearPairing, 120000);
		} catch { if (run === lifetime) status.textContent = "Kopplungscode konnte nicht erstellt werden."; }
		finally { if (run === lifetime) { working = false; setBusy(busy); } }
	}
	async function remove(kind: "requests" | "clients" | "sessions", id: string) {
		if (busy || working) return;
		const run = lifetime, generation = ctx.get().generation;
		working = true; setBusy(busy);
		try {
			guard(run, generation);
			await localRequest(ctx, base + "/" + kind + "/" + encodeURIComponent(id), controller.signal, undefined, "DELETE");
			guard(run, generation); if (selectedRequest) closeApproval();
			await refresh(); guard(run, generation);
			ctx.announce(kind === "clients" ? "Kopplung widerrufen; zugehörige Sitzungen werden beendet." : kind === "sessions" ? "Sitzung beendet." : "Anfrage abgelehnt.");
		} catch { if (run === lifetime) status.textContent = "Widerruf fehlgeschlagen. Bitte erneut versuchen."; }
		finally { if (run === lifetime) { working = false; setBusy(busy); } }
	}
	function matches(entry: Login, origin: string) {
		try { const url = new URL(entry.url); return !!entry.password && !url.search && !url.hash && exactOrigin(entry.url) === origin; } catch { return false; }
	}
	function openApproval(request: Request) {
		if (busy || working || !usable() || !epoch || !state?.browser_available || request.status !== "pending" || request.expires_at * 1000 <= Date.now()) return;
		closeApproval(); returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null; selectedRequest = request;
		originText.textContent = "Website: " + request.origin;
		clientText.textContent = "Agent: " + request.label + " · Bezeichnung nicht überprüft · Anfrage läuft um " + expiry(request.expires_at) + " ab.";
		const placeholder = make("option", "Bitte einen passenden Login wählen"); placeholder.value = ""; account.append(placeholder);
		for (const entry of ctx.get().vault!.entries) if (matches(entry, request.origin)) { const option = make("option", entry.title + (entry.username ? " · " + entry.username : "")); option.value = entry.id; account.append(option); }
		if (account.options.length === 1) message.textContent = "Kein Login für exakt diese Website im Tresor. Es kann keine Freigabe erfolgen.";
		consent.checked = false; setBusy(busy); dialog.showModal(); account.focus();
		approvalTimer = setTimeout(closeApproval, Math.min(2147483647, Math.max(0, request.expires_at * 1000 - Date.now())));
	}
	form.addEventListener("submit", event => {
		event.preventDefault(); void approve();
	});
	async function approve() {
		if (busy || working || !selectedRequest || !state || !consent.checked || !account.value) return;
		const request = selectedRequest, run = lifetime, selection = approval,
			{ generation, revision } = ctx.get(), expected = epoch, sourceId = account.value, publicKey = state.public_key;
		const check = () => {
			guard(run, generation, expected);
			if (selection !== approval || !dialog.open || selectedRequest !== request || !consent.checked || account.value !== sourceId || ctx.get().revision !== revision || request.expires_at * 1000 <= Date.now() || !state?.requests.some(row => row.id === request.id && row.status === "pending" && row.origin === request.origin)) throw aborted();
		};
		working = true; message.textContent = "Ausgewählten Login verschlüsseln …"; setBusy(busy);
		try {
			check();
			const entry = ctx.get().vault!.entries.find(item => item.id === sourceId);
			if (!entry || !matches(entry, request.origin)) throw aborted();
			const sealed = await sealBrokerLogin(entry, publicKey, request.id, expected, revision, check);
			check();
			dispatching = request.id;
			await localRequest(ctx, base + "/approve/" + encodeURIComponent(request.id), controller.signal, { epoch: expected, revision, source_id: sourceId, sealed });
			guard(run, generation, expected);
			if (selection !== approval || ctx.get().revision !== revision) throw aborted();
			closeApproval(); ctx.announce("Anmeldung freigegeben. Die Sitzung endet spätestens nach 5 Minuten.");
			await refresh(); guard(run, generation, expected);
		} catch { if (run === lifetime && selection === approval) message.textContent = "Freigabe fehlgeschlagen oder abgelaufen. Prüfe den aktuellen Status, bevor du erneut freigibst."; }
		finally { if (run === lifetime) { working = false; setBusy(busy); } }
	}
	dialog.addEventListener("cancel", event => { event.preventDefault(); cancelApproval(); });
	dialog.addEventListener("close", () => { if (selectedRequest) cancelApproval(); });
	dialog.addEventListener("click", event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancelApproval(); } });
	new MutationObserver(() => { if (settings.hidden) clearPairing(); else void refresh(); }).observe(settings, { attributes: true, attributeFilter: ["hidden"] });
	document.addEventListener("visibilitychange", () => { if (!document.hidden && !settings.hidden) void refresh(); });
	window.addEventListener("pagehide", () => clear());
	setBusy(false);
	return { refresh, clear, setBusy, unlocked };
}
