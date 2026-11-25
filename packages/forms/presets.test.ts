import { expect, test } from 'bun:test';
import { FORM_PRESETS, presetEntities } from './presets';
import { PROFILE_KEYS, HIGH_FIELDS } from './schema';
test('shop, inquiry and tax drafts contain supported fields and never invented private data',()=>{
 expect(FORM_PRESETS.map(p=>p.id)).toEqual(['shop','inquiry','tax']);
 for(const preset of FORM_PRESETS) {
  const entities=presetEntities(preset.id);
  expect(Object.keys(entities)).toHaveLength(new Set(preset.fields).size);
  expect(Object.keys(entities).every(key=>PROFILE_KEYS.includes(key as any))).toBe(true);
  expect(Object.values(entities).every(value=>value==='')).toBe(true);
 }
 expect(HIGH_FIELDS.has('steuerid')).toBe(true);expect(HIGH_FIELDS.has('steuernr')).toBe(true);expect(HIGH_FIELDS.has('iban')).toBe(true);
 const edited=presetEntities('shop');edited.email='synthetic@example.invalid';expect(presetEntities('shop').email).toBe('');
 expect(()=>presetEntities('unknown')).toThrow();
});
