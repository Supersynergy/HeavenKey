import { describe, expect, test } from "bun:test";
import { validateVault } from "./passwords-crypto";
import type { Login } from "./passwords-crypto";
import {
	SAMPLE_COUNT,
	SAMPLE_TAG,
	buildSampleEntries,
	hasSampleEntries,
	isSampleEntry,
	withSampleEntries,
	withoutSampleEntries,
} from "./passwords-onboarding-samples";

const seeded = (values: number[]) => {
	let index = 0;
	return () => values[index++ % values.length];
};

describe("onboarding sample data", () => {
	test("builds labelled examples on reserved domains with generated secrets", () => {
		const entries = buildSampleEntries();
		expect(entries).toHaveLength(SAMPLE_COUNT);
		for (const entry of entries) {
			expect(entry.tags).toEqual([SAMPLE_TAG]);
			expect(isSampleEntry(entry)).toBe(true);
			expect(new URL(entry.url).protocol).toBe("https:");
			expect(new URL(entry.url).hostname.endsWith(".example")).toBe(true);
			expect(entry.username.endsWith("@example.invalid")).toBe(true);
			expect(entry.password.length).toBe(20);
			expect(entry.notes).toContain("keinem echten Konto");
			expect(entry.totp).toBe("");
			expect(entry.favorite).toBe(false);
		}
		expect(new Set(entries.map(entry => entry.id)).size).toBe(SAMPLE_COUNT);
		expect(new Set(entries.map(entry => entry.url)).size).toBe(SAMPLE_COUNT);
		expect(validateVault({ version: 1, entries }).entries).toHaveLength(SAMPLE_COUNT);
	});

	test("repeats the same selection for a seeded source but never reuses passwords", () => {
		const first = buildSampleEntries(3, seeded([0.11, 0.42, 0.73, 0.05, 0.9, 0.31]));
		const second = buildSampleEntries(3, seeded([0.11, 0.42, 0.73, 0.05, 0.9, 0.31]));
		expect(first.map(entry => entry.url)).toEqual(second.map(entry => entry.url));
		expect(first.map(entry => entry.username)).toEqual(second.map(entry => entry.username));
		const passwords = new Set([...first, ...second].map(entry => entry.password));
		expect(passwords.size).toBe(6);
	});

	test("stays bounded when a random source returns edge values", () => {
		for (const value of [0, 1, Number.NaN, -1, 2]) {
			const entries = buildSampleEntries(99, () => value);
			expect(entries.length).toBeLessThanOrEqual(8);
			expect(entries.length).toBeGreaterThan(0);
			expect(new Set(entries.map(entry => entry.url)).size).toBe(entries.length);
			expect(validateVault({ version: 1, entries }).entries).toHaveLength(entries.length);
		}
		expect(buildSampleEntries(0, () => 0.5)).toHaveLength(1);
	});

	test("adds and removes only tagged examples, keeping real logins intact", () => {
		const real: Login = { id: "real-1", title: "Arbeit", username: "alice", password: "real-secret-value", url: "https://example.invalid", notes: "", totp: "", tags: ["Arbeit"], favorite: true };
		const samples = buildSampleEntries();
		const merged = withSampleEntries([real], samples);
		expect(merged).toHaveLength(1 + samples.length);
		expect(hasSampleEntries(merged)).toBe(true);
		expect(withSampleEntries(merged, samples)).toHaveLength(merged.length);
		expect(withoutSampleEntries(merged)).toEqual([real]);
		expect(hasSampleEntries([real])).toBe(false);
	});
});
