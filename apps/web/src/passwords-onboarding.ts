import type { Vault } from "./passwords-crypto";
import { createIcon } from "./passwords-presentation";

type OnboardingContext = {
	vault: () => Vault | null;
	hasRecord: () => boolean;
	ready: () => boolean;
	busy: () => boolean;
	login: () => void;
	settings: () => void;
	backup: () => void;
};

export function initOnboarding(ctx: OnboardingContext) {
	const intro = document.createElement("section");
	intro.id = "onboarding-intro";
	intro.className = "onboarding-intro";
	intro.setAttribute("aria-label", "Dein Einstieg");
	intro.innerHTML = `<ol class="onboarding-steps"><li><span>1</span>Eigenen Tresor anlegen</li><li><span>2</span>Login speichern oder importieren</li><li><span>3</span>Sicherung aufbewahren</li></ol><p class="note">Du startest ohne Konto. Einen Passkey kannst du danach ergänzen.</p><button id="onboarding-restore" type="button" class="secondary">Ich habe schon eine Sicherung</button>`;
	document.querySelector(".gate-description")!.after(intro);
	const dialog = document.createElement("dialog");
	dialog.id = "onboarding-dialog";
	dialog.setAttribute("aria-labelledby", "onboarding-heading");
	dialog.innerHTML = `<div class="dialog-heading"><div><p class="eyebrow">ERSTE SCHRITTE</p><h2 id="onboarding-heading">Dein Tresor, Schritt für Schritt</h2></div><button type="button" class="secondary" id="onboarding-close">Schließen</button></div><p class="note">Alles beginnt auf diesem Gerät. Wähle den nächsten Schritt, der für dich passt.</p><ol class="setup-list"><li><div><strong>Dein Tresor</strong><p id="onboarding-vault-state" class="note"></p></div><button id="onboarding-vault" type="button" class="secondary">Zum Tresor</button></li><li><div><strong>Deine ersten Einträge</strong><p class="note">Einen Login anlegen oder eine CSV in den Einstellungen prüfen. Vor dem Import entscheidest du über Duplikate.</p></div><button id="onboarding-login" type="button">Login anlegen</button><button id="onboarding-import" type="button" class="secondary">Import öffnen</button></li><li><div><strong>Deine Sicherung</strong><p class="note">Exportiere eine verschlüsselte Kopie. Bewahre sie getrennt auf und prüfe ihre Wiederherstellung. Du brauchst ihr Masterpasswort.</p></div><button id="onboarding-backup" type="button" class="secondary">Sicherung exportieren</button></li><li><div><strong>Dein Passkey, wenn du möchtest</strong><p class="note">Ergänze in den Einstellungen einen kompatiblen Passkey zum Entsperren. Dein Masterpasswort bleibt der Rückweg.</p></div><button id="onboarding-access" type="button" class="secondary">Passkeys einrichten</button></li></ol><details class="onboarding-help"><summary>GitHub meldet „Repository nicht gefunden“?</summary><p class="note">Der Quellcode und seine Downloads sind privat. Öffne GitHub mit einem Konto, das Zugriff auf Supersynergy/HeavenKey hat. Eine Anmeldung mit einem anderen Konto gibt diesen Zugriff nicht automatisch frei.</p><a href="https://github.com/login?return_to=%2FSupersynergy%2FHeavenKey%2Freleases%2Flatest" target="_blank" rel="noopener noreferrer">Bei GitHub anmelden und Downloads öffnen</a></details>`;
	document.getElementById("app")!.append(dialog);
	const openButton = document.createElement("button");
	openButton.id = "onboarding-open";
	openButton.className = "nav-button";
	openButton.type = "button";
	openButton.append(createIcon("vault"), "Erste Schritte");
	document.getElementById("shortcut-help")!.before(openButton);
	let returnFocus: HTMLElement | null = null;
	const get = <T extends HTMLElement = HTMLElement>(id: string) =>
		document.getElementById(id) as T;
	function close(restore = true) {
		dialog.close();
		if (
			restore &&
			returnFocus?.isConnected &&
			returnFocus.getClientRects().length
		)
			returnFocus.focus();
		returnFocus = null;
	}
	function open() {
		if (ctx.busy() || document.querySelector("dialog[open]")) return;
		returnFocus = document.activeElement as HTMLElement;
		refresh();
		dialog.showModal();
		get("onboarding-close").focus();
	}
	function go(task: () => void) {
		close(false);
		task();
	}
	get("onboarding-close").addEventListener("click", () => close());
	dialog.addEventListener("cancel", (event) => {
		event.preventDefault();
		close();
	});
	openButton.addEventListener("click", open);
	get("onboarding-vault").addEventListener("click", () =>
		go(() => {
			if (ctx.vault()) get("search").focus();
			else get("master").focus();
		}),
	);
	get("onboarding-login").addEventListener("click", () => go(ctx.login));
	get("onboarding-import").addEventListener("click", () =>
		go(() => {
			ctx.settings();
			get<HTMLFormElement>("import-form").closest("details")!.open = true;
			get("import-file").focus();
		}),
	);
	get("onboarding-backup").addEventListener("click", () => go(ctx.backup));
	get("onboarding-access").addEventListener("click", () =>
		go(() => {
			ctx.settings();
			get("passkey-enroll")?.scrollIntoView({ block: "start" });
			get("passkey-enroll")?.focus();
		}),
	);
	get("onboarding-restore").addEventListener("click", () => {
		get<HTMLDetailsElement>("locked-recovery").open = true;
		get("locked-restore-file").focus();
	});
	function refresh() {
		intro.hidden = ctx.hasRecord() || !ctx.ready();
		const unlocked = !!ctx.vault();
		get("onboarding-vault-state").textContent = unlocked
			? "Dein Tresor ist entsperrt. Änderungen werden verschlüsselt gespeichert."
			: ctx.hasRecord()
				? "Dein Tresor ist vorhanden. Entsperre ihn mit deinem Masterpasswort oder eingerichteten Passkey."
				: "Wähle ein langes, einmaliges Masterpasswort. HeavenKey kann es nicht zurücksetzen.";
		for (const id of [
			"onboarding-login",
			"onboarding-import",
			"onboarding-backup",
			"onboarding-access",
		])
			get<HTMLButtonElement>(id).disabled = !unlocked || ctx.busy();
	}
	refresh();
	return { refresh, clear: () => close(false), open };
}
