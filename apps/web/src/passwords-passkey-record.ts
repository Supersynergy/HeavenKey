export type WebsitePasskey = { id: string; rpId: string; userHandle: string; userName: string; userDisplayName: string; privateKey: string; publicKey: string; createdAt: string };
export function validateWebsitePasskeys(value: unknown): WebsitePasskey[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error("Ungültige Website-Passkeys.");
  const ids = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).sort().join() !== "createdAt,id,privateKey,publicKey,rpId,userDisplayName,userHandle,userName") throw new Error("Ungültiges Passkey-Format.");
    for (const [field, maximum] of Object.entries({ id: 2048, rpId: 253, userHandle: 86, userName: 320, userDisplayName: 320, privateKey: 2048, publicKey: 1024, createdAt: 80 })) if (typeof row[field] !== "string" || !row[field].length || row[field].length > maximum) throw new Error("Ungültiges Passkey-Feld.");
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(row.rpId) || row.rpId.includes("..") || !Number.isFinite(Date.parse(row.createdAt)) || ids.has(row.id)) throw new Error("Ungültige Passkey-ID oder Website.");
    for (const field of ["id", "userHandle", "privateKey", "publicKey"]) {
      const raw = row[field];
      if (!/^[A-Za-z0-9_-]+$/.test(raw) || raw.length % 4 === 1) throw new Error("Ungültige Passkey-Kodierung.");
      const bytes = atob(raw.replaceAll("-", "+").replaceAll("_", "/"));
      if (btoa(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") !== raw || (field === "userHandle" && bytes.length > 64)) throw new Error("Ungültige Passkey-Kodierung.");
    }
    ids.add(row.id);
  }
  return value;
}
