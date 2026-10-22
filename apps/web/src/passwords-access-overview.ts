export function initAccessOverview() {
  const settings = document.getElementById("settings-view")!;
  const overview = document.createElement("section"); overview.className = "settings-card access-overview"; overview.setAttribute("aria-label", "Zugänge und Schlüssel");
  const heading = document.createElement("h2"), note = document.createElement("p"), actions = document.createElement("div");
  heading.textContent = "Zugänge und Schlüssel"; note.className = "note"; note.textContent = "Passkeys öffnen deinen Tresor. SSH-Schlüssel melden dich bei SFTP an. Verbindungen und Agentenfreigaben verwaltest du getrennt."; actions.className = "actions";
  for (const [name, id] of [["Geschützter Composer", "protected-composer"], ["Passkeys", "passkey-settings"], ["SSH-Schlüssel", "ssh-storage"], ["Verbindungen", "transfer-settings"], ["Formularprofile", "form-profiles"]]) {
    const button = document.createElement("button"); button.type = "button"; button.className = "secondary"; button.textContent = name; button.id = "access-jump-" + id;
    button.onclick = () => { const target = document.getElementById(id); if (target) { target.tabIndex = -1; target.scrollIntoView({ block: "start", behavior: "instant" }); target.focus({ preventScroll: true }); } };
    actions.append(button);
  }
  overview.append(heading, note, actions); settings.querySelector(".settings-card")!.before(overview);
}
