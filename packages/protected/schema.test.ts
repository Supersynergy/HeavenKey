import { expect, test } from "bun:test";
import { buildProtectedPrompt, publishedReferences, resolveProtectedDraft, validatePrivateWorkspaces } from "./schema";
const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"];
const login = { id: "login" };
export const workspace = { id: ids[0], created_at: "2026-10-22T12:00:00.000Z", source_id: "login", template: "reply" as const, references: [{ id: ids[1], kind: "person" as const, value: "Synthetic Name" }, { id: ids[2], kind: "email" as const, value: "synthetic@example.invalid" }, { id: ids[3], kind: "case" as const, value: "CASE-42" }] };
test("private schema binds exact source and rejects unknown fields, duplicate or missing kinds, ids, oversized originals", () => {
 expect(validatePrivateWorkspaces([workspace], [login])).toEqual([workspace]);
 for (const bad of [{ ...workspace, source_id: "missing" }, { ...workspace, extra: "no" }, { ...workspace, references: workspace.references.slice(1) }, { ...workspace, references: workspace.references.map((r, i) => ({ ...r, kind: i === 2 ? "person" : r.kind })) }, { ...workspace, references: workspace.references.map(r => ({ ...r, id: ids[0] })) }, { ...workspace, references: workspace.references.map(r => ({ ...r, value: "ü".repeat(501) })) }, { ...workspace, created_at: "yesterday" }]) expect(() => validatePrivateWorkspaces([bad], [login])).toThrow();
 expect(() => validatePrivateWorkspaces([workspace], [login, login])).toThrow();
 expect(() => validatePrivateWorkspaces(Array(33).fill(workspace), [login])).toThrow();
});
test("published references and deterministic prompt never contain private original values", () => {
 const published = publishedReferences(workspace);
 expect(published).toEqual(workspace.references.map(({ id, kind }) => ({ id, kind })));
 const prompt = buildProtectedPrompt(published);
 expect(prompt).toBe(buildProtectedPrompt(published));
 for (const ref of workspace.references) { expect(prompt).toContain(`[[HK:${ref.id}]]`); expect(JSON.stringify(published) + prompt).not.toContain(ref.value); }
});
test("preview resolves exact allowed tokens once and rejects unknown or malformed tokens, markup, URLs, controls", () => {
 const text = `Antwort für [[HK:${ids[1]}]] zum Fall [[HK:${ids[3]}]].`;
 expect(resolveProtectedDraft(text, workspace.references)).toBe("Antwort für Synthetic Name zum Fall CASE-42.");
 const nested = workspace.references.map(r => ({ ...r, value: `[[HK:${ids[2]}]]` }));
 expect(resolveProtectedDraft(`[[HK:${ids[1]}]]`, nested)).toBe(`[[HK:${ids[2]}]]`);
 for (const suffix of [` [[HK:${ids[0]}]]`, " [[HK:bad]]", " [[hk:bad]]", " [[HK:", " <img src=x>", " https://example.invalid", " example.invalid", " javascript:alert(1)", " \u0000", "\n"]) expect(() => resolveProtectedDraft(text + suffix, workspace.references)).toThrow();
 expect(() => resolveProtectedDraft("no references", workspace.references)).toThrow();
 expect(() => validatePrivateWorkspaces([{ ...workspace, draft: "<script>no</script>" }], [login])).toThrow();
});
