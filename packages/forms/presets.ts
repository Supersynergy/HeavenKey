import { PROFILE_KEYS } from './schema';
type Key = typeof PROFILE_KEYS[number];
export const FORM_PRESETS: readonly { id: string; title: string; fields: readonly Key[] }[] = [
  { id: 'shop', title: 'Shop · Adresse & Kontakt', fields: ['firstName','lastName','email','phone','company','street','address2','zip','city','state','country'] },
  { id: 'inquiry', title: 'Anfrage · Firma & Nachricht', fields: ['name','email','phone','company','subject','message'] },
  { id: 'tax', title: 'Steuerdaten · vertraulich', fields: ['name','birthdate','street','zip','city','country','steuerid','steuernr','vat','iban','bic','accountHolder'] },
];
/** Empty drafts only: examples and real tax identifiers must never be confused. */
export function presetEntities(id: string): Record<string,string> {
  const preset = FORM_PRESETS.find(item => item.id === id);
  if (!preset) throw Error('Unbekannte Formularvorlage.');
  return Object.fromEntries(preset.fields.map(key => [key, '']));
}
