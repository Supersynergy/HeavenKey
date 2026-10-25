import { encode64, freshBytes, type Vault } from "./passwords-crypto";
import { mergeSnapshots, openLinkedSnapshot, sealSnapshot, type SyncCipher, type SyncLink, type SyncSnapshot } from "./passwords-sync-crypto";

type Context = { vault(): Vault | null; token(): string; current(run: number): boolean; run(fn: (run: number) => Promise<void>): Promise<void>; commit(vault: Vault, run: number): Promise<boolean>; announce(message: string, error?: boolean): void };
export function initMobileSync(ctx: Context) {
  const card = document.createElement("section"); card.className = "settings-card"; card.id = "mobile-sync-settings";
  card.innerHTML = '<h2>Handy synchronisieren</h2><p>Geräte werden ausdrücklich gekoppelt. Übertragen werden verschlüsselte Logins und Website-Passkeys. Synchronisiere am Desktop und auf dem Handy; gleichzeitige Änderungen bleiben als Konflikt erhalten.</p><p>„Gerät koppeln“ öffnet einen eigenen TLS-Port im lokalen Netz. Die Desktop-Oberfläche bleibt nur auf diesem Computer erreichbar.</p><label for="sync-host">Adresse dieses Computers im lokalen Netz</label><input id="sync-host" placeholder="192.168.1.10 oder mein-mac.local" maxlength="253" autocomplete="off"><label for="sync-label">Gerätename</label><input id="sync-label" value="Mein Handy" maxlength="80" autocomplete="off"><button type="button" id="sync-pair">Gerät koppeln</button><p id="sync-pair-note" role="status"></p><label for="sync-pair-code" hidden>Einmaliger Kopplungscode</label><textarea id="sync-pair-code" rows="4" readonly hidden autocomplete="off" spellcheck="false"></textarea><button type="button" id="sync-hide-code" hidden>Code ausblenden</button><ul id="sync-devices"></ul><h3>Website-Passkeys</h3><p>Auf dem Handy erstellte Passkeys werden im verschlüsselten Desktop-Tresor mitgeführt. Die Android-App verwendet sie nach Gerätefreigabe für die passende Website.</p><ul id="website-passkeys"></ul>';
  document.getElementById("settings-view")!.append(card);
  const find = <T extends HTMLElement>(id: string) => card.querySelector<T>("#" + id)!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  function clear() {
    clearTimeout(timer); controller?.abort(); controller = undefined;
    find<HTMLTextAreaElement>("sync-pair-code").value = "";
    find("sync-pair-code").hidden = true; find("sync-hide-code").hidden = true;
    card.querySelector<HTMLLabelElement>('label[for="sync-pair-code"]')!.hidden = true;
    find("sync-pair-note").textContent = "";
    find("sync-devices").replaceChildren(); find("website-passkeys").replaceChildren();
  }
  async function api<T>(path: string, body?: unknown, method = "POST"): Promise<T> {
    const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", signal: controller ? AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { "Content-Type": "application/json", "X-HeavenKey-Client": "password-manager", "X-HeavenKey-Token": ctx.token() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) {
      const failure = await response.json() as {error?: string};
      const messages: Record<string, string> = {
        sync_port_unavailable: "Der lokale Synchronisierungsport ist belegt. Beende den anderen Dienst oder starte HeavenKey mit einem anderen Port.",
        sync_revision_conflict: "Der Synchronisierungsstand wurde zwischenzeitlich geändert. Bitte erneut synchronisieren; lokale Daten bleiben erhalten.",
        sync_device_limit: "Acht Geräte sind bereits verbunden. Widerrufe zuerst eine alte Verbindung.",
        invalid_sync_pairing: "Bitte eine IPv4-Adresse oder einen DNS-Namen dieses Computers und einen Gerätenamen eingeben.",
      };
      throw new Error(messages[failure.error ?? ""] ?? "Geräteverbindung fehlgeschlagen oder widerrufen.");
    }
    return await response.json() as T;
  }
  const snapshot = (vault: Vault): SyncSnapshot => ({ version: 1, entries: vault.entries, passkeys: vault.website_passkeys ?? [] });
  async function sync(link: SyncLink, run: number) {
    const vault = ctx.vault(); if (!vault) return;
    const remote = await api<{revision: number; record: SyncCipher}>("/api/mobile-sync/snapshot", { id: link.id });
    const opened = await openLinkedSnapshot(link, remote);
    const merged = mergeSnapshots(link.baseline, snapshot(vault), opened);
    const nextRevision = remote.revision + 1, record = await sealSnapshot(merged, link.key, link.id, nextRevision);
    if (!ctx.current(run)) return;
    await api("/api/mobile-sync/snapshot", { id: link.id, expected_revision: remote.revision, record });
    if (!ctx.current(run)) return;
    if (await ctx.commit({ ...vault, entries: merged.entries, website_passkeys: merged.passkeys, mobile_sync: vault.mobile_sync!.map(row => row.id === link.id ? { ...row, baseline: merged, revision: nextRevision } : row) }, run)) {
      ctx.announce("Logins und Website-Passkeys synchronisiert."); await refresh();
    }
  }
  find("sync-pair").addEventListener("click", () => void ctx.run(async run => {
    const vault = ctx.vault(); if (!vault) return;
    clear(); controller = new AbortController();
    const key = encode64(freshBytes(32));
    const paired = await api<{id: string; code: string; endpoint: string; certificate_sha256: string}>("/api/mobile-sync/pairing", { host: find<HTMLInputElement>("sync-host").value.trim(), label: find<HTMLInputElement>("sync-label").value.trim() });
    const baseline = snapshot(vault), record = await sealSnapshot(baseline, key, paired.id, 1);
    if (!ctx.current(run)) return;
    await api("/api/mobile-sync/snapshot", { id: paired.id, expected_revision: 0, record });
    if (!ctx.current(run) || !await ctx.commit({ ...vault, mobile_sync: [...(vault.mobile_sync ?? []), { id: paired.id, key, baseline, revision: 1 }] }, run)) return;
    const code = "hks1_" + encode64(new TextEncoder().encode(JSON.stringify({ version: 1, ...paired, key })));
    find<HTMLTextAreaElement>("sync-pair-code").value = code;
    find("sync-pair-code").hidden = false; find("sync-hide-code").hidden = false;
    card.querySelector<HTMLLabelElement>('label[for="sync-pair-code"]')!.hidden = false;
    find("sync-pair-note").textContent = "Diesen Code in HeavenKey auf dem Handy einfügen. Er enthält den geheimen Schlüssel, gilt zwei Minuten und kann einmal verwendet werden.";
    timer = setTimeout(clear, 120_000); find("sync-pair-code").focus(); await refresh();
  }));
  find("sync-hide-code").addEventListener("click", clear);
  async function refresh() {
    const vault = ctx.vault(); if (!vault) { clear(); return; }
    const devices = find("sync-devices"); devices.replaceChildren();
    for (const link of vault.mobile_sync ?? []) {
      const row = document.createElement("li"), title = document.createElement("span"), button = document.createElement("button"), revoke = document.createElement("button");
      title.textContent = "Gerät " + link.id.slice(0, 8) + " "; button.textContent = "Synchronisieren"; button.type = revoke.type = "button";
      button.dataset.syncId = link.id;
      button.addEventListener("click", () => void ctx.run(run => sync(link, run)));
      revoke.textContent = "Verbindung widerrufen";
      revoke.addEventListener("click", () => void ctx.run(async run => {
        const latest = ctx.vault(); if (!latest) return;
        await api("/api/mobile-sync/devices/" + encodeURIComponent(link.id), undefined, "DELETE");
        if (ctx.current(run) && await ctx.commit({ ...latest, mobile_sync: latest.mobile_sync!.filter(row => row.id !== link.id) }, run)) { clear(); await refresh(); ctx.announce("Geräteverbindung widerrufen. Lokale Einträge bleiben erhalten."); }
      })); row.append(title, button, revoke); devices.append(row);
    }
    const passkeys = find("website-passkeys"); passkeys.replaceChildren();
    for (const key of vault.website_passkeys ?? []) {
      const row = document.createElement("li"), label = document.createElement("span"), remove = document.createElement("button");
      label.textContent = key.rpId + " – " + key.userName + " "; remove.type = "button"; remove.textContent = "Passkey löschen";
      remove.addEventListener("click", () => {
        if (!window.confirm("Diesen Website-Passkey aus dem Tresor löschen? Synchronisiere danach die verbundenen Geräte. Die Registrierung bei der Website bleibt bestehen.")) return;
        void ctx.run(async run => { const latest = ctx.vault(); if (latest && await ctx.commit({ ...latest, website_passkeys: latest.website_passkeys!.filter(row => row.id !== key.id) }, run)) await refresh(); });
      }); row.append(label, remove); passkeys.append(row);
    }
    if (!passkeys.childElementCount) { const empty = document.createElement("li"); empty.textContent = "Noch keine synchronisierten Website-Passkeys."; passkeys.append(empty); }
  }
  return { clear, refresh };
}
