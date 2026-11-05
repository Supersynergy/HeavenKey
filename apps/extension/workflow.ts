import { HIGH_FIELDS, PROFILE_KEYS } from '../../packages/forms/schema';
export type Task = 'login' | 'template' | 'generate' | 'manage';
export const tasks: Task[] = ['login','template','generate','manage'];
export function taskFrom(value: string | null): Task { return tasks.includes(value as Task) ? value as Task : 'login'; }
export function fieldTask(el: { type: string; autocomplete: string; name: string; id: string }): Task {
  if (el.autocomplete.toLowerCase().split(/\s+/).includes('new-password')) return 'generate';
  return el.type === 'password' || /username|current-password|one-time-code|user|login/i.test([el.autocomplete,el.name,el.id].join(' ')) ? 'login' : 'template';
}
/** Only the chosen source values cross into the content-script context. */
export function deliveryEntities(entities: Record<string,string>, selected: { entity: string }[], permissions: { secrets?: boolean; sensitive?: boolean } = {}): Record<string,string> {
  const wanted = new Set(selected.map(({entity}) => entity.startsWith('bday_') ? 'birthdate' :
    ['cc_exp','cc_month','cc_year'].includes(entity) ? 'ccExp' : entity === 'cc_csc' ? 'cvc' : entity));
  if (wanted.has('street') && entities.streetName) wanted.add('streetName');
  return Object.fromEntries(Object.entries(entities).filter(([name]) => wanted.has(name) &&
    (PROFILE_KEYS.includes(name as any) || name === 'otp') &&
    (!['password','otp'].includes(name) || permissions.secrets) && (!HIGH_FIELDS.has(name) || permissions.sensitive)));
}
