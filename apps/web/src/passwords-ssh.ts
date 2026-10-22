import type { AccessContext } from "./passwords-access";
import type { TransferProfile } from "../../../packages/transfers/schema";
import { checkedSSHIdentity, removeSSHIdentity, sshFingerprint, validateSSHIdentities, type SSHIdentity } from "../../../packages/transfers/ssh";

export type SSHStorage = {
  getKeys: () => SSHIdentity[];
  getProfiles: () => TransferProfile[];
  save: (keys: SSHIdentity[], profiles: TransferProfile[], generation: number) => Promise<void>;
};
export function initSSHStorage(ctx: AccessContext, storage: SSHStorage, generate: (guard: () => void) => Promise<{ private_key: string; public_key: string }>) {
  const card = document.createElement("section"); card.className = "settings-card"; card.id = "ssh-storage"; card.tabIndex = -1;
  card.innerHTML = '<h2>SSH-Schlüssel</h2><p class="note">Ein Schlüssel kann mehrere SFTP-Verbindungen verwenden. Private Schlüssel bleiben im verschlüsselten Tresor und dessen Sicherungen. Nur den öffentlichen Schlüssel beim Anbieter hinterlegen.</p><div class="actions"><button type="button" id="ssh-new">Schlüssel erzeugen</button><button type="button" class="secondary" id="ssh-import">Schlüssel importieren</button><button type="button" class="secondary" id="ssh-adopt">Vorhandene Verbindungsschlüssel übernehmen</button></div><p role="status" id="ssh-status"></p><ul id="ssh-identities"></ul>';
  document.getElementById("settings-view")!.append(card);
  const dialog = document.createElement("dialog"); dialog.id = "ssh-dialog"; dialog.setAttribute("aria-labelledby", "ssh-heading");
  dialog.innerHTML = '<h2 id="ssh-heading">SSH-Schlüssel speichern</h2><form><label for="ssh-label">Name</label><input id="ssh-label" maxlength="100" required autocomplete="off"><div id="ssh-import-fields"><p class="note">Ed25519: privaten PKCS8-Schlüssel (.pem) und passenden öffentlichen OpenSSH-Schlüssel (.pub) auswählen. Passwortgeschützte Schlüssel und private OpenSSH-Dateien werden nicht importiert. Die Zuordnung wird vor dem Speichern kryptografisch geprüft.</p><label for="ssh-private-file">Privater Schlüssel · PKCS8</label><input id="ssh-private-file" type="file" accept=".pem,.key"><label for="ssh-public-file">Öffentlicher Schlüssel · OpenSSH</label><input id="ssh-public-file" type="file" accept=".pub,.txt"></div><p role="status" id="ssh-dialog-status"></p><div class="actions"><button type="submit" id="ssh-save">Verschlüsselt speichern</button><button type="button" class="secondary" data-cancel>Abbrechen</button></div></form>';
  document.body.append(dialog);
  const deleteDialog = document.createElement("dialog"); deleteDialog.id = "ssh-delete-dialog"; deleteDialog.setAttribute("aria-labelledby", "ssh-delete-heading");
  deleteDialog.innerHTML = '<h2 id="ssh-delete-heading">SSH-Schlüssel entfernen?</h2><p id="ssh-delete-description"></p><p class="note">Ohne verschlüsselte Sicherung ist der private Schlüssel danach nicht wiederherstellbar. Beim Anbieter hinterlegte öffentliche Schlüssel werden dadurch nicht widerrufen.</p><div class="actions"><button type="button" id="ssh-delete-confirm">Aus dem Tresor entfernen</button><button type="button" class="secondary" data-cancel>Abbrechen</button></div>';
  document.body.append(deleteDialog);
  let deleteTarget: string | null = null;
  function closeDelete() { deleteTarget = null; if (deleteDialog.open) deleteDialog.close(); }
  deleteDialog.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => { closeDelete(); card.focus(); };
  deleteDialog.addEventListener("cancel", event => { event.preventDefault(); if (!busy) { closeDelete(); card.focus(); } });
  deleteDialog.querySelector<HTMLButtonElement>("#ssh-delete-confirm")!.onclick = () => {
    if (!deleteTarget || !usable() || busy) return;
    const id = deleteTarget;
    void ctx.run(async generation => {
      const operation = epoch; guard(generation, operation);
      const keys = removeSSHIdentity(id, storage.getKeys(), storage.getProfiles());
      await storage.save(keys, storage.getProfiles(), generation);
      if (ctx.current(generation)) { closeDelete(); refresh(); ctx.announce("SSH-Schlüssel aus dem Tresor entfernt. Ein Server-Schlüssel muss beim Anbieter getrennt entfernt werden."); }
    });
  };
  const list = card.querySelector("ul")!, status = card.querySelector<HTMLElement>("#ssh-status")!, form = dialog.querySelector("form")!;
  const label = dialog.querySelector<HTMLInputElement>("#ssh-label")!, privateFile = dialog.querySelector<HTMLInputElement>("#ssh-private-file")!, publicFile = dialog.querySelector<HTMLInputElement>("#ssh-public-file")!, fields = dialog.querySelector<HTMLElement>("#ssh-import-fields")!, message = dialog.querySelector<HTMLElement>("#ssh-dialog-status")!;
  let epoch = 0, busy = false, importing = false, returnFocus: HTMLElement | null = null;
  const usable = () => ctx.unlocked() && !ctx.get().discreet && !!ctx.get().vault;
  function guard(generation: number, operation: number) { if (!ctx.current(generation) || operation !== epoch || !usable()) throw new DOMException("Abgebrochen", "AbortError"); }
  function close() { epoch++; form.reset(); message.textContent = ""; if (dialog.open) dialog.close(); returnFocus?.focus(); returnFocus = null; }
  function setBusy(value: boolean) {
    busy = value;
    for (const button of card.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy || !usable() || button.dataset.inUse === "true";
    for (const input of dialog.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button")) input.disabled = busy && !input.hasAttribute("data-cancel");
    for (const button of deleteDialog.querySelectorAll<HTMLButtonElement>("button")) button.disabled = busy || !usable();
    card.querySelector<HTMLButtonElement>("#ssh-adopt")!.hidden = !storage.getProfiles().some(p => p.private_key && !p.ssh_key_id);
  }
  function download(key: SSHIdentity) {
    if (!usable() || busy) return;
    const url = URL.createObjectURL(new Blob([key.public_key + "\n"], { type: "text/plain" })), link = document.createElement("a");
    link.href = url; link.download = "heavenkey-" + key.id + ".pub"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function refresh() {
    list.replaceChildren(); if (!usable()) { setBusy(busy); return; }
    for (const key of validateSSHIdentities(storage.getKeys())) {
      const item = document.createElement("li"), text = document.createElement("p"), fingerprint = document.createElement("code"), actions = document.createElement("div"), exportButton = document.createElement("button"), remove = document.createElement("button");
      const used = storage.getProfiles().filter(profile => profile.ssh_key_id === key.id).length;
      item.dataset.sshId = key.id; text.textContent = key.label + " · Ed25519 · " + used + (used === 1 ? " Verbindung" : " Verbindungen"); fingerprint.textContent = sshFingerprint(key.public_key); actions.className = "actions";
      exportButton.type = remove.type = "button"; exportButton.className = remove.className = "secondary"; exportButton.textContent = "Öffentlichen Schlüssel herunterladen"; remove.textContent = "Entfernen"; remove.dataset.inUse = String(used > 0);
      exportButton.onclick = () => download(key);
      remove.onclick = () => {
        if (!usable() || busy) return;
        removeSSHIdentity(key.id, storage.getKeys(), storage.getProfiles());
        deleteTarget = key.id; deleteDialog.querySelector("#ssh-delete-description")!.textContent = key.label + " · " + sshFingerprint(key.public_key); deleteDialog.showModal(); deleteDialog.querySelector<HTMLButtonElement>("[data-cancel]")!.focus();
      };
      actions.append(exportButton, remove); item.append(text, fingerprint, actions); list.append(item);
    }
    if (!list.childElementCount) { const empty = document.createElement("li"); empty.textContent = "Noch keine SSH-Schlüssel gespeichert."; list.append(empty); }
    setBusy(busy);
  }
  function open(importKey: boolean) {
    if (!usable() || busy) return;
    close(); importing = importKey; fields.hidden = !importKey; privateFile.required = publicFile.required = importKey;
    returnFocus = document.activeElement as HTMLElement; dialog.showModal(); label.focus();
  }
  card.querySelector<HTMLButtonElement>("#ssh-new")!.onclick = () => open(false);
  card.querySelector<HTMLButtonElement>("#ssh-import")!.onclick = () => open(true);
  dialog.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = close;
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  form.onsubmit = event => {
    event.preventDefault(); if (!usable() || busy) return;
    const operation = epoch, name = label.value, privateInput = privateFile.files?.[0], publicInput = publicFile.files?.[0], importKey = importing;
    if (importKey && (!privateInput || !publicInput || privateInput.size > 16384 || publicInput.size > 1024)) { message.textContent = "Privaten PKCS8-Schlüssel (höchstens 16 KiB) und öffentlichen Schlüssel auswählen."; return; }
    void ctx.run(async generation => {
      const check = () => { guard(generation, operation); if (!dialog.open) throw new DOMException("Abgebrochen", "AbortError"); };
      try {
        check();
        const pair = importKey ? { private_key: await privateInput!.text(), public_key: await publicInput!.text() } : await generate(check);
        check(); const identity = await checkedSSHIdentity(name, pair.private_key, pair.public_key, check); check();
        const keys = validateSSHIdentities([...storage.getKeys(), identity]);
        await storage.save(keys, storage.getProfiles(), generation);
        if (ctx.current(generation)) { close(); refresh(); ctx.announce("SSH-Schlüssel verschlüsselt gespeichert. Den öffentlichen Schlüssel kannst du herunterladen."); }
      } catch (error) { if (ctx.current(generation) && operation === epoch && (error as Error).name !== "AbortError") message.textContent = (error as Error).message; }
    });
  };
  card.querySelector<HTMLButtonElement>("#ssh-adopt")!.onclick = () => {
    if (!usable() || busy) return;
    void ctx.run(async generation => {
      const operation = epoch, keys = [...storage.getKeys()], profiles = storage.getProfiles().map(p => ({ ...p }));
      try {
        for (const profile of profiles) if (profile.protocol === "sftp" && profile.private_key && !profile.ssh_key_id) {
          const check = () => guard(generation, operation); check();
          let key = keys.find(key => sshFingerprint(key.public_key) === sshFingerprint(profile.public_key));
          if (!key) { key = await checkedSSHIdentity(profile.label, profile.private_key, profile.public_key, check); keys.push(key); }
          profile.ssh_key_id = key.id; profile.private_key = ""; profile.public_key = "";
        }
        guard(generation, operation); await storage.save(validateSSHIdentities(keys), profiles, generation);
        if (ctx.current(generation)) { refresh(); ctx.announce("Verbindungsschlüssel ohne Duplikate in den Schlüsselspeicher übernommen."); }
      } catch (error) { if (ctx.current(generation) && operation === epoch && (error as Error).name !== "AbortError") status.textContent = (error as Error).message; }
    });
  };
  const settings = document.getElementById("settings-view")!;
  new MutationObserver(() => { if (settings.hidden) { close(); if (!busy) closeDelete(); } }).observe(settings, { attributes: true, attributeFilter: ["hidden"] });
  function clear() { close(); closeDelete(); list.replaceChildren(); status.textContent = ""; }
  setBusy(false); return { refresh, clear, setBusy };
}
