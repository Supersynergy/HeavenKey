import qrcode from 'qrcode-generator';

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function form(action, label, csrf, extra = '') {
  return `<form method="post" action="${action}">
    <input type="hidden" name="csrf" value="${escape(csrf)}">${extra}
    <button>${escape(label)}</button>
  </form>`;
}
function openOnAndroid(link) {
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  return `<section><h2>Auf Android öffnen</h2>
    <div aria-hidden="true">${qr.createSvgTag(4, 16)}</div>
    <p><a href="${escape(link)}">An HeavenKey übergeben</a></p>
  </section>`;
}

export function browserPage({ result = {}, csrf, hasAccess = false, showProject = false }) {
  const { launch, request_id: requestId, receipt_id: receiptId, status, delegation } = result;
  const project = showProject
    ? '<section><h2>Testprojekt</h2><p>Aufbauplanung für das synthetische Projekt. Du kannst diesen Projektbereich lesen.</p></section>'
    : '';
  const id = requestId ?? receiptId;
  const requests = id ? `<section>
    <h2>Vorgang ${escape(id.slice(-6))}</h2>
    <p>${({ verified: 'Nachweis geprüft', expired: 'Anfrage abgelaufen' })[status] ?? 'Bestätigung ausstehend'}</p>
    <p><a href="/browser/status/${escape(id)}">Ergebnis prüfen</a></p>
  </section>` : '';
  const stateLabel = delegation && ({
    approved: 'Freigabe erteilt', executed: 'Entwurf erstellt', revoked: 'Freigabe widerrufen', expired: 'Freigabe abgelaufen',
  })[delegation.status];
  const action = stateLabel ? `<section><h2>Rechnungsentwurf</h2><p>${stateLabel}</p>${
    delegation.draft_id ? `<p>Entwurf ${escape(delegation.draft_id)}</p>` : ''
  }${csrf && delegation.status === 'approved' ? `<details><summary>Referenzen für den Agenten</summary>
    <p>Auftragskennung <code>${escape(delegation.delegation_id)}</code></p>
    <p>Idempotenzschlüssel <code>${escape(delegation.idempotency_key)}</code></p></details>
    ${form('/browser/revoke-delegation', 'Agentenfreigabe widerrufen', csrf,
      `<input type="hidden" name="delegation_id" value="${escape(delegation.delegation_id)}">`)}` : ''}</section>` : '';
  const projectLink = hasAccess ? '<p><a href="/project">Testprojekt öffnen</a></p>' : '';
  const controls = csrf ? `<section>
    <h2>Testvorgänge</h2>
    ${form('/browser/offer', 'Testnachweis ausstellen', csrf)}
    ${form('/browser/request/project', 'Projektzugang anfragen', csrf)}
    ${hasAccess ? form('/browser/request/invoice', 'Rechnungsentwurf freigeben', csrf) : ''}
    ${form('/browser/revoke-credential', 'Testnachweise widerrufen', csrf)}
    ${form('/browser/logout', 'Testsitzung beenden', csrf)}
  </section>` : '<p><a href="/">Zur Testanwendung</a></p>';
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Supersynergy Testprojekt</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif }
  main { margin: 2rem auto; max-width: 38rem; padding: 0 1.2rem }
  section { margin: 1.6rem 0; padding: 1rem; border: 1px solid #8887; border-radius: .75rem }
  h1,h2 { margin-top: 0 }
  button { border: 1px solid #8887; border-radius: .35rem; padding: .55rem .85rem; font: inherit }
  form + form { margin-top: .6rem }
  svg { max-width: 100%; height: auto; padding: .25rem; background: #fff }
</style></head>
<body><main><h1>Supersynergy Testprojekt</h1><p>Testdaten und befristete Freigaben.</p>
${project}${projectLink}${launch ? openOnAndroid(launch) : ''}${requests}${action}${controls}
</main></body></html>`;
}
