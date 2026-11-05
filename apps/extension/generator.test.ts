import { test, expect } from 'bun:test';
import { password, passphrase } from './generator';
test('password generator respects selected alphabet, every character group and bounds',()=>{
  for(const symbols of [true,false]) for(const length of [14,24,128]) for(let i=0;i<40;i++) {
    const value=password(length,symbols);expect(value.length).toBe(length);
    expect(value).toMatch(/[A-Z]/);expect(value).toMatch(/[a-z]/);expect(value).toMatch(/[2-9]/);
    expect(value).not.toMatch(/[01IOl]/);
    expect(/[^a-zA-Z0-9]/.test(value)).toBe(symbols);
  }
  for(const length of [0,13,129,NaN,22.5]) expect(()=>password(length,true)).toThrow();
});
test('memorable passphrases use six independently chosen EFF words and reject weak counts',()=>{
  const values=Array.from({length:40},()=>passphrase());
  expect(new Set(values).size).toBe(40);
  for(const value of values) {expect(value.split('.').length).toBe(6);expect(value).toMatch(/^[a-z-]+(?:\.[a-z-]+){5}$/);}
  for(const count of [0,5,11,NaN,6.5]) expect(()=>passphrase(count)).toThrow();
});
