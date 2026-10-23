import { isProtectedId } from "../../../packages/protected/schema";
import { decode64, encode64, freshBytes } from "./passwords-crypto";

const utf8 = new TextEncoder();
export async function protectedDraftHash(draft: string): Promise<string> {
 const bytes = utf8.encode(draft);
 try { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join(""); }
 finally { bytes.fill(0); }
}

export async function sealProtectedDelivery(
 document: string, recipientUrl: string, publicKey: string, workspace: string, epoch: number, revision: number, draftHash: string, guard: () => void,
): Promise<{ key: string; iv: string; ciphertext: string }> {
 guard();
 if (!isProtectedId(workspace) || !Number.isSafeInteger(epoch) || epoch < 0 || !Number.isSafeInteger(revision) || revision < 0 || !/^[a-f0-9]{64}$/.test(draftHash) || !document.trim() || utf8.encode(document).length > 16000) throw new Error("Ungültige geschützte Zustellung.");
 const raw = freshBytes(32), iv = freshBytes(12);
 let plain: Uint8Array<ArrayBuffer> | undefined;
 try {
  plain = utf8.encode(JSON.stringify({ version: 1, recipient_url: recipientUrl, document }));
  const rsa = await crypto.subtle.importKey("spki", decode64(publicKey, 1024), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]); guard();
  const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]); guard();
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(`HeavenKey protected delivery v1\0${workspace}\0${epoch}\0${revision}\0${draftHash}`) }, aes, plain); guard();
  const key = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, rsa, raw); guard();
  return { key: encode64(new Uint8Array(key)), iv: encode64(iv), ciphertext: encode64(new Uint8Array(ciphertext)) };
 } finally { raw.fill(0); plain?.fill(0); }
}
