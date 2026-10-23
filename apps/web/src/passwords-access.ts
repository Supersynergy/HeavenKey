import {
	decode64,
	encode64,
	freshBytes,
	openVault,
	validateMaster,
	type Envelope,
	type Vault,
} from "./passwords-crypto";
export type AccessContext = {
	get: () => {
		token: string;
		revision: number;
		record: Envelope | null;
		vault: Vault | null;
		generation: number;
		discreet: boolean;
		shareOrigin?: string;
	};
	current: (generation: number) => boolean;
	unlocked: () => boolean;
	run: (task: (generation: number) => Promise<void>) => Promise<void>;
	accept: (
		opened: Awaited<ReturnType<typeof openVault>>,
		revision: number,
		generation: number,
	) => void | Promise<void>;
	announce: (message: string, error?: boolean) => void;
};
export type Wrap = {
	version: 1;
	prf_salt: string;
	nonce: string;
	ciphertext: string;
};
type CredentialRow = {
	id: string;
	label?: string;
	prf_salt: string;
	vault_salt: string;
};
export type CeremonyResponse = {
	request_id: string;
	options: { publicKey: Record<string, unknown> };
	credential_id: string;
};
type UnlockResponse = {
	credential_id: string;
	wrap: Wrap;
	vault_salt: string;
	revision: number;
	record: Envelope;
};
function credentialRows(value: unknown): CredentialRow[] {
	if (!Array.isArray(value) || value.length > 8)
		throw new Error("Ungültige Passkey-Liste.");
	for (const row of value) {
		if (
			!row ||
			typeof row !== "object" ||
			typeof row.id !== "string" ||
			(row.label !== undefined &&
				(typeof row.label !== "string" || row.label.length > 48))
		)
			throw new Error("Ungültiger Passkey.");
		decode64(row.id, 1024);
		checkedBytes(row.prf_salt, 32);
		checkedBytes(row.vault_salt, 16);
	}
	return value as CredentialRow[];
}
const utf8 = new TextEncoder();
const checkedBytes = (value: unknown, length: number) => {
	const bytes = decode64(value, length);
	if (bytes.length !== length) throw new Error("Ungültige Schlüssellänge.");
	return bytes;
};
const noop = () => {};
async function wrappingKey(
	prf: Uint8Array<ArrayBuffer>,
	salt: string,
	guard: () => void,
): Promise<CryptoKey> {
	guard();
	if (prf.length !== 32)
		throw new Error(
			"Dieser Passkey liefert kein nutzbares PRF-Ergebnis. Bitte verwende dein Masterpasswort.",
		);
	const source = await crypto.subtle.importKey("raw", prf, "HKDF", false, [
		"deriveKey",
	]);
	guard();
	const key = await crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: checkedBytes(salt, 32),
			info: utf8.encode("HeavenKey password passkey wrap v1"),
		},
		source,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
	guard();
	return key;
}
const binding = (vaultSalt: string, id: string, origin: string) =>
	utf8.encode(
		"HeavenKey password passkey v1\0" + origin + "\0" + vaultSalt + "\0" + id,
	);
