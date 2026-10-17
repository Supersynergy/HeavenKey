/* SmartField extract.js — unstructured text -> entity map.
   Pure functions, no DOM, no network. Deterministic (fast + safe).
   Sensitivity tiers ported from dsgvo-shield taxonomy (60+ PII classes):
   tier 0 = public form data, tier 1 = personal (fill with care),
   tier 2 = high-risk (financial/identity — opt-in only, never guessed). */
"use strict";
(function (root) {

const ENTITY_ANCHORS = {
  email:      /e-?mail|mail|email/i,
  phone:      /tel(?:efon)?|phone|mobile|handy|fon|fax|mobil|durchwahl/i,
  firstName:  /first ?name|vorname|given ?name|rsname/i,
  lastName:   /last ?name|nach ?name|surname|family ?name|zuname|nsname/i,
  username:   /user ?name|login|benutzer|nick ?name|handle/i,
  password:   /passwort|password|kennwort|\bpwd\b|passwd|passphrase|zugangscode/i,
  geburtsname:/geburtsname|maiden ?name|\bgeb\.?\s/i,
  name:       /full ?name|\bname\b|kontakt|contact/i,
  salutation: /anrede|salutation|title|titel|geschlecht|gender|sex/i,
  title:      /akademischer? (grad|titel)|academic ?(title|degree)|abschluss/i,
  jobTitle:   /position|job ?title|beruf|rolle|role|funktion|abteilung|department/i,
  geburtsort: /geburtsort|place of birth|born in|geboren in/i,
  city:       /city|stadt|(?<![a-zäöüß])ort\b|town|wohnort|gemeinde/i,
  state:      /state|bundesland|province|region|canton|kanton/i,
  country:    /country|land|nation/i,
  nationality:/staatsangehörigkeit|staatsangehorigkeit|staatsbürgerschaft|nationality|nationalität|citizenship/i,
  familienstand:/familienstand|marital ?status|zivilstand/i,
  konfession: /konfession|religion|glaube|denomination|kirchenzugehörigkeit/i,
  street:     /street|stra(?:ss|ß)e|address ?line ?1|adresse|anschrift|addr|wohnhaft/i,
  houseNumber:/hausnummer|haus[-\s]?nr|house ?(number|no)|housenumber|\bhnr\b/i,
  streetName: /straßenname|strassenname|street ?name/i,
  postbox:    /postfach|p\.?\s?o\.?\s?box|postbox|packstation|poststation|postnummer/i,
  address2:   /address ?line ?2|adresszusatz|zusatz|apartment|wohnung|etage|floor|suite|apt|c\/o|bei\b/i,
  zip:        /zip|postcode|postal|plz|postleitzahl/i,
  company:    /company|firma|organization|organisation|unternehmen|arbeitgeber|employer|firm|\bkunde\b/i,
  url:        /url|website|homepage|web|domain|link|linkedin|github|xing/i,
  birthdate:  /birth|geburt|geboren|dob|date of birth|geburtstag/i,
  vat:        /ust|vat|umsatzsteuer|tax ?(id|nr|number)|mwst/i,
  accountHolder:/kontoinhaber|account ?holder|kontoinhaberin|\binhaber\b/i,
  bankName:   /bankname|name der bank|kreditinstitut|bankinstitut|bank ?name/i,
  blz:        /\bblz\b|bankleitzahl|sort ?code/i,
  mandatsref: /mandatsreferenz|mandate ?(reference|id)|mandats-?ref/i,
  creditorId: /gläubiger[-\s]?id|glaeubiger[-\s]?id|creditor ?(id|identifier)|ci[-\s]?nummer/i,
  iban:       /iban|kontonummer|\bkonto\b|account ?(number|no)|kontoverbindung|bankverbindung|bank\b/i,
  bic:        /\bbic\b|swift/i,
  creditcard: /credit ?card|kreditkarte|card ?number|kartennummer|cc ?num/i,
  ccHolder:   /karteninhaber|name on card|card ?holder|kartenhalter/i,
  ccExp:      /ablauf|expiry|expir|gültig(keit)?|valid ?(until|thru)|mm\s?\/\s?yy|kartengültig/i,
  cvc:        /\bcvv\b|\bcvc\b|\bcsc\b|sicherheitscode|security ?code|prüfziffer|kartenprüfnummer|card ?code/i,
  steuernr:   /steuernummer|steuer-?nr|tax ?number|steuerliche/i,
  steuerid:   /steuer[-\s]?id|identifikationsnummer|id ?nr|pers[oö]nliche ?identifikation|ust[-\s]?id/i,
  perso:      /personalausweis|ausweis|identity ?card|id ?card|passport|reisepass|pass ?nr/i,
  sozialvers: /sozialversicherung|rentenversicherung|versicherungsnummer|sv[-\s]?(?:nummer|nr)|social ?security|ssn/i,
  gkv:        /kvnr|krankenversicherung|versichertennummer|gkv|health ?insurance|patienten/i,
  ahv:        /\bahv\b|ahv[-\s]?nr|ahv-?nummer/i,
  hrb:        /handelsregister|hrb|hra|register/i,
  customerno: /kunden[-\s]?nummer|kunden-?nr|kdnr|kundennr|customer ?(number|no|id)/i,
  contractno: /vertrags[-\s]?(nummer|konto|nr)|vertragsnr|contract ?(number|no)|policen?[-\s]?(nummer|nr)|police ?number|versicherungsschein/i,
  memberno:   /mitglieds[-\s]?(nummer|nr)|mitgliedsnr|member(ship)? ?(number|no|id)/i,
  caseno:     /aktenzeichen|case ?(number|no)|vorgangs[-\s]?(nummer|nr)|referenznummer|ticket[-\s]?nr/i,
  currency:   /währung|waehrung|currency/i,
  language:   /\bsprache\b|language/i,
  amount:     /amount|betrag|summe|price|preis|total|summe|eur|euro/i,
  date:       /\bdate\b|datum|termin|deadline|frist/i,
  number:     /(?<![a-zäöüß])(?:nummer|number)\b|anzahl|count|qty|menge|quantity|\bno\.?\b|\bnr\b/i,
  purpose:    /verwendungszweck|purpose|reference ?text/i,
  subject:    /subject|betreff|titel|topic|thema|regarding|wegen/i,
  message:    /message|nachricht|comment|kommentar|notes?|merkung|bemerkung|description|beschreibung|reason|anliegen|request|text|body|inhalt/i
};

/* dsgvo-shield-derived tiers: 2 = high-risk, needs explicit opt-in and only
   fills into fields matched for that exact entity. */
const TIER = {
  high:     new Set(["iban", "bic", "creditcard", "cvc", "steuernr", "steuerid",
                     "perso", "sozialvers", "gkv", "ahv"]),
  personal: new Set(["birthdate", "vat", "hrb", "address2", "ccExp", "ccHolder",
                     "geburtsort", "geburtsname", "nationality", "familienstand",
                     "konfession"]),
  pub:      null /* everything else */
};
const tierOf = e => TIER.high.has(e) ? "high" : TIER.personal.has(e) ? "personal" : "public";

const RX = {
  email:   /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  url:     /(?:https?:\/\/)?(?:www\.)?[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?:\/[^\s]*)?/,
  phone:   /(?:\+\d{1,3}[\s./-]?)?(?:\(?\d{2,6}\)?[\s./-]?){1,3}\d{3,}[\s\d.-]*/,
  iban:    /\b[A-Z]{2}\d{2}(?:[ ]?[0-9A-Z]{4}){3,6}[ ]?[0-9A-Z]{0,4}\b/,
  ibanKey: /^[A-Z]{2}\d{2}/,
  bic:     /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/,
  cc:      /\b(?:\d[ -]?){13,19}\b/,
  steuernr:/\b\d{2,3}\/\d{3,4}\/\d{4,5}\b/,
  ust:     /\b(?:DE\s?\d{9}|AT\s?U\s?\d{8}|BE\s?0\d{9}|FR\s?[0-9A-Z]{2}\s?\d{9}|NL\s?\d{9}\s?B\s?\d{2}|IT\s?\d{11}|ES\s?[A-Z0-9]\d{7}[A-Z0-9]|CHE[-\s]?\d{3}\.?\d{3}\.?\d{3})\b/i,
  kvnr:    /\b[A-Z]\d{9}\b/,
  ahv:     /\b756\.\d{4}\.\d{4}\.\d{2}\b/,
  postbox: /\b(?:postfach|packstation|poststation|p\.?\s?o\.?\s?box)\s*(?:nr\.?|nummer|no\.?)?\s*[-–]?\s*\d{2,8}\b/i,
  ccexp:   /\b(0[1-9]|1[0-2])\s?[/\-.]\s?(\d{2}|\d{4})\b/,
  hrb:     /\bHR[AB]\s?[A-Z]?\s?\d{3,7}[A-Z]?\b/,
  perso:   /\b[LMNPRTVWXY][0-9CFGHJKLMNPRTVWXY]{8}\d\b/,
  sozialvers:/\b\d{8}[A-Z]\d{3}\b/,
  date:    /\b(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/,
  dateWord:/\b(\d{1,2})\.?\s+(Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember|January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  zipCity: /\b(?:[A-Z]{1,2}[-–])?(\d{4,6})\s+([A-ZÄÖÜ][\wäöüßé'-]{1,30})\b/,
  company: /\b[\wÄÖÜäöüß&.'-]+(?:\s[\wÄÖÜäöüß&.'-]+){0,4}\s+(?:GmbH(?:\s*&\s*Co\.\s*KG)?|AG|KG|OHG|UG|e\.\s?K\.?|e\.V\.|SE|KGaA|Inc\.?|LLC|Ltd\.?|Corp\.?|Co\.|S\.A\.|Ltda|BV|B\.V\.|GmbH|mbH)(?=$|[\s,;.)])/,
  street:  /\b[\wÄÖÜäöüß.'-]+(?:straße|str\.?|weg|allee|platz|gasse|ring|damm|chaussee|ufer|steig|pfad|graben|anger|markt|höhe|berg|feld|hof|wall|brücke|tor|avenue|ave\.?|street|st\.?|road|rd\.?|lane|ln\.?|drive|dr\.?|boulevard|blvd\.?|way|place|court|ct\.?)\s+\d{1,4}[a-zA-Z]?(?:\s*[-/]\s*\d{1,3})?\b/i,
  person:  /^[A-ZÄÖÜÉ][a-zäöüßé'-]+\s+[A-ZÄÖÜÉ][a-zäöüßé'-]+(?:\s+[A-ZÄÖÜÉ][a-zäöüßé'-]+)?$/,
  personTitle: /^(?:Prof\.\s*Dr\.?|Dr\.?|Prof\.?|Dipl\.?-Ing\.?|Mag\.?|B\.?\s?A\.?|M\.?\s?Sc\.?)\s+[A-ZÄÖÜÉ][a-zäöüßé'-]+\s+(?:(?:von|van|de|zu|vom|der)\s+)?[A-ZÄÖÜÉ][a-zäöüßé'-]+/,
  salutation:/\b(Herrn?|Frau|Mr\.?|Mrs\.?|Ms\.?|Mx\.?|Divers|Sehr geehrt[er]+)\b/i,
  amount:  /\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?\s*(?:€|EUR|Euro)\b|\b(?:€|EUR|Euro)\s?\d[\d.,]*/i,
  number:  /\b\d{1,9}\b/,
  inCity:  /(?:^|\s)(?:in|aus|from|wohnhaft in|living in)\s+([A-ZÄÖÜ][\wäöüßé'-]{2,25})\b/
};

const MONTHS = {januar:1,februar:2,"märz":3,april:4,mai:5,juni:6,juli:7,august:8,
  september:9,oktober:10,november:11,dezember:12,january:1,february:2,march:3,
  aprilen:4,may:5,june:6,july:7,augusten:8,septemberen:9,october:10,novemberen:11,december:12};

function normSpace(s) { return s.replace(/\s+/g, " ").trim(); }

function luhn(numStr) {
  const d = numStr.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0, alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = +d[i];
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

/* ISO 13616 mod-97 checksum — catches mistyped IBANs before they reach a field */
function ibanOk(s) {
  const d = String(s || "").replace(/\s/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[0-9A-Z]{11,30}$/.test(d)) return false;
  const r = d.slice(4) + d.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const n = /\d/.test(ch) ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 55;
    rem = n < 10 ? (rem * 10 + n) % 97 : (rem * 100 + n) % 97;
  }
  return rem === 1;
}

function deDateToISO(s) {
  const w = s.match(RX.dateWord);
  if (w) {
    const mo = MONTHS[w[2].toLowerCase()] || MONTHS[w[2].toLowerCase() + "en"];
    if (mo) return `${w[3]}-${String(mo).padStart(2, "0")}-${w[1].padStart(2, "0")}`;
  }
  const m = s.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/) ||
            s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/); /* DD-MM-YYYY */
  if (!m) {
    const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    return iso ? iso[0] : s;
  }
  let [, d, mo, y] = m;
  if (+d > 31 || +mo > 12) return s;
  if (y.length === 2) y = (+y > 30 ? "19" : "20") + y;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

/* entity-specific value validation for anchored lines */
const VALIDATE = {
  email:      v => RX.email.test(v),
  phone:      v => /\d{5,}/.test(v.replace(/\D/g, " ").replace(/\s/g, "")),
  zip:        v => /^\d{4,6}$/.test(v.trim()),
  bic:        v => RX.bic.test(v),
  creditcard: v => luhn(v),
  iban:       v => ibanOk(v),
  ust:        v => /^[A-Z]{2}|CHE/i.test(v.replace(/\s/g, "")),
  vat:        v => /^[A-Z]{2}|CHE/i.test(v.replace(/\s/g, "")),
  steuerid:   v => /^\d{11}$/.test(v.replace(/\D/g, "")),
  gkv:        v => RX.kvnr.test(v) || /^\d/.test(v),
  ahv:        v => RX.ahv.test(v),
  cvc:        v => /^\d{3,4}$/.test(v.trim()),
  ccExp:      v => RX.ccexp.test(v),
  houseNumber:v => /^[\d]{1,4}[a-zA-Z]?(?:[-/][\d]{1,4})?$/.test(v.trim()),
  number:     v => /^\d[\d\s.,]*$/.test(v),
  amount:     v => /\d/.test(v),
  name:       v => !/@/.test(v) && !/\d{5,}/.test(v.replace(/\D/g, "")),
};

/* pass 1: "Key: value" lines and anchor-word lines */
function anchoredLines(lines, out, used) {
  lines.forEach((line, i) => {
    /* separator order matters: ":" and "|" always split; "-" needs spaces
       around it so "Steuer-ID"/"USt-IdNr" labels survive; "–"/"—" work tight */
    const m = line.match(/^(.{1,50}?)\s*[:|]\s*(.{2,200})\s*$/) ||
              line.match(/^(.{1,50}?)\s+[–—-]\s+(.{2,200})\s*$/) ||
              line.match(/^(.{1,50}?)\s*[–—]\s*(.{2,200})\s*$/);
    if (!m) return;
    const key = m[1].trim(), val = normSpace(m[2]);
    for (const [entity, rx] of Object.entries(ENTITY_ANCHORS)) {
      if (!rx.test(key) || out[entity]) continue;
      /* don't let a label swallow a strong foreign value */
      if (RX.email.test(val) && entity !== "email") continue;
      if (RX.iban.test(val) && entity !== "iban") continue;
      if (VALIDATE[entity] && !VALIDATE[entity](val)) continue;
      out[entity] = /birthdate|date/.test(entity) ? deDateToISO(val) : val;
      if (entity === "name" && !out.firstName) {
        const parts = val.split(/\s+/).filter(p => /^[\p{L}.'-]+$/u.test(p));
        if (parts.length >= 2 && parts.length <= 4) {
          out.firstName = parts[0];
          out.lastName = parts[parts.length - 1];
        }
      }
      used.add(i);
      break;
    }
  });
}

/* pass 2: free-regex scan over remaining text */
function freeScan(lines, out, used) {
  lines.forEach((line, i) => {
    if (used.has(i)) return;
    let rest = line;

    const eat = (entity, rx, transform) => {
      const m = rest.match(rx);
      if (!m || out[entity]) return false;
      const v = transform ? transform(m[0]) : normSpace(m[0]);
      if (VALIDATE[entity] && !VALIDATE[entity](v)) return false;
      out[entity] = v;
      rest = rest.replace(m[0], " ");
      return true;
    };

    eat("email", RX.email);
    eat("iban", RX.iban);
    if (!out.creditcard) {
      const c = rest.match(RX.cc);
      if (c && luhn(c[0])) { out.creditcard = c[0].replace(/\s+/g, " ").trim(); rest = rest.replace(c[0], " "); }
    }
    eat("steuernr", RX.steuernr);
    if (!out.vat) { const u = rest.match(RX.ust); if (u) { out.vat = u[0].replace(/\s/g, ""); rest = rest.replace(u[0], " "); } }
    eat("hrb", RX.hrb);
    eat("perso", RX.perso);
    eat("sozialvers", RX.sozialvers);
    eat("gkv", RX.kvnr);
    eat("ahv", RX.ahv);
    eat("postbox", RX.postbox);
    const u = rest.match(RX.url);
    if (u && !out.url && /https?:|www\.|\.(de|com|net|org|io|ai|dev|eu|shop|info|biz)\b/i.test(u[0]) && !RX.email.test(u[0]) && !/^\d/.test(u[0]))
      { out.url = u[0].replace(/[.,;)]$/, "").replace(/\/$/, ""); rest = rest.replace(u[0], " "); }
    eat("company", RX.company);
    eat("street", RX.street);
    const zc = rest.match(RX.zipCity);
    if (zc && !out.zip) { out.zip = zc[1]; if (!out.city) out.city = zc[2]; rest = rest.replace(zc[0], " "); }
    if (!out.city) { const ic = rest.match(RX.inCity); if (ic) { out.city = ic[1]; rest = rest.replace(ic[0], " "); } }
    if (!out.birthdate) { const dw = rest.match(RX.dateWord); if (dw) { out.birthdate = deDateToISO(dw[0]); rest = rest.replace(dw[0], " "); } }
    eat("birthdate", RX.date, deDateToISO);
    eat("amount", RX.amount);
    eat("phone", RX.phone);
    if (!out.salutation) { const s = rest.match(RX.salutation); if (s) { out.salutation = /^herr/i.test(s[1]) ? "Herr" : /^frau/i.test(s[1]) ? "Frau" : s[1].replace(/\.$/, ""); rest = rest.replace(s[0], " "); } }

    const t = line.trim();
    const pt = t.match(RX.personTitle);
    if (pt && !out.name && !out.email) {
      out.name = pt[0];
      const tm = pt[0].match(/^(?:(?:Prof\.\s*Dr\.?|Prof\.?|Dr\.?|Dipl\.?-Ing\.?|Mag\.?|B\.?\s?A\.?|M\.?\s?Sc\.?)\s*)+/);
      if (tm && !out.title) out.title = normSpace(tm[0]);
      const clean = pt[0].replace(/^(?:Dr\.?|Prof\.?|Prof\.\s*Dr\.?|Dipl\.?-Ing\.?|Mag\.?|B\.?\s?A\.?|M\.?\s?Sc\.?)\s+/, "");
      const parts = clean.split(/\s+/);
      if (!out.firstName) out.firstName = parts[0];
      if (!out.lastName) out.lastName = parts[parts.length - 1];
      used.add(i);
      return;
    }
    if (RX.person.test(t) && !out.name && !out.email) {
      const parts = t.split(/\s+/);
      if (parts.length <= 4 && !ENTITY_ANCHORS.company.test(t)) {
        out.name = t;
        if (!out.firstName) out.firstName = parts[0];
        if (!out.lastName) out.lastName = parts[parts.length - 1];
        used.add(i);
        return;
      }
    }
    if (rest.replace(/\W/g, "").length > 40 && !out.message) out.message = normSpace(rest);
  });
}

function extract(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {}, used = new Set();
  anchoredLines(lines, out, used);
  freeScan(lines, out, used);

  /* split "Straße 12a" into name + house number for split-field forms;
     Packstation/Postfach counts as a street value for checkout street fields */
  if (out.street && !out.houseNumber) {
    const m = out.street.match(/^(.+?\S)\s+(\d{1,4}[a-zA-Z]?(?:\s*[-/]\s*\d{1,4})?)$/);
    if (m) {
      out.streetName = m[1];
      out.houseNumber = m[2].replace(/\s/g, "");
    }
  }
  if (out.postbox && !out.street) out.street = out.postbox;

  /* last resorts: leftover long text -> message */
  if (!out.message) {
    const leftover = lines.filter((_, i) => !used.has(i)).join("\n");
    if (leftover.length > 60) out.message = normSpace(leftover);
  }
  return out;
}

/* entities + per-entity sensitivity tier, for popup display + fill gating */
function extractDetailed(text) {
  const entities = extract(text);
  const tiers = {};
  for (const k of Object.keys(entities)) tiers[k] = tierOf(k);
  return { entities, tiers };
}

const api = { extract, extractDetailed, ENTITY_ANCHORS, RX, TIER, tierOf, luhn, ibanOk };
if (typeof module !== "undefined") module.exports = api; /* node test path */
root.SmartFieldExtract = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
