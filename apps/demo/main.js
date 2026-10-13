(() => {
  "use strict";
  const KEY = "heaven-browserdemo:v1";
  const names = { anna: "Anna", ben: "Ben" };
  const kinds = ["shared", "opened", "denied", "revoked", "expired"];
  const empty = () => ({ version: 1, grant: null, openedFor: null, events: [] });
  const el = id => document.getElementById(id);
  let storageAvailable = Boolean(navigator.locks);
  let loadNotice = "";
  let viewer = "anna";
  let busy = false;

  function validate(value) {
    if (!value || value.version !== 1 || !Array.isArray(value.events) || value.events.length > 12) throw new Error("invalid demo state");
    if (value.openedFor !== null && !Object.hasOwn(names, value.openedFor)) throw new Error("invalid viewer");
    const g = value.grant;
    if (g !== null && (!g || !Object.hasOwn(names, g.recipient) || typeof g.revoked !== "boolean" || !Number.isSafeInteger(g.issuedAt) || !Number.isSafeInteger(g.expiresAt) || g.issuedAt < 0 || g.expiresAt <= g.issuedAt || g.expiresAt - g.issuedAt > 3600000 || g.issuedAt > Date.now() + 5000)) throw new Error("invalid grant");
    if (!value.events.every(e => e && kinds.includes(e.kind) && Object.hasOwn(names, e.recipient) && Number.isSafeInteger(e.at) && e.at >= 0 && e.at <= Date.now() + 5000)) throw new Error("invalid history");
    return { version: 1, grant: g === null ? null : { recipient: g.recipient, revoked: g.revoked, issuedAt: g.issuedAt, expiresAt: g.expiresAt }, openedFor: value.openedFor, events: value.events.map(e => ({ kind: e.kind, recipient: e.recipient, at: e.at })) };
  }

  function load() {
    if (!storageAvailable) return empty();
    let raw;
    try { raw = localStorage.getItem(KEY); }
    catch { storageAvailable = false; return empty(); }
    if (raw === null) return empty();
    try { return validate(JSON.parse(raw)); }
    catch { loadNotice = "Der gespeicherte Demostand war ungültig. Es ist kein Zugang freigegeben."; return empty(); }
  }
  let state = load();
  if (state.grant) {
    viewer = state.grant.recipient;
    el("viewer").value = viewer;
    el("recipient").value = viewer;
    el("duration").value = String((state.grant.expiresAt - state.grant.issuedAt) / 1000);
  }
  function save() {
    if (!storageAvailable) return;
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch { storageAvailable = false; }
  }
  async function change(action) {
    if (busy) return;
    busy = true;
    let focus = document.activeElement.id;
    render();
    announce("Der Demostand wird aktualisiert.");
    const apply = () => { focus = action() || focus; };
    try {
      if (!storageAvailable) apply();
      else await navigator.locks.request(KEY, { signal: AbortSignal.timeout(3000) }, () => {
          state = load();
          apply();
        });
    } catch (error) {
      if (error.name === "SecurityError") {
        storageAvailable = false;
        state = empty();
        apply();
      } else if (error.name === "TimeoutError" || error.name === "AbortError") {
        state = load(); render();
        announce("Ein anderer Tab hält den Demostand noch fest. Versuche die Aktion erneut.", "×");
      } else {
        announce("Die Aktion konnte nicht abgeschlossen werden. Beginne die Demo erneut.", "×");
        throw error;
      }
    } finally {
      busy = false;
      render();
      if (focus && el(focus) && !el(focus).hidden) el(focus).focus();
    }
  }
  function access() {
    if (!state.grant) return "none";
    if (state.grant.revoked) return "revoked";
    if (Date.now() >= state.grant.expiresAt) return "expired";
    return "active";
  }
  function canRead() { return access() === "active" && state.grant.recipient === viewer; }
  function event(kind, recipient) {
    state.events.push({ kind, recipient, at: Date.now() });
    state.events = state.events.slice(-12);
  }
  function announce(message, symbol = "↗") {
    el("announcement").textContent = message;
    el("result-icon").textContent = symbol;
  }
  function describe(e) {
    const name = names[e.recipient];
    return { shared: `Du hast das Dokument mit ${name} geteilt.`, opened: `${name} hat das Dokument geöffnet.`, denied: `Der Zugriff für ${name} wurde abgewiesen.`, revoked: `Du hast den Zugang für ${name} widerrufen.`, expired: `Der Zugang für ${name} ist abgelaufen.` }[e.kind];
  }
  function render() {
    const status = access();
    const g = state.grant;
    const readable = canRead();
    const opened = readable && state.openedFor === viewer;
    if (status === "active") {
      el("recipient").value = g.recipient;
      el("duration").value = String((g.expiresAt - g.issuedAt) / 1000);
    }
    document.documentElement.dataset.busy = String(busy);
    el("workspace").setAttribute("aria-busy", String(busy));
    el("recipient").disabled = busy || status === "active";
    el("duration").disabled = busy || status === "active";
    el("share").disabled = busy || status === "active";
    el("revoke").disabled = busy || status !== "active";
    el("open-document").disabled = busy;
    el("viewer").disabled = busy;
    el("reset-confirm").disabled = busy;
    el("reset").disabled = busy;
    el("grant-indicator").dataset.state = status;
    el("grant-status").textContent = { none: "Noch kein Zugang", active: "Zugang ist aktiv", revoked: "Zugang widerrufen", expired: "Zugang abgelaufen" }[status];
    el("grant-detail").textContent = !g ? "Teile das Dokument, um den Ablauf zu starten." : status === "active" ? `${names[g.recipient]} darf die Projektübersicht lesen.` : status === "revoked" ? `${names[g.recipient]} kann das Dokument nicht mehr öffnen.` : `Die Freigabe für ${names[g.recipient]} ist zu Ende.`;
    el("remaining").hidden = status !== "active";
    if (status === "active") {
      const seconds = Math.max(0, Math.ceil((g.expiresAt - Date.now()) / 1000));
      el("remaining").textContent = `Noch ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} Minuten`;
    }
    el("guest-heading").textContent = `Was ${names[viewer]} sehen kann`;
    el("document").hidden = !opened;
    el("locked-view").hidden = opened;
    el("document-status").textContent = opened ? "Geöffnet" : readable ? "Freigegeben" : status === "revoked" && g.recipient === viewer ? "Gesperrt" : "Geschlossen";
    el("document-status").dataset.state = opened ? "open" : "closed";
    el("lock-symbol").dataset.state = status;
    const correctGuest = g && g.recipient === viewer;
    el("locked-title").textContent = readable ? "Der Zugang ist bereit." : correctGuest && status === "revoked" ? "Dieser Zugang ist entzogen." : correctGuest && status === "expired" ? "Dieser Zugang ist abgelaufen." : "Noch nicht freigegeben.";
    el("locked-help").textContent = readable ? `${names[viewer]} darf dieses Dokument jetzt lesen. Öffne es mit dem Button.` : correctGuest && status === "revoked" ? `Du hast den Zugang widerrufen. Auch ein erneuter Versuch lässt ${names[viewer]} nicht hinein.` : correctGuest && status === "expired" ? "Die vereinbarte Zeit ist vorbei. Nur eine neue Freigabe gibt wieder Zugang." : `Teile das Dokument links mit ${names[viewer]}. Danach kann der Gast es hier öffnen.`;
    el("storage-note").textContent = storageAvailable ? "Dein Demostand bleibt in diesem Browser erhalten." : "Dein Browser erlaubt hier kein Speichern. Die Demo funktioniert für diesen Tab.";
    const shared = Boolean(g);
    const everOpened = state.events.some(e => e.kind === "opened" && g && e.recipient === g.recipient && e.at >= g.issuedAt);
    const finished = status === "revoked";
    for (const [id, done, current] of [["step-share", shared, !shared], ["step-open", everOpened, status === "active" && !everOpened], ["step-revoke", finished, status === "active" && everOpened]]) {
      el(id).classList.toggle("done", done);
      el(id).querySelector(".step-mark").textContent = done ? "✓" : "";
      if (current) el(id).setAttribute("aria-current", "step"); else el(id).removeAttribute("aria-current");
    }
    const rows = state.events.slice().reverse().map(e => {
      const row = document.createElement("li");
      const time = document.createElement("time");
      time.dateTime = new Date(e.at).toISOString();
      time.textContent = new Date(e.at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
      row.append(time, document.createTextNode(describe(e)));
      return row;
    });
    if (!rows.length) { const row = document.createElement("li"); row.textContent = "Noch keine Aktion."; rows.push(row); }
    el("events").replaceChildren(...rows);
  }
  el("share-form").addEventListener("submit", e => {
    e.preventDefault();
    change(() => {
      if (access() === "active") return;
      const recipient = el("recipient").value;
      const duration = Number(el("duration").value);
      if (!Object.hasOwn(names, recipient) || ![60, 300, 1800].includes(duration)) { announce("Wähle einen Empfänger und eine gültige Laufzeit."); return; }
      const now = Date.now();
      state.grant = { recipient, issuedAt: now, expiresAt: now + duration * 1000, revoked: false };
      state.openedFor = null;
      viewer = recipient;
      el("viewer").value = viewer;
      el("open-feedback").textContent = "";
      event("shared", recipient); save(); render();
      announce(`Der Zugang für ${names[recipient]} ist aktiv. Öffne das Dokument in der Gastansicht.`);
      return "open-document";
    });
  });
  el("open-document").addEventListener("click", () => change(() => {
    if (!canRead()) {
      state.openedFor = null;
      event("denied", viewer); save(); render();
      el("open-feedback").textContent = `Kein Zugriff: Für ${names[viewer]} gibt es keinen gültigen Zugang.`;
      announce(`Der Zugriff für ${names[viewer]} wurde abgewiesen.`, "×");
      return "open-document";
    }
    state.openedFor = viewer;
    event("opened", viewer); save(); render();
    announce(`${names[viewer]} kann das Dokument lesen. Widerrufe jetzt links den Zugang.`, "✓");
    return "document-title";
  }));
  el("revoke").addEventListener("click", () => change(() => {
    if (access() !== "active") return;
    state.grant.revoked = true;
    state.openedFor = null;
    event("revoked", state.grant.recipient); save(); render();
    el("open-feedback").textContent = "";
    announce(`Du hast den Zugang für ${names[state.grant.recipient]} entzogen. Das Dokument ist sofort gesperrt.`, "✓");
    return "open-document";
  }));
  el("viewer").addEventListener("change", () => {
    viewer = el("viewer").value;
    el("open-feedback").textContent = "";
    render();
    announce(`Die Gastansicht zeigt jetzt ${names[viewer]}.`);
  });
  el("reset").addEventListener("click", () => el("reset-dialog").showModal());
  el("reset-cancel").addEventListener("click", () => el("reset-dialog").close());
  el("reset-confirm").addEventListener("click", () => change(() => {
    state = empty(); viewer = "anna";
    el("recipient").value = "anna"; el("viewer").value = "anna"; el("duration").value = "1800";
    el("open-feedback").textContent = "";
    save(); render(); el("reset-dialog").close();
    announce("Alles ist zurückgesetzt. Beginne mit „Zugang teilen“.");
    return "share";
  }));
  window.addEventListener("storage", e => {
    if (e.key !== KEY && e.key !== null) return;
    state = load(); render();
    announce(loadNotice || "Der Demostand wurde in einem anderen Tab geändert.");
  });
  let lastAccess = access();
  function tick() {
    const status = access();
    if (lastAccess === "active" && status === "expired") {
      change(() => {
        if (access() !== "expired") return;
        state.openedFor = null; event("expired", state.grant.recipient); save(); render();
        announce(`Die Freigabe für ${names[state.grant.recipient]} ist abgelaufen. Das Dokument ist gesperrt.`, "×");
      });
    }
    lastAccess = status;
    render();
  }
  window.setInterval(tick, 1000);
  document.addEventListener("visibilitychange", tick);
  render();
  if (loadNotice) announce(loadNotice, "×");
  else if (state.grant) announce(access() === "active" ? "Deine Freigabe ist noch aktiv. Du kannst den Ablauf fortsetzen." : "Die frühere Freigabe ist gesperrt. Eine neue Freigabe startet den Ablauf erneut.");
  document.documentElement.dataset.ready = "true";
})();
