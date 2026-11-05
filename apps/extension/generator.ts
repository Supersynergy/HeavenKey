import { generatePassword } from '../web/src/passwords-crypto';
import wordlist from '../mobile/assets/eff_large_wordlist.txt' with { type: 'text' };
const words = wordlist.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).at(-1)!);
export function password(length: number, symbols: boolean): string {
  const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', ...(symbols ? ['!#$%&()*+,-./:;<=>?@[]^_{|}~'] : [])];
  for (let attempt = 0; attempt < 1000; attempt++) {
    const value = generatePassword(length, groups.join(''));
    if (groups.every(group => [...value].some(char => group.includes(char)))) return value;
  }
  throw new Error('Passwort konnte nicht erzeugt werden. Erneut versuchen.');
}
export function passphrase(count = 6): string {
  if (!Number.isInteger(count) || count < 6 || count > 10 || words.length !== 7776 || new Set(words).size !== 7776) throw new Error('Ungültige Passphrase-Parameter oder Wortliste.');
  const ceiling = 0x100000000 - 0x100000000 % words.length, chosen: string[] = [];
  while (chosen.length < count) { const value = crypto.getRandomValues(new Uint32Array(1))[0]; if (value < ceiling) chosen.push(words[value % words.length]); }
  return chosen.join('.');
}
