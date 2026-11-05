import { test, expect } from 'bun:test';
import { website, scriptId } from './site-access';
test('website grants preserve exact origins while browser patterns are host scoped',async()=>{
  expect(website('https://accounts.example:8443/login')).toEqual({origin:'https://accounts.example:8443',pattern:'https://accounts.example/*'});
  expect(website('http://localhost:18258/')).toEqual({origin:'http://localhost:18258',pattern:'http://localhost/*'});
  for(const url of ['http://example.com/','https://user:secret@example.com/','javascript:alert(1)','file:///tmp/a','about:blank']) expect(()=>website(url)).toThrow();
  expect(await scriptId('https://accounts.example')).toBe(await scriptId('https://accounts.example'));
  expect(await scriptId('https://accounts.example')).not.toBe(await scriptId('https://accounts.example:8443'));
});
