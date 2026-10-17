/* SmartField fill.js — field scan, label, score, safe fill, undo.
   Donor pattern (browser-use/chromium autofill): honor `autocomplete`
   attr first, then name/id/label/placeholder/aria; set value via the
   native setter and fire real events so React/Vue/Angular notice.
   dsgvo-shield-derived gating: high-tier entities (financial/identity)
   fill only with opts.sensitive and only into their exact field type. */
"use strict";
(function (root) {

const EX = root.SmartFieldExtract || {};
const { ENTITY_ANCHORS = {}, RX = {} } = EX;
const tierOf = EX.tierOf || (() => "public");

/* autocomplete attr token -> entity (WHATWG autofill spec) */
const AC_MAP = {
  name: "name", "given-name": "firstName", "additional-name": "firstName",
  "family-name": "lastName", "honorific-prefix": "salutation",
  "honorific-suffix": "jobTitle", nickname: "username", username: "username",
  organization: "company", "organization-title": "jobTitle",
  "street-address": "street", "address-line1": "street",
  "address-line2": "address2", "address-line3": "address2",
  "address-level1": "state", "address-level2": "city",
  "address-level3": "address2", "address-level4": "address2",
  "postal-code": "zip", country: "country", "country-name": "country",
  email: "email", impp: "email", tel: "phone", "tel-national": "phone",
  "tel-local": "phone", "tel-area-code": "phone", "tel-country-code": "phone",
  "tel-extension": "phone", url: "url", photo: "url",
  bday: "birthdate", "bday-day": "bday_day", "bday-month": "bday_month",
  "bday-year": "bday_year", sex: "salutation",
  "cc-number": "creditcard", "cc-name": "ccHolder", "cc-exp": "cc_exp",
  "cc-exp-month": "cc_month", "cc-exp-year": "cc_year", "cc-csc": "cc_csc",
  "cc-type": "cc_type", "transaction-amount": "amount",
  "transaction-currency": "currency", language: "language",
  "new-password": "password", "current-password": "password",
  "one-time-code": "otp", "off": "__off", "on": "__ignore"
};

const SKIP_TYPES = new Set(["hidden", "submit", "button", "image", "file", "reset", "color"]);
const SENSITIVE_AC = new Set(["cc-number", "cc-csc", "cc-exp", "cc-name", "cc-type",
  "cc-exp-month", "cc-exp-year", "new-password", "current-password", "one-time-code"]);

/* country alias table for select/option matching (de+en) */
const COUNTRIES = {
  deutschland: ["germany", "deutschland", "de"], germany: ["germany", "deutschland", "de"],
  "österreich": ["austria", "österreich", "osterreich", "at"], austria: ["austria", "österreich", "osterreich", "at"],
  schweiz: ["switzerland", "schweiz", "swiss", "ch"], switzerland: ["switzerland", "schweiz", "ch"],
  frankreich: ["france", "frankreich", "fr"], france: ["france", "frankreich", "fr"],
  italien: ["italy", "italien", "it"], italy: ["italy", "italien", "it"],
  spanien: ["spain", "spanien", "es"], spain: ["spain", "spanien", "es"],
  niederlande: ["netherlands", "niederlande", "holland", "nl"], netherlands: ["netherlands", "niederlande", "holland", "nl"],
  belgien: ["belgium", "belgien", "be"], belgium: ["belgium", "belgien", "be"],
  polen: ["poland", "polen", "pl"], poland: ["poland", "polen", "pl"],
  "vereinigtes königreich": ["united kingdom", "uk", "great britain", "gb", "großbritannien", "england"],
  usa: ["united states", "usa", "us", "america", "vereinigte staaten"],
};

const SALUTATIONS = {
  frau: ["frau", "mrs", "ms", "miss", "female", "weiblich", "w"],
  herr: ["herr", "mr", "male", "männlich", "maennlich", "m"],
  mr: ["herr", "mr", "male"], mrs: ["frau", "mrs", "female"], ms: ["frau", "ms", "female"],
  divers: ["divers", "diverse", "other", "mx", "d"],
};

const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const squash = s => norm(s).replace(/[^\p{L}\p{N}]+/gu, "");

function visible(el) {
  if (el.type === "hidden" || el.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  if (el.closest && el.closest("[aria-hidden='true'],[hidden],[inert]")) return false;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
  /* honeypot: off-screen or zero-size decoys */
  const r = el.getClientRects()[0];
  if (!r) return false;
  if (r.width < 2 || r.height < 2) return false;
  if (r.right < -500 || r.bottom < -500 || r.left > 20000 || r.top > 20000) return false;
  return true;
}

function labelText(el) {
  const parts = [];
  if (el.labels) for (const l of el.labels) parts.push(l.innerText);
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) parts.push(l.innerText);
  }
  const wrap = el.closest("label");
  if (wrap) parts.push(wrap.innerText);
  const cell = el.closest("td,th,.field,.form-group,[role='group'],.form-row,p");
  if (cell) {
    const prev = cell.previousElementSibling;
    if (prev && prev.innerText.length < 80) parts.push(prev.innerText);
  }
  if (el.previousSibling && el.previousSibling.textContent) {
    const t = el.previousSibling.textContent.trim();
    if (t && t.length < 60) parts.push(t);
  }
  /* legend only for radio/checkbox groups — a section legend like "Adresse"
     would otherwise bleed into every field's label and misfire the street anchor */
  if (el.type === "radio" || el.type === "checkbox") {
    const legend = el.closest("fieldset")?.querySelector("legend");
    if (legend) parts.push(legend.innerText);
  }
  return [...new Set(parts.map(p => String(p || "").replace(/\s+/g, " ").trim()).filter(Boolean))].join(" ");
}

function tokens(el) {
  return [
    el.getAttribute("autocomplete") || "",
    el.name || "", el.id || "", el.type === "email" ? "email" : "",
    el.placeholder || "", el.getAttribute("aria-label") || "",
    el.getAttribute("data-placeholder") || "",
    el.getAttribute("aria-labelledby") ? (document.getElementById(el.getAttribute("aria-labelledby"))?.innerText || "") : "",
    labelText(el)
  ].join(" ").replace(/[_\-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2"); /* camelCase */
}

/* birthdate ISO -> day/month/year parts for split date fields */
function bdayParts(entities) {
  const d = entities.birthdate || entities.date || "";
  const m = d.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? { bday_day: m[3], bday_month: m[2], bday_year: m[1] } : null;
}

function scoreField(el, entities, bp) {
  /* autocomplete is multi-token: "billing address-level2" → check each token */
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
  if (ac) {
    for (const tok of ac.split(/\s+/)) {
      const ent = AC_MAP[tok];
      if (ent === "__off" || ent === "__ignore") return { entity: null, score: -1 };
      if (!ent || ent === "password" || ent === "otp") continue;
      if (ent.startsWith("bday_")) { if (bp) return { entity: ent, score: 100 }; continue; }
      if (ent.startsWith("cc_") || ent === "creditcard") { if (entities.creditcard) return { entity: ent, score: 100 }; continue; }
      if (entities[ent]) return { entity: ent, score: 100 };
    }
    const whole = AC_MAP[ac];
    if (whole && !whole.startsWith("bday_") && !whole.startsWith("cc_") && entities[whole]) return { entity: whole, score: 100 };
  }
  if (el.type === "email" && entities.email) return { entity: "email", score: 95 };
  if (el.type === "tel" && entities.phone) return { entity: "phone", score: 95 };
  if (el.type === "url" && entities.url) return { entity: "url", score: 95 };
  if (el.type === "date" && (entities.birthdate || entities.date))
    return { entity: entities.birthdate ? "birthdate" : "date", score: 90 };
  if (el.type === "month" && entities.date) return { entity: "date", score: 70 };
  if (el.type === "number" && (entities.number || entities.amount)) return { entity: entities.number ? "number" : "amount", score: 55 };

  const hay = tokens(el).toLowerCase();
  /* split birth-date fields first — "dob_day" must beat the plain `dob` anchor */
  if (bp) {
    if (/\b(day|tag|dd|tt)\b/.test(hay)) return { entity: "bday_day", score: 70 };
    if (/\b(month|monat|mm)\b/.test(hay)) return { entity: "bday_month", score: 70 };
    if (/\b(year|jahr|yy|yyyy|jjjj)\b/.test(hay)) return { entity: "bday_year", score: 70 };
  }
  let best = null;
  for (const [entity, rx] of Object.entries(ENTITY_ANCHORS)) {
    if (!entities[entity]) continue;
    if (rx.test(hay)) {
      const w = entity === "message" && el.tagName !== "TEXTAREA" ? 5 :
                el.tagName === "TEXTAREA" && entity !== "message" ? 5 : 60;
      if (!best || w > best.score) best = { entity, score: w };
    }
  }
  /* name/id heuristic for split birth dates: day_/month_/year_ select or input */
  if (!best && el.type === "date" && entities.birthdate) best = { entity: "birthdate", score: 50 };
  return best;
}

/* all fillable elements, traversing OPEN shadow roots (Salesforce/Lit/ERP
   forms live in shadow DOM — closed roots stay unreachable by design) */
function allFields() {
  const sel = "input, textarea, select, [contenteditable=''], " +
    "[contenteditable='true'], [role='combobox'], [role='listbox']";
  const out = [], seen = new Set();
  const walk = (node) => {
    if (!node || !node.querySelectorAll) return;
    for (const el of node.querySelectorAll(sel)) {
      if (!seen.has(el)) { seen.add(el); out.push(el); }
    }
    for (const h of node.querySelectorAll("*")) if (h.shadowRoot) walk(h.shadowRoot);
  };
  walk(document);
  return out;
}

/* Select2/TomSelect/Choices hide the real <select> and render a widget —
   the select is invisible by design but IS the backing store: setting
   value + change syncs the widget. Detect that pattern explicitly. */
function fire(el, type, value) {
  if (type === "input" && typeof InputEvent !== "undefined") {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value || null, inputType: "insertText" }));
    return;
  }
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

/* React registers blur-handlers via delegated focusout — non-bubbling
   blur alone never marks the field "touched" and validation still blocks. */
function fireSet(el, value) {
  fire(el, "focus");
  fire(el, "focusin");
  fire(el, "beforeinput");
  fire(el, "input", value);
  fire(el, "change");
  fire(el, "focusout");
  fire(el, "blur");
}

function optionMatch(el, value) {
  const v = squash(value);
  if (!v) return null;
  const opts = [...(el.options || [])];
  const byNorm = o => squash(o.value) === v || squash(o.text) === v || squash(o.label || "") === v;
  let opt = opts.find(byNorm);
  if (opt) return opt;
  /* country aliases */
  const aliases = COUNTRIES[norm(value)] || SALUTATIONS[norm(value)];
  if (aliases) {
    opt = opts.find(o => aliases.includes(norm(o.text)) || aliases.includes(norm(o.value)) ||
                         aliases.some(a => squash(o.text) === squash(a) || squash(o.value) === squash(a)));
    if (opt) return opt;
  }
  /* loose substring both ways, minimum length guard */
  opt = opts.find(o => {
    const ot = squash(o.text), ov = squash(o.value);
    return (ot.length > 2 && (ot.includes(v) || v.includes(ot))) ||
           (ov.length > 2 && (ov.includes(v) || v.includes(ov)));
  });
  return opt || null;
}

function ccParts(entities) {
  const m = String(entities.ccExp || "").match(/\b(0[1-9]|1[0-2])\s?[/\-.]\s?(\d{2}|\d{4})\b/);
  if (!m) return null;
  const y = m[2].length === 2 ? "20" + m[2] : m[2];
  return { month: m[1], year: y, exp: `${m[1]}/${y}`, iso: `${y}-${m[1]}` };
}

function phoneParts(v) {
  let s = String(v || "").trim(), cc = "", ext = "";
  s = s.replace(/\s*(?:dw\.?|durchwahl|ext\.?|x)\s*(\d{1,6})\s*$/i, (_, e) => { ext = e; return ""; }).trim();
  const cm = s.match(/^(\+\d{1,3}|00\d{1,3})\s*(.*)$/);
  if (cm) { cc = cm[1].replace(/^00/, "+"); s = cm[2].trim(); }
  const pm = s.match(/^[\s(]*(0?\d{1,6})[)\s./-]*([\d\s./-]+)$/);
  let area = "", local = s.replace(/\D/g, "");
  if (pm) { area = pm[1].startsWith("0") ? pm[1] : "0" + pm[1]; local = pm[2].replace(/\D/g, ""); }
  return { cc, area, local, ext, full: s };
}

/* input[type=number] and [type=month] silently sanitize non-conforming
   values to "" in real DOM — coerce before assigning. */
function coerce(el, value) {
  const v = String(value);
  if (el.type === "number") {
    const n = v.replace(/[^\d,.-]/g, "")
               .replace(/\.(?=\d{3}\b)/g, "")   /* de thousands "1.234" */
               .replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
  }
  if (el.type === "month") {
    const m = v.match(/(\d{4})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}`;
    const mm = v.match(/\b(0[1-9]|1[0-2])\s?[/\-.]\s?(\d{2}|\d{4})\b/);
    return mm ? `${mm[2].length === 2 ? "20" + mm[2] : mm[2]}-${mm[1]}` : null;
  }
  if (el.type === "date") {
    const m = v.match(/\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : v;
  }
  return v;
}

function resolveValue(entity, entities, bp, el) {
  if (entity === "bday_day") return bp ? bp.bday_day : null;
  if (entity === "bday_month") return bp ? bp.bday_month : null;
  if (entity === "bday_year") return bp ? bp.bday_year : null;
  if (entity.startsWith("cc_")) {
    const cp = ccParts(entities);
    if (entity === "cc_exp") return cp ? (el.type === "month" ? cp.iso : cp.exp) : null;
    if (entity === "cc_month") return cp ? cp.month : null;
    if (entity === "cc_year") return cp ? cp.year : null;
    if (entity === "cc_csc") return entities.cvc || null;
    if (entity === "cc_type") return null;
  }
  if (entity === "street" && entities.streetName) {
    /* a field labeled just "Straße"/"Straßenname" wants the name part only —
       "Straße und Hausnummer" or EN "street-address" still get the combined value */
    const t = norm(tokens(el));
    if (/(stra(ss|ß)e(nname)?|straßenname|street ?name)/.test(t) &&
        !/haus|nummer|\bnr\b|number|adress?e?/.test(t))
      return entities.streetName;
  }
  if (entity === "phone") {
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    if (/tel-(area|local|extension|country)/.test(ac)) {
      const p = phoneParts(entities.phone);
      if (ac.includes("tel-country-code")) return p.cc || null;
      if (ac.includes("tel-area-code")) return p.area || null;
      if (ac.includes("tel-local")) return p.local || null;
      if (ac.includes("tel-extension")) return p.ext || null;
    }
    return entities.phone;
  }
  if (entity === "amount") {
    const v = entities.amount || "";
    const m = v.match(/[\d.,]+/);
    return m ? m[0] : null;
  }
  return entities[entity] || null;
}

function setValue(el, value) {
  const v = coerce(el, value);
  if (v === null || v === undefined) return null;
  const old = { el, value: el.value, checked: el.checked };
  if (el.tagName === "SELECT") {
    const opt = optionMatch(el, v);
    if (!opt || opt.disabled || opt.parentElement?.disabled) return null;
    el.value = opt.value;
  } else if (el.isContentEditable) {
    old.value = el.innerText;
    el.innerText = v;
    fire(el, "beforeinput"); fire(el, "input", v);
    return old;
  } else {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
  }
  fireSet(el, v);
  return old;
}

function disabled(el) {
  /* :disabled covers fieldset[disabled] descendants, el.disabled does not */
  if (el.matches) { try { return el.matches(":disabled"); } catch { /* stub DOM */ } }
  return !!el.disabled;
}


root.HeavenKeyFieldPrimitives = { allFields, visible, labelText, tokens, scoreField, bdayParts, resolveValue, setValue, optionMatch, coerce, fireSet, disabled, COUNTRIES, SALUTATIONS };
})(typeof globalThis !== "undefined" ? globalThis : window);
