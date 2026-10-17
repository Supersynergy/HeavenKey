import type { Login, Vault } from '../../apps/web/src/passwords-crypto';
export type ImportAction = 'add' | 'skip' | 'replace';
export type ImportRow = { kind: 'new' | 'duplicate' | 'conflict'; existingId?: string; withinFile: boolean; defaultAction: ImportAction };
function identity(entry: Login): string {
  return JSON.stringify([entry.url ? new URL(entry.url).origin : entry.title.trim(), entry.username]);
}
function same(a: Login,b: Login): boolean {
  const fields=(entry:Login)=>[entry.title,entry.username,entry.password,entry.url,entry.notes,entry.totp,[...entry.tags].sort(),entry.favorite];
  return JSON.stringify(fields(a)) === JSON.stringify(fields(b));
}
export function planImport(existing: Login[], imported: Login[]): ImportRow[] {
  const known = new Map<string,Login[]>();
  for (const entry of existing) known.set(identity(entry),[...(known.get(identity(entry)) || []),entry]);
  const seen = new Map<string,Login[]>();
  return imported.map(entry=>{
    const key=identity(entry), prior=known.get(key) || [], earlier=seen.get(key) || [];
    const exact=[...prior,...earlier].find(item=>same(item,entry));
    const kind=exact ? 'duplicate' : prior.length || earlier.length ? 'conflict' : 'new';
    seen.set(key,[...earlier,entry]);
    return {kind,existingId:prior.length===1 ? prior[0].id : undefined,withinFile:prior.length===0 && earlier.length>0,defaultAction:kind==='new'?'add':'skip'};
  });
}
export function applyImport(vault: Vault, imported: Login[], actions: ImportAction[]): Vault {
  if (actions.length!==imported.length) throw new Error('Die Importauswahl ist unvollständig.');
  const rows=planImport(vault.entries,imported), entries=[...vault.entries], replaced=new Set<string>();
  imported.forEach((entry,index)=>{
    const action=actions[index], row=rows[index];
    if (action==='skip') return;
    if (action==='add') { entries.push(entry); return; }
    if (action!=='replace' || !row.existingId || replaced.has(row.existingId)) throw new Error('Ersetzen ist nur bei einem eindeutigen vorhandenen Eintrag und einer ausgewählten Zeile erlaubt.');
    replaced.add(row.existingId);
    const target=entries.findIndex(item=>item.id===row.existingId);
    if (target<0) throw new Error('Das Importziel wurde geändert. Prüfe die Vorschau erneut.');
    entries[target]={...entry,id:row.existingId};
  });
  return {...vault,entries};
}
