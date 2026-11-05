/** Match patterns grant UI access only; every operation still checks the full origin. */
export function website(raw: string): { origin: string; pattern: string } {
  const url = new URL(raw);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Nur HTTPS-Websites und lokale Testseiten sind erlaubt.');
  return { origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
}
export async function scriptId(origin: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(origin));
  return 'heavenkey-site-' + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
