import {
	localRequest,
	unlockUsingPasskey,
	type AccessContext,
} from "./passwords-access";
import {
	sealUnlock,
	channelCode,
	validateRequest,
	type UnlockRequest,
} from "../../extension/unlock-channel";

let dismiss: (() => void) | undefined;
export function initExtensionUnlock(ctx: AccessContext) {
	const open = () => openExtensionUnlock(ctx);
	addEventListener("hashchange", open);
	open();
}
function openExtensionUnlock(ctx: AccessContext) {
	const match = location.hash.match(/^#extension-unlock=([A-Za-z0-9_-]{43})$/);
	if (!match) return;
	dismiss?.();
	history.replaceState(null, "", location.pathname);
	const dialog = document.createElement("dialog");
	dialog.dataset.independentControls = "true";
	dialog.setAttribute("aria-labelledby", "extension-unlock-heading");
	dialog.innerHTML =
		'<h2 id="extension-unlock-heading">Erweiterung entsperren</h2><p data-intro>Die gekoppelte Erweiterung fordert Zugriff auf deinen Tresor an.</p><p data-origin></p><p>Vergleiche diesen Code mit dem Fenster der Erweiterung: <strong data-code></strong></p><p>Dein Browser fragt nach Fingerabdruck, Gesicht, Geräte-PIN oder Sicherheitsschlüssel. Ein Passkey mit PRF muss zuvor in HeavenKey eingerichtet sein.</p><p>Die Freigabe gilt nur für das wartende Fenster. Es wird kein Passwort in die Zwischenablage geschrieben.</p><p role="status" data-status>Freigabe wird geladen …</p><div class="actions"><button type="button" data-unlock disabled>Mit Passkey freigeben</button><button type="button" class="secondary" data-cancel>Abbrechen</button></div>';
	document.body.append(dialog);
	dialog.showModal();
	const state = dialog.querySelector<HTMLElement>("[data-status]")!,
		button = dialog.querySelector<HTMLButtonElement>("[data-unlock]")!;
	const controller = new AbortController(),
		timer = setTimeout(() => {
			controller.abort();
			button.disabled = true;
			state.textContent =
				"Freigabe abgelaufen. In der Erweiterung neu starten.";
		}, 90000);
	const check = () => {
		if (controller.signal.aborted || !dialog.open)
			throw Error("Freigabe beendet.");
	};
	const close = () => {
		controller.abort();
		clearTimeout(timer);
		dialog.close();
		dialog.remove();
	};
	dismiss = close;
	dialog.querySelector("[data-cancel]")!.addEventListener("click", close);
	dialog.addEventListener("cancel", close);
	addEventListener("pagehide", close, { once: true });
	void (async () => {
		try {
			// Config arrives asynchronously in the normal application bootstrap.
			const until = Date.now() + 10000;
			while (!ctx.get().token && Date.now() < until) {
				check();
				await new Promise((r) => setTimeout(r, 100));
			}
			check();
			const request = validateRequest(
				await localRequest<UnlockRequest>(
					ctx,
					"/api/password-vault/extension/unlock/describe",
					controller.signal,
					{ id: match[1] },
				),
			);
			check();
			dialog.querySelector("[data-origin]")!.textContent = request.origin;
			dialog.querySelector("[data-code]")!.textContent =
				await channelCode(request);
			check();
			button.disabled = false;
			state.textContent =
				"Nur freigeben, wenn du diese Anfrage gerade selbst gestartet hast.";
			button.onclick = () =>
				void (async () => {
					button.disabled = true;
					try {
						await unlockUsingPasskey(
							ctx,
							controller.signal,
							check,
							async (master, revision, record) => {
								check();
								if (
									revision !== request.revision ||
									record.salt !== request.vault_salt
								)
									throw Error("Der Tresor wurde geändert. Neu anfordern.");
								const sealed = await sealUnlock(request, master);
								check();
								await localRequest(
									ctx,
									"/api/password-vault/extension/unlock/approve",
									controller.signal,
									{ id: request.id, sealed },
								);
								check();
							},
						);
						clearTimeout(timer);
						state.textContent =
							"Einmalig freigegeben. Zur Erweiterung zurückkehren und den Tresor öffnen.";
						button.hidden = true;
					} catch (e) {
						state.textContent =
							e instanceof Error ? e.message : "Entsperren fehlgeschlagen.";
						if (!controller.signal.aborted) button.disabled = false;
					}
				})();
		} catch (e) {
			state.textContent =
				e instanceof Error ? e.message : "Freigabe nicht verfügbar.";
			button.disabled = true;
		}
	})();
}