export async function wrapMaster(
	master: string,
	prf: Uint8Array<ArrayBuffer>,
	salt: string,
	vaultSalt: string,
	id: string,
	origin: string,
	guard = noop,
): Promise<Wrap> {
	guard();
	validateMaster(master);
	const plain = utf8.encode(master);
	try {
		const key = await wrappingKey(prf, salt, guard);
		guard();
		const nonce = freshBytes(12);
		const ciphertext = await crypto.subtle.encrypt(
			{
				name: "AES-GCM",
				iv: nonce,
				additionalData: binding(vaultSalt, id, origin),
			},
			key,
			plain,
		);
		guard();
		return {
			version: 1,
			prf_salt: salt,
			nonce: encode64(nonce),
			ciphertext: encode64(new Uint8Array(ciphertext)),
		};
	} finally {
		plain.fill(0);
	}
}
export async function unwrapMaster(
	wrap: Wrap,
	prf: Uint8Array<ArrayBuffer>,
	vaultSalt: string,
	id: string,
	origin: string,
	guard = noop,
): Promise<string> {
	guard();
	if (wrap.version !== 1) throw new Error("Unbekanntes Passkey-Format.");
	const cipher = decode64(wrap.ciphertext, 4112);
	if (cipher.length < 16) throw new Error("Ungültiges Passkey-Format.");
	const key = await wrappingKey(prf, wrap.prf_salt, guard);
	guard();
	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: checkedBytes(wrap.nonce, 12),
				additionalData: binding(vaultSalt, id, origin),
			},
			key,
			cipher,
		),
	);
	try {
		guard();
		const master = new TextDecoder("utf-8", { fatal: true }).decode(plain);
		validateMaster(master);
		return master;
	} finally {
		plain.fill(0);
	}
}
export function serializeCredential(
	credential: PublicKeyCredential,
): Record<string, unknown> {
	const response = credential.response;
	const encoded = (value: ArrayBuffer) => encode64(new Uint8Array(value));
	const result: Record<string, unknown> = {
		id: credential.id,
		rawId: encoded(credential.rawId),
		type: credential.type,
		clientExtensionResults: {},
		response: { clientDataJSON: encoded(response.clientDataJSON) },
	};
	const fields = result.response as Record<string, unknown>;
	if ("attestationObject" in response) {
		fields.attestationObject = encoded(
			(response as AuthenticatorAttestationResponse).attestationObject,
		);
		fields.transports =
			(response as AuthenticatorAttestationResponse).getTransports?.() ?? [];
	} else {
		const assertion = response as AuthenticatorAssertionResponse;
		fields.authenticatorData = encoded(assertion.authenticatorData);
		fields.signature = encoded(assertion.signature);
		fields.userHandle = assertion.userHandle
			? encoded(assertion.userHandle)
			: null;
	}
	if (credential.authenticatorAttachment)
		result.authenticatorAttachment = credential.authenticatorAttachment;
	return result;
}
export async function nativeCredential(
	options: { publicKey: Record<string, unknown> },
	create: boolean,
	signal: AbortSignal,
	extensions?: AuthenticationExtensionsClientInputs,
): Promise<PublicKeyCredential> {
	if (signal.aborted) throw new DOMException("Abgebrochen", "AbortError");
	const original = options.publicKey;
	if (!original || typeof original !== "object")
		throw new Error("Ungültige Passkey-Anfrage.");
	const publicKey = {
		...original,
		challenge: decode64(original.challenge, 1024),
		timeout: 120000,
		extensions: extensions ?? original.extensions,
	} as Record<string, unknown>;
	const descriptors = (items: unknown) => {
		if (!Array.isArray(items) || items.length > 64)
			throw new Error("Ungültige Passkey-Liste.");
		return items.map((item) => ({ ...item, id: decode64(item.id, 1024) }));
	};
	if (create) {
		const user = original.user as Record<string, unknown>;
		publicKey.user = { ...user, id: decode64(user.id, 1024) };
		if (original.excludeCredentials)
			publicKey.excludeCredentials = descriptors(original.excludeCredentials);
		publicKey.authenticatorSelection = {
			...(original.authenticatorSelection as object),
			userVerification: "required",
		};
	} else {
		if (original.allowCredentials)
			publicKey.allowCredentials = descriptors(original.allowCredentials);
		publicKey.userVerification = "required";
	}
	const credential = await (create
		? navigator.credentials.create({
				publicKey: publicKey as unknown as PublicKeyCredentialCreationOptions,
				signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
			})
		: navigator.credentials.get({
				publicKey: publicKey as unknown as PublicKeyCredentialRequestOptions,
				signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
			}));
	if (signal.aborted) throw new DOMException("Abgebrochen", "AbortError");
	if (!credential || credential.type !== "public-key")
		throw new Error("Passkey abgebrochen.");
	return credential as PublicKeyCredential;
}
function prfResult(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> {
	const output =
		credential.getClientExtensionResults() as AuthenticationExtensionsClientOutputs & {
			prf?: { results?: { first?: ArrayBuffer } };
		};
	const result = output.prf?.results?.first;
	if (!result || result.byteLength !== 32)
		throw new Error(
			"Dieser Browser oder Passkey unterstützt PRF nicht. Dein Masterpasswort bleibt verfügbar.",
		);
	return new Uint8Array(result);
}
export async function localRequest<T = unknown>(
	ctx: Pick<AccessContext, "get">,
	path: string,
	signal: AbortSignal,
	body?: unknown,
	method = body === undefined ? "GET" : "POST",
): Promise<T> {
	const response = await fetch(path, {
		method,
		signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
		cache: "no-store",
		credentials: "omit",
		headers: {
			"X-HeavenKey-Client": "password-manager",
			"X-HeavenKey-Token": ctx.get().token,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	if (!response.ok)
		throw new Error(`Anfrage fehlgeschlagen (HTTP ${response.status}).`);
	const text = await response.text();
	if (text.length > 2_000_000) throw new Error("Antwort zu groß.");
	return JSON.parse(text) as T;
}
export async function unlockUsingPasskey(
	ctx: Pick<AccessContext, "get">,
	signal: AbortSignal,
	check: () => void,
	useMaster?: (
		master: string,
		revision: number,
		record: Envelope,
	) => Promise<void>,
) {
	let prf: Uint8Array<ArrayBuffer> | undefined,
		master = "";
	try {
		check();
		const start = await localRequest<
			CeremonyResponse & { credentials: unknown }
		>(ctx, "/api/password-passkeys/auth/start", signal, {});
		check();
		const evalByCredential: Record<string, { first: Uint8Array<ArrayBuffer> }> =
			{};
		for (const row of credentialRows(start.credentials))
			evalByCredential[row.id] = { first: checkedBytes(row.prf_salt, 32) };
		const credential = await nativeCredential(start.options, false, signal, {
			prf: { evalByCredential },
		} as AuthenticationExtensionsClientInputs);
		check();
		prf = prfResult(credential);
		const finished = await localRequest<UnlockResponse>(
			ctx,
			"/api/password-passkeys/auth/finish",
			signal,
			{
				request_id: start.request_id,
				credential: serializeCredential(credential),
			},
		);
		check();
		const selected = credentialRows(start.credentials).find(
			(row) => row.id === credential.id,
		);
		if (
			!selected ||
			finished.credential_id !== credential.id ||
			selected.vault_salt !== finished.vault_salt ||
			selected.prf_salt !== finished.wrap.prf_salt ||
			finished.record.salt !== finished.vault_salt ||
			!Number.isSafeInteger(finished.revision)
		)
			throw new Error("Passkey und Tresor stimmen nicht überein.");
		master = await unwrapMaster(
			finished.wrap,
			prf,
			finished.vault_salt,
			credential.id,
			location.origin,
			check,
		);
		check();
		const opened = await openVault(finished.record, master);
		check();
		if (useMaster) {
			await useMaster(master, finished.revision, finished.record);
			check();
		}
		return { opened, revision: finished.revision };
	} finally {
		master = "";
		prf?.fill(0);
	}
}

export function initPasswordAccess(ctx: AccessContext) {
	let controller = new AbortController(),
		epoch = 0,
		busy = false,
		rows: CredentialRow[] = [],
		returnFocus: HTMLElement | null = null,
		refreshing = false;
	const gate = document.createElement("div");
	gate.id = "password-passkey-gate";
	const unlock = document.createElement("button");
	unlock.type = "button";
	unlock.id = "passkey-unlock";
	unlock.className = "secondary";
	unlock.textContent = "Mit Passkey entsperren";
	gate.append(unlock);
	document.getElementById("unlock-form")!.after(gate);
	const card = document.createElement("section");
	card.className = "settings-card";
	card.id = "passkey-settings";
	card.tabIndex = -1;
	card.innerHTML =
		'<h2>Mit Passkey entsperren</h2><p class="note">Entsperre diesen Tresor mit deinem Passkey, ohne das Masterpasswort einzutippen. Dein Browser und Passkey müssen die nötige Verschlüsselung unterstützen. Das Masterpasswort bleibt als Rückweg verfügbar.</p><button type="button" id="passkey-enroll">Passkey hinzufügen</button><ul id="password-passkeys"></ul>';
	document.getElementById("settings-view")!.append(card);
	const enroll = card.querySelector<HTMLButtonElement>("button")!,
		list = card.querySelector("ul")!;
	const dialog = document.createElement("dialog");
	dialog.id = "password-passkey-dialog";
	dialog.setAttribute("aria-labelledby", "passkey-heading");
	dialog.innerHTML =
		'<h2 id="passkey-heading">Passkey für diesen Tresor</h2><p class="note">Bestätige dein Masterpasswort. Danach werden zwei Passkey-Prüfungen geöffnet. Ohne PRF wird kein Passkey gespeichert.</p><form><label for="passkey-label">Name</label><input id="passkey-label" maxlength="48" required autocomplete="off"><label for="passkey-master">Masterpasswort bestätigen</label><input id="passkey-master" type="password" minlength="14" maxlength="1024" required autocomplete="off"><p role="status"></p><div class="actions"><button type="submit">Passkey einrichten</button><button type="button" class="secondary" data-cancel>Abbrechen</button></div></form>';
	document.body.append(dialog);
	const renameDialog = document.createElement("dialog");
	renameDialog.id = "passkey-rename-dialog";
	renameDialog.setAttribute("aria-labelledby", "passkey-rename-heading");
	renameDialog.innerHTML =
		'<h2 id="passkey-rename-heading">Passkey benennen</h2><form><label for="passkey-rename-label">Name</label><input id="passkey-rename-label" maxlength="48" required autocomplete="off"><p role="status"></p><div class="actions"><button type="submit">Namen speichern</button><button type="button" class="secondary" data-cancel>Abbrechen</button></div></form>';
	document.body.append(renameDialog);
	const renameLabel = renameDialog.querySelector<HTMLInputElement>("input")!;
	const renameMessage = renameDialog.querySelector("[role=status]")!;
	let renameTarget: CredentialRow | null = null;
	function closeRename(cancel = true) {
		if (cancel) {
			epoch++;
			controller.abort();
			controller = new AbortController();
		}
		renameTarget = null;
		renameLabel.value = "";
		renameMessage.textContent = "";
		if (renameDialog.open) renameDialog.close();
		card.focus();
	}
	renameDialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		closeRename();
	});
	renameDialog.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick =
		() => closeRename();
	renameDialog.querySelector("form")!.onsubmit = (event) => {
		event.preventDefault();
		if (busy || !renameTarget || !ctx.unlocked() || ctx.get().discreet) return;
		const id = renameTarget.id,
			name = renameLabel.value.trim(),
			snapshot = ctx.get(),
			op = epoch;
		if (!name || name.length > 48 || /[\x00-\x1f\x7f]/.test(name)) {
			renameMessage.textContent =
				"Einen Namen mit höchstens 48 Zeichen eingeben.";
			return;
		}
		let completed: number | null = null;
		void ctx
			.run(async (run) => {
				try {
					guard(run, op);
					if (!snapshot.record) throw new Error("Tresor nicht verfügbar.");
					await localRequest(
						ctx,
						"/api/password-passkeys/" + encodeURIComponent(id),
						controller.signal,
						{
							label: name,
							revision: snapshot.revision,
							vault_salt: snapshot.record.salt,
						},
					);
					guard(run, op);
					closeRename(false);
					await refresh();
					if (ctx.current(run)) {
						ctx.announce("Passkey-Name gespeichert.");
						completed = run;
					}
				} catch (error) {
					if (
						ctx.current(run) &&
						op === epoch &&
						(error as Error).name !== "AbortError"
					)
						renameMessage.textContent = (error as Error).message;
				}
			})
			.then(() => {
				if (completed !== null && ctx.current(completed) && ctx.unlocked())
					document.getElementById("passkey-rename-" + id)?.focus();
			});
	};
	const label = dialog.querySelector<HTMLInputElement>("#passkey-label")!,
		masterInput = dialog.querySelector<HTMLInputElement>("#passkey-master")!,
		message = dialog.querySelector("[role=status]")!;
	function close() {
		epoch++;
		controller.abort();
		controller = new AbortController();
		masterInput.value = "";
		label.value = "";
		message.textContent = "";
		dialog.close();
		returnFocus?.focus();
		returnFocus = null;
	}
	function guard(generation: number, operation: number) {
		if (
			!ctx.current(generation) ||
			operation !== epoch ||
			controller.signal.aborted
		)
			throw new DOMException("Abgebrochen", "AbortError");
	}
	const available = () =>
		!!ctx.get().token &&
		!!ctx.get().record &&
		typeof PublicKeyCredential !== "undefined";
	function setBusy(value: boolean) {
		busy = value;
		gate.hidden = rows.length === 0;
		for (const input of dialog.querySelectorAll<HTMLInputElement>("input"))
			input.disabled = value;
		unlock.disabled =
			busy || !available() || rows.length === 0 || ctx.unlocked();
		enroll.disabled =
			busy || !ctx.unlocked() || ctx.get().discreet || rows.length >= 8;
		for (const button of list.querySelectorAll("button"))
			button.disabled = busy || !ctx.unlocked() || ctx.get().discreet;
		for (const button of dialog.querySelectorAll<HTMLButtonElement>("button"))
			button.disabled = busy && !button.hasAttribute("data-cancel");
		for (const input of renameDialog.querySelectorAll<
			HTMLInputElement | HTMLButtonElement
		>("input,button"))
			input.disabled = busy && !input.hasAttribute("data-cancel");
	}
	async function refresh() {
		setBusy(busy);
		if (refreshing || !ctx.get().token) return;
		refreshing = true;
		const generation = ctx.get().generation,
			operation = epoch,
			signal = controller.signal;
		try {
			const result = await localRequest<{ credentials: unknown }>(
				ctx,
				"/api/password-passkeys",
				signal,
			);
			guard(generation, operation);
			rows = credentialRows(result.credentials);
			list.replaceChildren();
			for (const row of rows) {
				const item = document.createElement("li"),
					text = document.createElement("span"),
					remove = document.createElement("button");
				const rename = document.createElement("button");
				rename.type = "button";
				rename.className = "secondary";
				rename.textContent = "Umbenennen";
				rename.id = "passkey-rename-" + row.id;
				rename.setAttribute(
					"aria-label",
					"Passkey " +
						(ctx.get().discreet ? "" : row.label || "") +
						" umbenennen",
				);
				rename.onclick = () => {
					if (busy || !ctx.unlocked() || ctx.get().discreet) return;
					renameTarget = row;
					renameLabel.value = row.label || "Passkey";
					renameDialog.showModal();
					renameLabel.focus();
				};
				text.textContent = ctx.get().discreet
					? "Passkey"
					: row.label || "Passkey";
				remove.type = "button";
				remove.className = "secondary";
				remove.textContent = "Entfernen";
				remove.setAttribute(
					"aria-label",
					`Passkey ${ctx.get().discreet ? "" : row.label || ""} entfernen`,
				);
				remove.onclick = () =>
					void ctx.run(async (run) => {
						const op = epoch;
						guard(run, op);
						await localRequest(
							ctx,
							"/api/password-passkeys/" + encodeURIComponent(row.id),
							controller.signal,
							undefined,
							"DELETE",
						);
						guard(run, op);
						ctx.announce("Passkey entfernt.");
						void refresh();
					});
				item.append(text, rename, remove);
				list.append(item);
			}
		} catch (error) {
			if (
				(error as Error).name !== "AbortError" &&
				ctx.current(generation) &&
				operation === epoch
			) {
				rows = [];
				list.textContent =
					"Passkeys derzeit nicht verfügbar. Das Masterpasswort bleibt verfügbar.";
			}
		} finally {
			refreshing = false;
			setBusy(busy);
		}
	}
	enroll.onclick = () => {
		if (enroll.disabled) return;
		returnFocus = document.activeElement as HTMLElement;
		dialog.showModal();
		label.focus();
	};
	dialog.querySelector("[data-cancel]")!.addEventListener("click", close);
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		close();
	});
	dialog.querySelector("form")!.onsubmit = (event) => {
		event.preventDefault();
		void ctx.run(async (generation) => {
			const operation = epoch;
			let master = masterInput.value;
			masterInput.value = "";
			let prf: Uint8Array<ArrayBuffer> | undefined;
			try {
				guard(generation, operation);
				const snapshot = ctx.get();
				if (!ctx.unlocked() || snapshot.discreet || !snapshot.record)
					throw new Error("Tresor zuerst entsperren.");
				await openVault(snapshot.record, master);
				guard(generation, operation);
				const name = label.value.trim();
				if (!name || name.length > 48)
					throw new Error("Name mit 1 bis 48 Zeichen erforderlich.");
				const start = await localRequest<
					CeremonyResponse & { credentials: unknown }
				>(ctx, "/api/password-passkeys/enroll/start", controller.signal, {
					label: name,
					expected_revision: snapshot.revision,
					vault_salt: snapshot.record.salt,
				});
				guard(generation, operation);
				const created = await nativeCredential(
					start.options,
					true,
					controller.signal,
					{ prf: {} } as AuthenticationExtensionsClientInputs,
				);
				guard(generation, operation);
				const verify = await localRequest<CeremonyResponse>(
					ctx,
					"/api/password-passkeys/enroll/verify",
					controller.signal,
					{
						request_id: start.request_id,
						credential: serializeCredential(created),
					},
				);
				guard(generation, operation);
				const salt = encode64(freshBytes(32));
				const assertion = await nativeCredential(
					verify.options,
					false,
					controller.signal,
					{
						prf: { eval: { first: checkedBytes(salt, 32) } },
					} as AuthenticationExtensionsClientInputs,
				);
				guard(generation, operation);
				if (assertion.id !== verify.credential_id)
					throw new Error("Passkey stimmt nicht überein.");
				prf = prfResult(assertion);
				const wrap = await wrapMaster(
					master,
					prf,
					salt,
					snapshot.record.salt,
					verify.credential_id,
					location.origin,
					() => guard(generation, operation),
				);
				guard(generation, operation);
				await localRequest(
					ctx,
					"/api/password-passkeys/enroll/finish",
					controller.signal,
					{
						request_id: verify.request_id,
						credential: serializeCredential(assertion),
						wrap,
					},
				);
				guard(generation, operation);
				close();
				ctx.announce(
					"Passkey eingerichtet. Das Masterpasswort bleibt verfügbar.",
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
				master = "";
				prf?.fill(0);
			}
		});
	};
	unlock.onclick = () =>
		void ctx.run(async (generation) => {
			const operation = epoch,
				check = () => guard(generation, operation);
			const result = await unlockUsingPasskey(ctx, controller.signal, check);
			check();
			await ctx.accept(result.opened, result.revision, generation);
			check();
			ctx.announce("Tresor mit Passkey entsperrt.");
		});
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && !dialog.open) {
			epoch++;
			controller.abort();
			controller = new AbortController();
		}
	});
	function clear() {
		returnFocus = null;
		close();
		closeRename(false);
		rows = [];
		list.replaceChildren();
		setBusy(busy);
	}
	window.addEventListener("pagehide", clear);
	return { refresh, clear, setBusy };
}
