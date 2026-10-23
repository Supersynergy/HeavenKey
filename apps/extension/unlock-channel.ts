import { decode64, encode64, freshBytes } from "../web/src/passwords-crypto";
export type Point = { x: string; y: string };
export type UnlockRequest = {
	id: string;
	origin: string;
	public_key: Point;
	revision: number;
	vault_salt: string;
};
export type SealedUnlock = {
	public_key: Point;
	iv: string;
	ciphertext: string;
};
const utf8 = new TextEncoder();
const bytes = (value: string, length: number) => {
	const b = decode64(value, length);
	if (b.length !== length || encode64(b) !== value)
		throw Error("Ungültiger Entsperrkanal.");
	return b;
};
export function validateRequest(r: UnlockRequest) {
	bytes(r.id, 32);
	bytes(r.public_key.x, 32);
	bytes(r.public_key.y, 32);
	bytes(r.vault_salt, 16);
	if (
		!Number.isSafeInteger(r.revision) ||
		r.revision < 1 ||
		!/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[0-9a-f-]{36})$/.test(
			r.origin,
		)
	)
		throw Error("Ungültige Erweiterungsfreigabe.");
	return r;
}
function binding(r: UnlockRequest) {
	validateRequest(r);
	return utf8.encode(
		JSON.stringify([
			"HeavenKey extension unlock v1",
			r.id,
			r.origin,
			r.public_key.x,
			r.public_key.y,
			r.revision,
			r.vault_salt,
		]),
	);
}
export async function generateChannel() {
	const keys = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		["deriveBits"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
	return { privateKey: keys.privateKey, public_key: { x: jwk.x!, y: jwk.y! } };
}
async function shared(
	privateKey: CryptoKey,
	point: Point,
	request: UnlockRequest,
) {
	bytes(point.x, 32);
	bytes(point.y, 32);
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		{ kty: "EC", crv: "P-256", x: point.x, y: point.y, ext: true },
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const raw = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: publicKey },
			privateKey,
			256,
		),
	);
	try {
		const seed = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
			"deriveKey",
		]);
		return await crypto.subtle.deriveKey(
			{
				name: "HKDF",
				hash: "SHA-256",
				salt: bytes(request.id, 32),
				info: binding(request),
			},
			seed,
			{ name: "AES-GCM", length: 256 },
			false,
			["encrypt", "decrypt"],
		);
	} finally {
		raw.fill(0);
	}
}
export async function sealUnlock(request: UnlockRequest, master: string) {
	const channel = await generateChannel(),
		key = await shared(channel.privateKey, request.public_key, request),
		iv = freshBytes(12),
		plain = utf8.encode(master);
	try {
		return {
			public_key: channel.public_key,
			iv: encode64(iv),
			ciphertext: encode64(
				new Uint8Array(
					await crypto.subtle.encrypt(
						{ name: "AES-GCM", iv, additionalData: binding(request) },
						key,
						plain,
					),
				),
			),
		};
	} finally {
		plain.fill(0);
	}
}
export async function openUnlock(
	request: UnlockRequest,
	privateKey: CryptoKey,
	sealed: SealedUnlock,
) {
	const key = await shared(privateKey, sealed.public_key, request);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: bytes(sealed.iv, 12),
				additionalData: binding(request),
			},
			key,
			decode64(sealed.ciphertext, 8192),
		),
	);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(plain);
	} finally {
		plain.fill(0);
	}
}
export async function channelCode(r: Pick<UnlockRequest, "id" | "public_key">) {
	const digest = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			utf8.encode(r.id + r.public_key.x + r.public_key.y),
		),
	);
	return [...digest.slice(0, 4)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("")
		.toUpperCase();
}
