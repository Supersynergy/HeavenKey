/** Suggestions use only the currently unlocked vault. */
export function suggestedUsernames(entries: readonly { username: string }[]): string[] {
  return [...new Set(entries.map(entry => entry.username).filter(Boolean))].slice(0, 5);
}

export function normalizeWebsite(raw: string): { url: string; title: string } | null {
  const value = raw.trim();
  if (!value) return { url: "", title: "" };
  const explicit = /^https?:\/\//i.test(value);
  if (!explicit && !/^[a-z0-9](?:[a-z0-9.-]*\.)[a-z]{2,}(?::\d{1,5})?(?:[/?#].*)?$/i.test(value)) return null;
  try {
    const url = new URL(explicit ? value : `https://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
    return { url: url.href, title: url.hostname.slice(0, 200) };
  } catch { return null; }
}
