import { test, expect } from 'bun:test';
import { fieldTask, taskFrom, deliveryEntities } from './workflow';
test('field purpose suggests the relevant task without authorizing delivery', () => {
  const field = {type:'text',autocomplete:'',name:'',id:''};
  expect(fieldTask({...field,type:'password',autocomplete:'section-signup new-password'})).toBe('generate');
  expect(fieldTask({...field,type:'password'})).toBe('login');
  expect(fieldTask({...field,autocomplete:'username'})).toBe('login');
  expect(fieldTask({...field,autocomplete:'given-name'})).toBe('template');
  expect(taskFrom('javascript:bad')).toBe('login');
});
test('unselected passwords, OTPs and identity values never enter delivery payload', () => {
  const source = {username:'Synthetic',password:'Synthetic-secret',otp:'123456',iban:'Synthetic-iban',firstName:'Alex'};
  expect(deliveryEntities(source,[{entity:'firstName'}])).toEqual({firstName:'Alex'});
  expect(deliveryEntities(source,[{entity:'username'},{entity:'password'}])).toEqual({username:'Synthetic'});
  expect(deliveryEntities(source,[{entity:'username'},{entity:'password'}],{secrets:true})).toEqual({username:'Synthetic',password:'Synthetic-secret'});
  expect(deliveryEntities(source,[])).toEqual({});
});
test('derived date and expiry fields request their source rather than unrelated values', () => {
  expect(deliveryEntities({birthdate:'2000-01-02',ccExp:'2030-12',cvc:'123',password:'Synthetic'},[{entity:'bday_day'},{entity:'cc_month'},{entity:'cc_csc'}],{sensitive:true}))
    .toEqual({birthdate:'2000-01-02',ccExp:'2030-12',cvc:'123'});
  expect(deliveryEntities({street:'Gartenstraße 3',streetName:'Gartenstraße',houseNumber:'3',password:'Synthetic'},[{entity:'street'}]))
    .toEqual({street:'Gartenstraße 3',streetName:'Gartenstraße'});
});
