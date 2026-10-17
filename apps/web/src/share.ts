import { initBrand } from "./passwords-brand";
import {
	nativeCredential,
	serializeCredential,
	type CeremonyResponse,
} from "./passwords-access";
import {
	readShareFragment,
	decryptShare,
	shareTime,
} from "./passwords-sharing";
const byId = (id: string) => document.getElementById(id)!;
const open = byId("share-open") as HTMLButtonElement,
	status = byId("share-status"),
	fields = byId("share-fields"),
	expiry = byId("share-expiry");
let link: ReturnType<typeof readShareFragment> | null = null,
	controller = new AbortController(),
	epoch = 0,
	busy = false,
	expiryTimer: ReturnType<typeof setTimeout> | undefined,
	expiryCheck: ReturnType<typeof setInterval> | undefined;
let originalHash = location.hash;
history.replaceState(null, "", location.pathname);
try {
	link = readShareFragment(originalHash);
	status.textContent =
		"Bereit. Erst deine Bestätigung startet die Passkey-Prüfung.";
} catch {
	status.textContent = "Dieser Freigabelink ist unvollständig oder ungültig.";
	open.disabled = true;
} finally {
	originalHash = "";
}
function clear(
	message = "Anzeige geleert. Öffne den ursprünglichen Link erneut, um fortzufahren.",
) {
	epoch++;
	controller.abort();
	controller = new AbortController();
	clearTimeout(expiryTimer);
	clearInterval(expiryCheck);
	link?.key.fill(0);
	link = null;
	fields.replaceChildren();
	document.body.classList.remove("share-opened");
	expiry.textContent = "";
	byId("share-title").textContent = "Geteilte Kopie";
	status.textContent = message;
	open.disabled = true;
	busy = false;
}
function guard(operation: number) {
	if (operation !== epoch || controller.signal.aborted || !link)
		throw new DOMException("Abgebrochen", "AbortError");
}
async function request<T>(
	path: string,
	body: unknown,
	operation: number,
): Promise<T> {
	guard(operation);
	const response = await fetch("/api/password-shares/recipient/" + path, {
		method: "POST",
		cache: "no-store",
		credentials: "omit",
		signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	guard(operation);
	if (!response.ok)
		throw new Error(`Freigabe nicht verfügbar (HTTP ${response.status}).`);
	const text = await response.text();
	guard(operation);
	if (text.length > 100000) throw new Error("Ungültige Freigabeantwort.");
	return JSON.parse(text) as T;
}
open.onclick = async () => {
	if (busy || !link) return;
	busy = true;
	open.disabled = true;
	const operation = epoch;
	fields.replaceChildren();
	clearTimeout(expiryTimer);
	clearInterval(expiryCheck);
	expiry.textContent = "";
	status.textContent = "Passkey wird geprüft …";
	try {
		guard(operation);
		const auth = { id: link.id, access_token: link.token };
		let ceremony = await request<CeremonyResponse & { mode: string }>(
			"start",
			auth,
			operation,
		);
		guard(operation);
		if (ceremony.mode !== "register" && ceremony.mode !== "authenticate")
			throw new Error("Ungültige Passkey-Anfrage.");
		if (ceremony.mode === "register") {
			const credential = await nativeCredential(
				ceremony.options,
				true,
				controller.signal,
			);
			guard(operation);
			ceremony = await request<CeremonyResponse & { mode: string }>(
				"verify",
				{
					...auth,
					request_id: ceremony.request_id,
					credential: serializeCredential(credential),
				},
				operation,
			);
			guard(operation);
			if (ceremony.mode !== "authenticate")
				throw new Error("Ungültige Passkey-Anfrage.");
		}
		const credential = await nativeCredential(
			ceremony.options,
			false,
			controller.signal,
		);
		guard(operation);
		const response = await request<{
			id: string;
			expires_at: number;
			nonce: string;
			ciphertext: string;
		}>(
			"finish",
			{
				...auth,
				request_id: ceremony.request_id,
				credential: serializeCredential(credential),
			},
			operation,
		);
		guard(operation);
		const expires = shareTime(response.expires_at);
		if (
			response.id !== link.id ||
			!Number.isFinite(expires) ||
			expires <= Date.now()
		)
			throw new Error("Diese Freigabe ist abgelaufen.");
		const payload = await decryptShare(response, link.key, link.id, () => {
			guard(operation);
			if (Date.now() >= expires)
				throw new Error("Diese Freigabe ist abgelaufen.");
		});
		guard(operation);
		byId("share-title").textContent = payload.title;
		document.body.classList.add("share-opened");
		for (const field of payload.fields) {
			const container = document.createElement("section"),
				label = document.createElement("h2"),
				value = document.createElement("textarea"),
				copy = document.createElement("button");
			label.textContent = field.label;
			value.value = field.value;
			value.readOnly = true;
			value.rows = Math.min(6, Math.max(2, field.value.split("\n").length));
			value.setAttribute("aria-label", field.label);
			value.spellcheck = false;
			copy.type = "button";
			copy.className = "secondary";
			copy.textContent = "Kopieren";
			copy.setAttribute("aria-label", field.label + " kopieren");
			copy.onclick = () => {
				if (operation !== epoch || Date.now() >= expires) return;
				void navigator.clipboard.writeText(value.value).then(
					() => {
						if (operation === epoch)
							status.textContent =
								"Feld kopiert. Die Zwischenablage selbst wieder leeren.";
					},
					() => {
						if (operation === epoch)
							status.textContent = "Kopieren fehlgeschlagen.";
					},
				);
			};
			container.append(label, value, copy);
			fields.append(container);
		}
		status.textContent =
			"Kopie entschlüsselt. Nur die ausgewählten Felder sind enthalten.";
		expiry.textContent =
			"Verfügbar bis " + new Date(expires).toLocaleString() + ".";
		const expire = () =>
			clear("Die Freigabe ist abgelaufen. Die Anzeige wurde geleert.");
		expiryTimer = setTimeout(expire, Math.min(expires - Date.now(), 604800000));
		expiryCheck = setInterval(() => {
			if (Date.now() >= expires) expire();
		}, 1000);
	} catch (error) {
		if (operation === epoch && (error as Error).name !== "AbortError") {
			fields.replaceChildren();
			status.textContent = (error as Error).message;
		}
	} finally {
		if (operation === epoch) {
			busy = false;
			open.disabled = !link;
		}
	}
};
byId("share-clear").onclick = () => clear();
window.addEventListener("pagehide", () => clear());
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape") clear();
});
initBrand();
let dark = matchMedia("(prefers-color-scheme: dark)").matches;
function theme() {
	document.documentElement.dataset.theme = dark ? "dark" : "light";
	byId("share-theme").textContent = dark ? "Helles Design" : "Dunkles Design";
	byId("share-theme").setAttribute("aria-pressed", String(dark));
}
theme();
byId("share-theme").onclick = () => {
	dark = !dark;
	theme();
};
