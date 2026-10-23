import { test, expect } from "bun:test";
import {
	generateChannel,
	sealUnlock,
	openUnlock,
	channelCode,
	type UnlockRequest,
} from "./unlock-channel";
import { encode64, freshBytes } from "../web/src/passwords-crypto";
test("one-use channel encrypts only to the requesting key and authenticates origin, revision, salt and request", async () => {
	const channel = await generateChannel(),
		other = await generateChannel();
	const request: UnlockRequest = {
		id: encode64(freshBytes(32)),
		origin: "chrome-extension://" + "a".repeat(32),
		public_key: channel.public_key,
		revision: 1,
		vault_salt: encode64(freshBytes(16)),
	};
	const master = "Synthetic-master-only!#42",
		sealed = await sealUnlock(request, master);
	expect(JSON.stringify(sealed)).not.toContain(master);
	expect(await openUnlock(request, channel.privateKey, sealed)).toBe(master);
	expect(await channelCode(request)).toMatch(/^[0-9A-F]{8}$/);
	await expect(openUnlock(request, other.privateKey, sealed)).rejects.toThrow();
	for (const altered of [
		{ ...request, origin: "chrome-extension://" + "b".repeat(32) },
		{ ...request, revision: 2 },
		{ ...request, id: encode64(freshBytes(32)) },
		{ ...request, vault_salt: encode64(freshBytes(16)) },
		{ ...request, public_key: other.public_key },
	])
		await expect(
			openUnlock(altered, channel.privateKey, sealed),
		).rejects.toThrow();
	await expect(
		openUnlock(request, channel.privateKey, {
			...sealed,
			ciphertext: encode64(freshBytes(64)),
		}),
	).rejects.toThrow();
	expect(channel.privateKey.extractable).toBe(false);
});
