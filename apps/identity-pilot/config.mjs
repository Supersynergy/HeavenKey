// This pilot deliberately has no public deployment mode.
export const issuer = 'http://localhost:18370/realms/heavenkey-pilot';
export const applications = Object.freeze([
  { id: 'heavenkey-office-demo', name: 'Office-Demo', origin: 'http://office.localhost:18371' },
  { id: 'heavenkey-portal-demo', name: 'Portal-Demo', origin: 'http://portal.localhost:18372' },
]);

export function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', 'office.localhost', 'portal.localhost'].includes(url.hostname)
      || url.username || url.password || url.hash || !url.port) throw new Error('local_pilot_url_required');
  return url;
}

export function validateMetadata(metadata, expectedIssuer) {
  const expected = localUrl(expectedIssuer);
  if (metadata.issuer !== expectedIssuer) throw new Error('issuer_mismatch');
  for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const endpoint = localUrl(metadata[key]);
    if (endpoint.origin !== expected.origin) throw new Error('foreign_provider_endpoint');
  }
}
