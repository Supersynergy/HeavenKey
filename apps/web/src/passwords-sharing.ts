import { decode64, encode64, freshBytes, type Login } from "./passwords-crypto";
import { localRequest, type AccessContext } from "./passwords-access";
import type { FormProfile } from "../../../packages/forms/schema";
export type SharedPayload = {
	version: 1;
	title: string;
	kind: "login" | "profile";
	fields: { label: string; value: string }[];
};
export type SealedShare = { nonce: string; ciphertext: string };
const utf8 = new TextEncoder(),
	noop = () => {};
const aad = (id: string) => utf8.encode("HeavenKey share v1\0" + id);
export function validateSharedPayload(value: unknown): SharedPayload {
	const item = value as SharedPayload;
	if (
		!item ||
		typeof item !== "object" ||
		Object.keys(item).sort().join() !== "fields,kind,title,version" ||
		item.version !== 1 ||
		!["login", "profile"].includes(item.kind) ||
		typeof item.title !== "string" ||
		!item.title.trim() ||
		item.title.length > 200 ||
		!Array.isArray(item.fields) ||
		item.fields.length < 1 ||
		item.fields.length > 100
	)
		throw new Error("Ungültige geteilte Kopie.");
	for (const field of item.fields)
		if (
			!field ||
			typeof field !== "object" ||
			Object.keys(field).sort().join() !== "label,value" ||
			typeof field.label !== "string" ||
			!field.label.trim() ||
			field.label.length > 120 ||
			typeof field.value !== "string" ||
			field.value.length > 10000
		)
			throw new Error("Ungültiges geteiltes Feld.");
	if (utf8.encode(JSON.stringify(item)).length > 32768)
		throw new Error("Die ausgewählten Felder überschreiten 32 KiB.");
	return item;
}
export async function encryptShare(
	payload: SharedPayload,
	rawKey: Uint8Array<ArrayBuffer>,
	id: string,
	guard = noop,
): Promise<SealedShare> {
	guard();
	validateSharedPayload(payload);
	if (rawKey.length !== 32) throw new Error("Ungültige Schlüssellänge.");
	const plain = utf8.encode(JSON.stringify(payload));
	try {
		const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
			"encrypt",
		]);
		guard();
		const nonce = freshBytes(12);
		const cipher = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: aad(id) },
			key,
			plain,
		);
		guard();
		return {
			nonce: encode64(nonce),
			ciphertext: encode64(new Uint8Array(cipher)),
		};
	} finally {
		plain.fill(0);
	}
}
export async function decryptShare(
	sealed: SealedShare,
	rawKey: Uint8Array<ArrayBuffer>,
	id: string,
	guard = noop,
): Promise<SharedPayload> {
	guard();
	const nonce = decode64(sealed.nonce, 12),
		cipher = decode64(sealed.ciphertext, 32784);
	if (nonce.length !== 12 || rawKey.length !== 32 || cipher.length < 16)
		throw new Error("Ungültige verschlüsselte Kopie.");
	const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
		"decrypt",
	]);
	guard();
	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce, additionalData: aad(id) },
			key,
			cipher,
		),
	);
	try {
		guard();
		return validateSharedPayload(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)),
		);
	} finally {
		plain.fill(0);
	}
}
export function shareTime(value: unknown): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 0 ||
		value > Number.MAX_SAFE_INTEGER / 1000
	)
		throw new Error("Ungültige Ablaufzeit.");
	return value * 1000;
}
export function readShareFragment(fragment: string): {
	id: string;
	token: string;
	key: Uint8Array<ArrayBuffer>;
} {
	if (fragment.length > 1024) throw new Error("Ungültiger Freigabelink.");
	const values = new URLSearchParams(fragment.replace(/^#/, ""));
	if ([...values.keys()].sort().join() !== "id,key,token")
		throw new Error("Ungültiger Freigabelink.");
	const id = values.get("id")!,
		token = values.get("token")!,
		key = decode64(values.get("key"), 32);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			id,
		) ||
		decode64(token, 32).length !== 32 ||
		key.length !== 32
	)
		throw new Error("Ungültiger Freigabelink.");
	return { id, token, key };
}
const labels: Record<string, string> = {
	username: "Nutzername",
	password: "Passwort",
	url: "Webadresse",
	notes: "Notizen",
	totp: "TOTP-Schlüssel",
	firstName: "Vorname",
	lastName: "Nachname",
	name: "Name",
	email: "E-Mail",
	phone: "Telefon",
	company: "Firma",
	street: "Straße",
	houseNumber: "Hausnummer",
	zip: "Postleitzahl",
	city: "Ort",
	country: "Land",
	iban: "IBAN",
	bic: "BIC",
	creditcard: "Kartennummer",
	cvc: "Kartenprüfnummer",
	birthdate: "Geburtsdatum",
};
type ShareRow = {
	id: string;
	source_id: string;
	kind: "login" | "profile";
	created_at: number;
	expires_at: number;
	revoked: boolean;
	claimed: boolean;
};
type CreatedShare = {
	id: string;
	access_token: string;
	share_origin: string;
	created_at: number;
	expires_at: number;
};
export type SharingContext = Omit<AccessContext, "accept">;
export function initPasswordSharing(ctx: SharingContext) {
	let controller = new AbortController(),
		epoch = 0,
		busy = false,
		refreshing = false,
		selected: { id: string; payload: SharedPayload } | null = null,
		returnFocus: HTMLElement | null = null,
		expiryTimer: ReturnType<typeof setTimeout> | undefined;
	const card = document.createElement("section");
	card.className = "settings-card";
	card.innerHTML =
		'<h2>Zeitlich begrenzt teilen</h2><p class="note">Teile eine verschlüsselte Kopie ausgewählter Felder über die Aktion beim Login oder Formularprofil. Ein Empfänger-Passkey bindet den Link. Widerruf und Ablauf können bereits gelesene oder kopierte Daten nicht zurückholen.</p><ul id="password-shares"></ul>';
	document.getElementById("settings-view")!.append(card);
	const list = card.querySelector("ul")!;
	const dialog = document.createElement("dialog");
	dialog.id = "password-share-dialog";
	dialog.setAttribute("aria-labelledby", "share-heading");
	dialog.innerHTML =
		'<h2 id="share-heading">Ausgewählte Felder teilen</h2><p class="note">Dies ist eine Kopie. Jede Person mit dem vollständigen Link kann sie mit einem eigenen Passkey beanspruchen. Nur ein Empfänger-Passkey kann gebunden werden. Ablauf und Widerruf löschen keine bereits gespeicherten Kopien.</p><p id="share-availability" class="note"></p><form><fieldset><legend>Felder ausdrücklich auswählen</legend><div data-fields></div></fieldset><label for="share-ttl">Gültigkeit</label><select id="share-ttl" required><option value="">Bitte wählen</option><option value="300">5 Minuten</option><option value="3600">1 Stunde</option><option value="86400">1 Tag</option><option value="604800">7 Tage</option></select><label class="checkbox"><input id="share-consent" type="checkbox" required> Ich gebe die ausgewählten Felder als Kopie frei und verstehe die Hinweise.</label><p role="status"></p><div class="actions"><button type="submit">Verschlüsselten Link erstellen</button><button type="button" class="secondary" data-cancel>Schließen</button></div></form><section data-result hidden><label for="share-link">Vollständiger Freigabelink (vertraulich)</label><textarea id="share-link" readonly rows="4" spellcheck="false"></textarea><p data-reachability class="note"></p><button type="button" data-copy>Link kopieren</button><button type="button" class="secondary" data-result-close>Schließen</button></section>';
	document.body.append(dialog);
	const fields = dialog.querySelector("[data-fields]")!,
		form = dialog.querySelector("form")!,
		ttl = dialog.querySelector<HTMLSelectElement>("#share-ttl")!,
		consent = dialog.querySelector<HTMLInputElement>("#share-consent")!,
		message = dialog.querySelector("[role=status]")!,
		result = dialog.querySelector<HTMLElement>("[data-result]")!,
		link = dialog.querySelector<HTMLTextAreaElement>("#share-link")!;
	const guard = (generation: number, operation: number) => {
		if (
			!ctx.current(generation) ||
			!ctx.unlocked() ||
			ctx.get().discreet ||
			operation !== epoch ||
			controller.signal.aborted
		)
			throw new DOMException("Abgebrochen", "AbortError");
	};
	function close() {
		epoch++;
		controller.abort();
		controller = new AbortController();
		clearTimeout(expiryTimer);
		selected = null;
		fields.replaceChildren();
		form.hidden = false;
		form.reset();
		link.value = "";
		result.hidden = true;
		message.textContent = "";
		dialog.close();
		returnFocus?.focus();
		returnFocus = null;
	}
	function setBusy(value: boolean) {
		busy = value;
		for (const input of form.querySelectorAll<
			HTMLInputElement | HTMLSelectElement
		>("input,select"))
			input.disabled = value;
		for (const button of card.querySelectorAll("button"))
			button.disabled = value || !ctx.unlocked() || ctx.get().discreet;
		for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
			button.disabled = button.hasAttribute("data-cancel")
				? false
				: value || !ctx.unlocked() || ctx.get().discreet;
	}
	async function refresh() {
		setBusy(busy);
		if (dialog.open && (!ctx.unlocked() || ctx.get().discreet)) close();
		if (refreshing || !ctx.unlocked() || !ctx.get().token) return;
		refreshing = true;
		const generation = ctx.get().generation,
			operation = epoch;
		try {
			const response = await localRequest<{ shares: ShareRow[] }>(
				ctx,
				"/api/password-shares",
				controller.signal,
			);
			if (!ctx.current(generation) || operation !== epoch) return;
			list.replaceChildren();
			for (const share of response.shares) {
				const item = document.createElement("li"),
					text = document.createElement("span");
				const vault = ctx.get().vault;
				const source =
					share.kind === "login"
						? vault?.entries.find((entry) => entry.id === share.source_id)
						: vault?.profiles?.find(
								(profile) => profile.id === share.source_id,
							);
				const title = ctx.get().discreet
					? "Geteilte Kopie"
					: source?.title || "Geteilte Kopie";
				const expired = Date.now() >= shareTime(share.expires_at);
				text.textContent =
					title +
					" · " +
					(share.revoked
						? "widerrufen"
						: expired
							? "abgelaufen"
							: share.claimed
								? "gebunden"
								: "noch offen") +
					" · " +
					new Date(shareTime(share.expires_at)).toLocaleString();
				item.append(text);
				if (!share.revoked && !expired) {
					const revoke = document.createElement("button");
					revoke.type = "button";
					revoke.className = "secondary";
					revoke.textContent = "Widerrufen";
					revoke.onclick = () =>
						void ctx.run(async (run) => {
							const op = epoch;
							guard(run, op);
							await localRequest(
								ctx,
								"/api/password-shares/" + encodeURIComponent(share.id),
								controller.signal,
								undefined,
								"DELETE",
							);
							guard(run, op);
							ctx.announce(
								"Freigabe widerrufen. Bereits gespeicherte Kopien bleiben beim Empfänger.",
							);
							void refresh();
						});
					item.append(revoke);
				}
				list.append(item);
			}
			if (!response.shares.length) list.textContent = "Noch keine Freigaben.";
		} catch (error) {
			if (
				ctx.current(generation) &&
				operation === epoch &&
				(error as Error).name !== "AbortError"
			)
				list.textContent = "Freigaben derzeit nicht verfügbar.";
		} finally {
			refreshing = false;
			setBusy(busy);
		}
	}
	function open(
		id: string,
		title: string,
		kind: "login" | "profile",
		values: { label: string; value: string }[],
	) {
		if (busy || !ctx.unlocked() || ctx.get().discreet) return;
		close();
		returnFocus = document.activeElement as HTMLElement;
		selected = { id, payload: { version: 1, title, kind, fields: values } };
		dialog.querySelector("#share-availability")!.textContent =
			ctx.get().shareOrigin && ctx.get().shareOrigin !== location.origin
				? "Freigabeadresse: " +
					ctx.get().shareOrigin +
					". Der Dienst muss unter dieser HTTPS-Adresse erreichbar sein."
				: "Dieser Link funktioniert nur auf diesem Computer. Für andere Geräte ist eine erreichbare HTTPS-Freigabeadresse erforderlich.";
		values.forEach((field, index) => {
			const label = document.createElement("label"),
				check = document.createElement("input");
			label.className = "checkbox";
			check.type = "checkbox";
			check.value = String(index);
			check.name = "share-field";
			label.append(check, document.createTextNode(field.label));
			fields.append(label);
		});
		dialog.showModal();
		fields.querySelector<HTMLInputElement>("input")?.focus();
	}
	function shareLogin(login: Login) {
		const current = ctx
			.get()
			.vault?.entries.find((entry) => entry.id === login.id);
		if (!current) return;
		open(
			current.id,
			current.title,
			"login",
			["username", "password", "url", "notes", "totp"]
				.filter((key) => current[key as keyof Login])
				.map((key) => ({
					label: labels[key],
					value: current[key as keyof Login] as string,
				})),
		);
	}
	function shareProfile(profile: FormProfile) {
		const current = ctx
			.get()
			.vault?.profiles?.find((item) => item.id === profile.id);
		if (!current) return;
		open(
			current.id,
			current.title,
			"profile",
			Object.entries(current.entities)
				.filter(([, value]) => !!value)
				.map(([key, value]) => ({ label: labels[key] || key, value: value! })),
		);
	}
	form.onsubmit = (event) => {
		event.preventDefault();
		void ctx.run(async (generation) => {
			const operation = epoch;
			let key: Uint8Array<ArrayBuffer> | undefined;
			try {
				guard(generation, operation);
				if (!selected || !consent.checked)
					throw new Error("Bitte die Freigabe ausdrücklich bestätigen.");
				const seconds = Number(ttl.value);
				if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800)
					throw new Error("Bitte eine Gültigkeit wählen.");
				const chosen = [
					...fields.querySelectorAll<HTMLInputElement>("input:checked"),
				].map((input) => selected!.payload.fields[Number(input.value)]);
				if (!chosen.length) throw new Error("Wähle mindestens ein Feld aus.");
				const payload = validateSharedPayload({
					...selected.payload,
					fields: chosen,
				});
				const id = crypto.randomUUID();
				key = freshBytes(32);
				const sealed = await encryptShare(payload, key, id, () =>
					guard(generation, operation),
				);
				guard(generation, operation);
				const response = await localRequest<CreatedShare>(
					ctx,
					"/api/password-shares",
					controller.signal,
					{
						id,
						source_id: selected.id,
						kind: payload.kind,
						ttl_seconds: seconds,
						...sealed,
					},
				);
				guard(generation, operation);
				const origin = new URL(response.share_origin);
				if (
					origin.origin !== response.share_origin ||
					origin.username ||
					origin.password ||
					!(
						origin.protocol === "https:" ||
						(origin.protocol === "http:" &&
							["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))
					) ||
					response.id !== id ||
					decode64(response.access_token, 32).length !== 32
				)
					throw new Error("Ungültige Freigabeantwort.");
				const expires = shareTime(response.expires_at);
				if (!Number.isFinite(expires) || expires <= Date.now())
					throw new Error("Diese Freigabe ist bereits abgelaufen.");
				link.value =
					origin.origin +
					"/share/#" +
					new URLSearchParams({
						id,
						token: response.access_token,
						key: encode64(key),
					}).toString();
				dialog.querySelector("[data-reachability]")!.textContent = [
					"localhost",
					"127.0.0.1",
					"[::1]",
				].includes(origin.hostname)
					? "Dieser Link funktioniert nur auf diesem Computer. Gültig bis " +
						new Date(expires).toLocaleString() +
						"."
					: "Erreichbar über " +
						origin.origin +
						". Gültig bis " +
						new Date(expires).toLocaleString() +
						".";
				fields.replaceChildren();
				form.hidden = true;
				selected = null;
				result.hidden = false;
				expiryTimer = setTimeout(
					() => {
						link.value = "";
						result.hidden = true;
						form.hidden = false;
						message.textContent = "Die Freigabe ist abgelaufen.";
					},
					Math.min(expires - Date.now(), 604800000),
				);
				ctx.announce(
					"Verschlüsselte Kopie erstellt. Teile den vollständigen Link vertraulich.",
				);
				void refresh();
			} catch (error) {
				if (
					ctx.current(generation) &&
					operation === epoch &&
					(error as Error).name !== "AbortError"
				) {
					message.textContent = (error as Error).message;
					ctx.announce((error as Error).message, true);
				}
			} finally {
				key?.fill(0);
			}
		});
	};
	dialog.querySelector("[data-result-close]")!.addEventListener("click", close);
	dialog.querySelector("[data-cancel]")!.addEventListener("click", () => {
		form.hidden = false;
		close();
	});
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		form.hidden = false;
		close();
	});
	dialog.querySelector("[data-copy]")!.addEventListener("click", () => {
		if (!busy && ctx.unlocked() && !ctx.get().discreet && link.value)
			void navigator.clipboard.writeText(link.value).then(
				() =>
					ctx.announce(
						"Freigabelink kopiert. Die Zwischenablage selbst wieder leeren.",
					),
				() => ctx.announce("Link konnte nicht kopiert werden.", true),
			);
	});
	function clear() {
		returnFocus = null;
		form.hidden = false;
		close();
		list.replaceChildren();
		setBusy(busy);
	}
	window.addEventListener("pagehide", clear);
	return { refresh, clear, setBusy, shareLogin, shareProfile };
}
