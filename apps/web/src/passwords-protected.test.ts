import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { initProtectedComposer } from "./passwords-protected";
import { derive, encode64, openVault, sealVault, validateVault } from "./passwords-crypto";
const clientId = "00000000-0000-4000-8000-000000000010";
const login = { id: "login", title: "Synthetic portal", username: "synthetic", password: "synthetic", url: "https://fixture.invalid/login", notes: "", totp: "", tags: [], favorite: false };
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
function setup() {
 const win = new Window({ url: "http://localhost/passwords" });
 Object.assign(globalThis, { window: win, document: win.document, MutationObserver: win.MutationObserver, HTMLElement: win.HTMLElement, HTMLButtonElement: win.HTMLButtonElement });
 win.document.body.innerHTML = '<section id="settings-view"></section>';
 let generation = 1, unlocked = true, records: any[] = [], saveGate: Promise<void> = Promise.resolve(), failPublish = false, nullDraft = false;
 const calls: any[] = [], events: string[] = [];
 const brokerClients = [{ id: clientId, label: "Synthetic agent", protected: true, expires_at: Math.floor(Date.now() / 1000) + 300 }, { id: "ordinary", label: "Legacy", protected: false, expires_at: Math.floor(Date.now() / 1000) + 300 }];
 const snapshot: any = { token: "synthetic", revision: 4, vault: { version: 1, entries: [login] }, discreet: false };
 const ctx: any = { get: () => ({ ...snapshot, generation }), current: (g: number) => g === generation, unlocked: () => unlocked, run: async (fn: any) => fn(generation), announce: (text: string) => events.push(text) };
 globalThis.fetch = async (url: any, init: any = {}) => {
  const path = String(url), body = init.body ? JSON.parse(init.body) : undefined; calls.push({ path, body, method: init.method });
  if (path.endsWith("/protected/workspaces") && body) { events.push("publish"); if (failPublish) return new Response("private upstream diagnostic", { status: 409 }); return Response.json({ workspace_id: body.workspace_id, status: "published" }); }
  if (path.endsWith("/protected/workspaces")) return Response.json({ workspaces: records.map(r => ({ workspace_id: r.id, client_id: clientId, expires_at: Math.floor(Date.now() / 1000) + 300, status: nullDraft ? "published" : "drafted", request_id: null, draft: nullDraft ? null : `Hallo [[HK:${r.references[0].id}]], Vorgang [[HK:${r.references[2].id}]].` })) });
  if (path.endsWith("/protected-pairing")) return Response.json({ code: "SYNTHETIC", expires_in: 120 });
  return Response.json({ epoch: 9, unlocked: true, enabled: true, clients: brokerClients });
 };
 const ui = initProtectedComposer(ctx, { get: () => records, save: async (next, g) => { events.push("save-start"); await saveGate; if (!ctx.current(g) || !unlocked) throw new Error("locked"); validateVault({ ...snapshot.vault, protected_workspaces: next }); records = next; snapshot.revision++; events.push("saved"); } });
 const click = (id: string) => win.document.querySelector<HTMLButtonElement>("#" + id)!.click();
 const fill = () => { click("protected-new"); for (const [kind, value] of Object.entries({ person: "Synthetic private owner", email: "private@example.invalid", case: "SYNTHETIC-42" })) win.document.querySelector<HTMLInputElement>("#protected-" + kind)!.value = value; win.document.querySelector<HTMLSelectElement>("#protected-client")!.value = clientId; win.document.querySelector<HTMLSelectElement>("#protected-source")!.value = "login"; };
 const submit = () => win.document.querySelector("#protected-form")!.dispatchEvent(new win.Event("submit", { cancelable: true }));
 return { win, ui, calls, events, snapshot, brokerClients, click, fill, submit, records: () => records, noDraft: () => { nullDraft = true; }, blockSave: (gate: Promise<void>) => { saveGate = gate; }, fail: () => { failPublish = true; }, lock: () => { generation++; unlocked = false; ui.clear(); } };
}
test("composer saves encrypted private model before publishing only pseudonyms, binds fresh revision and protected client", async () => {
 const s = setup(); await s.ui.refresh(); s.fill(); s.submit(); await tick();
 expect(s.events.indexOf("saved")).toBeLessThan(s.events.indexOf("publish"));
 const sent = s.calls.find(c => c.path.endsWith("/protected/workspaces") && c.body);
 expect(sent.body).toMatchObject({ revision: 5, epoch: 9, source_id: "login", origin: "https://fixture.invalid", template: "reply", client_id: clientId });
 expect(Object.keys(sent.body).sort()).toEqual(["client_id", "epoch", "origin", "references", "revision", "source_id", "template", "workspace_id"]);
 expect(JSON.stringify(sent.body)).not.toContain("Synthetic private owner"); expect(JSON.stringify(sent.body)).not.toContain("private@example.invalid");
 expect(s.win.document.querySelectorAll("#protected-client option").length).toBe(0);
 const previewButton = s.win.document.querySelector<HTMLButtonElement>("[data-protected-preview]")!; previewButton.click();
 expect(s.win.document.querySelector("#protected-preview")!.textContent).toContain("Synthetic private owner");
 expect(s.calls.some(c => JSON.stringify(c.body ?? {}).includes("Synthetic private owner"))).toBe(false);
 s.lock(); expect(s.win.document.querySelector("#protected-preview")!.textContent).toBe(""); expect(s.win.document.querySelector<HTMLInputElement>("#protected-person")!.value).toBe("");
});
test("lock during save discards continuation and pagehide clears private fields", async () => {
 const s = setup(); await s.ui.refresh(); let release!: () => void; s.blockSave(new Promise(resolve => { release = resolve; })); s.fill(); s.submit(); s.lock(); release(); await tick();
 expect(s.calls.some(c => c.path.endsWith("/protected/workspaces") && c.body)).toBe(false);
 expect(s.win.document.querySelector<HTMLDialogElement>("#protected-composer-dialog")!.open).toBe(false);
 const next = setup(); await next.ui.refresh(); next.fill(); next.win.dispatchEvent(new next.win.Event("pagehide"));
 expect(next.win.document.querySelector<HTMLInputElement>("#protected-email")!.value).toBe(""); next.ui.clear();
});
test("save then publish failure reports saved-only state and never backend error body", async () => {
 const s = setup(); await s.ui.refresh(); s.fail(); s.fill(); s.submit(); await tick();
 expect(s.records().length).toBe(1); expect(s.win.document.querySelector("#protected-status")!.textContent).toContain("Verschlüsselt gespeichert; Freigabe fehlgeschlagen");
 expect(s.win.document.body.textContent).not.toContain("private upstream diagnostic"); s.ui.clear();
});
test("private originals and optional pseudonym draft roundtrip only inside authenticated vault ciphertext", async () => {
 const s = setup(); await s.ui.refresh(); s.fill(); s.submit(); await tick();
 const record = s.records()[0], draft = `Hallo [[HK:${record.references[0].id}]].`;
 const privateVault = validateVault({ version: 1, entries: [login], protected_workspaces: [{ ...record, draft }] });
 const salt = crypto.getRandomValues(new Uint8Array(16)), master = "Synthetic protected master passphrase";
 const key = await derive(master, salt), sealed = await sealVault(privateVault, key, encode64(salt));
 for (const ref of record.references) expect(JSON.stringify(sealed)).not.toContain(ref.value);
 expect((await openVault(sealed, master)).vault.protected_workspaces).toEqual(privateVault.protected_workspaces);
 expect(() => validateVault({ ...privateVault, entries: [] })).toThrow(); s.ui.clear();
});
test("native optional null fields remain usable and discreet mode clears all private controls", async () => {
 const s = setup(); s.noDraft(); await s.ui.refresh(); s.fill(); s.submit(); await tick();
 expect(s.win.document.querySelector("#protected-records")!.textContent).toContain("published");
 expect(s.win.document.querySelector("[data-protected-preview]")).toBeNull();
 s.fill(); s.snapshot.discreet = true; await s.ui.refresh();
 expect(s.win.document.querySelector<HTMLInputElement>("#protected-person")!.value).toBe(""); expect(s.win.document.querySelector("#protected-records")!.childElementCount).toBe(0);
});
test("open composer synchronizes paired clients while retaining explicit valid selection, original fields and focus", async () => {
 const s = setup(); await s.ui.refresh(); s.fill();
 const select = s.win.document.querySelector<HTMLSelectElement>("#protected-client")!, originalOption = select.options[1], person = s.win.document.querySelector<HTMLInputElement>("#protected-person")!;
 const nextId = "00000000-0000-4000-8000-000000000011";
 select.focus(); s.brokerClients.push({ ...s.brokerClients[0], id: nextId, label: "New paired agent" }); await s.ui.refresh();
 expect(select.options.length).toBe(3); expect(select.value).toBe(clientId); expect(select.options[1]).toBe(originalOption); expect(s.win.document.activeElement).toBe(select);
 select.value = nextId; person.focus(); s.brokerClients[0].label = "Updated label"; await s.ui.refresh();
 expect(select.value).toBe(nextId); expect(s.win.document.activeElement).toBe(person); expect(person.value).toBe("Synthetic private owner"); expect(select.options[1].textContent).toBe("Updated label");
 s.brokerClients.splice(2, 1); await s.ui.refresh(); expect(select.value).toBe(""); expect(select.options.length).toBe(2);
 expect(s.win.document.querySelector<HTMLDialogElement>("#protected-composer-dialog")!.open).toBe(true);
 const trust = s.win.document.querySelector("#protected-trust")!.textContent!;
 for (const text of ["Zwischenablage", "Seitenlesen", "--broker-sandbox", "Hostzugriff", "externes Sicherheitsaudit"]) expect(trust).toContain(text);
 s.ui.clear();
});
