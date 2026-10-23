import { expect, test } from "bun:test";
import { decode64, encode64 } from "./passwords-crypto";
import { protectedDraftHash, sealProtectedDelivery } from "./passwords-protected-crypto";

test("delivery seals only exact preview content and endpoint with source-bound authenticated metadata", async () => {
 const rsa = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
 const publicKey = encode64(new Uint8Array(await crypto.subtle.exportKey("spki", rsa.publicKey)));
 const id = "00000000-0000-4000-8000-000000000001", draftHash = await protectedDraftHash("synthetic pseudonym draft"), document = "Synthetic private content", url = "https://fixture.invalid/messages/send";
 const sealed = await sealProtectedDelivery(document, url, publicKey, id, 7, 12, draftHash, () => {});
 expect(JSON.stringify(sealed)).not.toContain(document); expect(JSON.stringify(sealed)).not.toContain(url); expect(draftHash).toMatch(/^[0-9a-f]{64}$/);
 const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, rsa.privateKey, decode64(sealed.key, 1024));
 const aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
 const aad = new TextEncoder().encode(`HeavenKey protected delivery v1\0${id}\0${7}\0${12}\0${draftHash}`);
 const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(sealed.iv, 12), additionalData: aad }, aes, decode64(sealed.ciphertext, 20000));
 expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ version: 1, recipient_url: url, document });
 await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv: decode64(sealed.iv, 12), additionalData: new TextEncoder().encode(new TextDecoder().decode(aad) + "x") }, aes, decode64(sealed.ciphertext, 20000))).rejects.toThrow();
 await expect(sealProtectedDelivery(document, url, publicKey, id, 7, 12, draftHash, () => { throw new Error("locked"); })).rejects.toThrow("locked");
 let checks = 0;
 await expect(sealProtectedDelivery(document, url, publicKey, id, 7, 12, draftHash, () => { if (++checks === 2) throw new Error("locked after import"); })).rejects.toThrow("locked after import");
 await expect(sealProtectedDelivery("ü".repeat(8001), url, publicKey, id, 7, 12, draftHash, () => {})).rejects.toThrow();
});
