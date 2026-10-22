export type ReferenceKind = "person" | "email" | "case";
export type PublishedReference = { id: string; kind: ReferenceKind };
export type PrivateReference = PublishedReference & { value: string };
export type PrivateWorkspace = { id: string; created_at: string; source_id: string; template: "reply"; references: PrivateReference[]; draft?: string };
export const REFERENCE_KINDS = ["person", "email", "case"] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utf8 = new TextEncoder();
const invalid = () => new Error("Ungültiger geschützter Arbeitsbereich oder Entwurf.");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, expected: string) => Object.keys(v).sort().join() === expected;
export const isProtectedId = (v: unknown): v is string => typeof v === "string" && uuid.test(v) && v !== "00000000-0000-0000-0000-000000000000";
function checkedReferences(value: unknown, privateValues: boolean): asserts value is PrivateReference[] {
 if (!Array.isArray(value) || value.length !== 3) throw invalid();
 const ids = new Set<string>(), kinds = new Set<string>();
 for (const ref of value) {
  if (!object(ref) || !keys(ref, privateValues ? "id,kind,value" : "id,kind") || !isProtectedId(ref.id) || ids.has(ref.id) || !REFERENCE_KINDS.includes(ref.kind as ReferenceKind) || kinds.has(ref.kind as string)) throw invalid();
  if (privateValues && (typeof ref.value !== "string" || !ref.value.trim() || utf8.encode(ref.value).length > 1000)) throw invalid();
  ids.add(ref.id); kinds.add(ref.kind as string);
 }
}
export function validatePrivateWorkspaces(value: unknown, logins: readonly { id: string }[]): PrivateWorkspace[] {
 if (!Array.isArray(value) || value.length > 32) throw invalid();
 const ids = new Set<string>();
 for (const row of value) {
  if (!object(row) || !keys(row, row.draft === undefined ? "created_at,id,references,source_id,template" : "created_at,draft,id,references,source_id,template") || !isProtectedId(row.id) || row.template !== "reply" || typeof row.created_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at)) || new Date(row.created_at).toISOString() !== row.created_at || typeof row.source_id !== "string" || logins.filter(login => login.id === row.source_id).length !== 1) throw invalid();
  checkedReferences(row.references, true);
  for (const id of [row.id, ...row.references.map(ref => ref.id)]) { if (ids.has(id)) throw invalid(); ids.add(id); }
  if (row.draft !== undefined) resolveProtectedDraft(row.draft, row.references);
 }
 return value as PrivateWorkspace[];
}
export function publishedReferences(workspace: PrivateWorkspace): PublishedReference[] {
 checkedReferences(workspace.references, true);
 return workspace.references.map(({ id, kind }) => ({ id, kind }));
}
export function buildProtectedPrompt(references: PublishedReference[]): string {
 checkedReferences(references, false);
 const token = (kind: ReferenceKind) => `[[HK:${references.find(ref => ref.kind === kind)!.id}]]`;
 return `Erstelle einen kurzen deutschen Antwortentwurf für ${token("person")} zur Anfrage ${token("case")}. Verwende ${token("email")} als E-Mail-Referenz. Bewahre die Platzhalter unverändert. Keine URLs, kein HTML, keine externen Aktionen.`;
}
export function resolveProtectedDraft(value: unknown, references: PrivateReference[]): string {
 checkedReferences(references, true);
 if (typeof value !== "string" || !value.trim() || utf8.encode(value).length > 8000 || /[<>\\\x00-\x1f\x7f-\x9f]/u.test(value) || value.includes("//") || value.toLowerCase().includes("www.")) throw invalid();
 const token = /\[\[HK:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/g;
 let count = 0;
 const stripped = value.replace(token, (_match, id: string) => { if (!references.some(ref => ref.id === id)) throw invalid(); count++; return ""; });
 if (!count || /[\[\]:]|[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(stripped)) throw invalid();
 return value.replace(token, (_match, id: string) => references.find(ref => ref.id === id)!.value);
}
