export const PROFILE_KEYS = ["accountHolder","address2","ahv","amount","bankName","bic","birthdate","blz","caseno","ccExp","ccHolder","city","company","contractno","country","creditcard","creditorId","currency","customerno","cvc","date","email","familienstand","firstName","geburtsname","geburtsort","gkv","houseNumber","hrb","iban","jobTitle","konfession","language","lastName","mandatsref","memberno","message","name","nationality","number","password","perso","phone","postbox","purpose","salutation","sozialvers","state","steuerid","steuernr","street","streetName","subject","title","url","username","vat","zip"] as const;
export type ProfileEntities = Partial<Record<typeof PROFILE_KEYS[number], string>>;
export type FormProfile = { id: string; title: string; entities: ProfileEntities; updatedAt: string };
export const HIGH_FIELDS = new Set<string>(["iban","bic","creditcard","cvc","ccExp","ccHolder","blz","accountHolder","bankName","mandatsref","creditorId","steuernr","steuerid","perso","sozialvers","gkv","ahv","konfession"]);
export function validateProfiles(value: unknown): FormProfile[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Maximal 100 Formularprofile sind erlaubt.");
  const ids = new Set<string>();
  for (const profile of value) {
    if (!profile || typeof profile !== "object" || Object.keys(profile).sort().join() !== "entities,id,title,updatedAt" || typeof profile.id !== "string" || !profile.id || profile.id.length > 100 || ids.has(profile.id) || typeof profile.title !== "string" || !profile.title.trim() || profile.title.length > 200 || typeof profile.updatedAt !== "string" || !Number.isFinite(Date.parse(profile.updatedAt)) || !profile.entities || typeof profile.entities !== "object" || Array.isArray(profile.entities)) throw new Error("Ungültiges Formularprofil.");
    ids.add(profile.id);
    for (const [name, text] of Object.entries(profile.entities)) if (!(PROFILE_KEYS as readonly string[]).includes(name) || typeof text !== "string" || text.length > 10000) throw new Error("Ungültiges Profilfeld.");
  }
  return value as FormProfile[];
}
