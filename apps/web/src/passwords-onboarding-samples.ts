/** Random onboarding examples. They use RFC 2606 reserved domains, so no real account is touched. */
import type { Login } from "./passwords-crypto";
import { generatePassword } from "./passwords-crypto";

export const SAMPLE_TAG = "Beispiel";
export const SAMPLE_COUNT = 3;

export type Random = () => number;

/** Fictional services on `.example`: they can never resolve to a real website. */
const services = [
	{ title: "Fotoalbum", host: "fotoalbum.example" },
	{ title: "Reisebuchung", host: "reisebuchung.example" },
	{ title: "Notizbuch", host: "notizbuch.example" },
	{ title: "Kochrezepte", host: "kochrezepte.example" },
	{ title: "Sprachkurs", host: "sprachkurs.example" },
	{ title: "Werkstatt", host: "werkstatt.example" },
	{ title: "Leseliste", host: "leseliste.example" },
	{ title: "Vereinskalender", host: "vereinskalender.example" },
] as const;

const accounts = ["demo", "beispiel", "probe", "testkonto", "muster"] as const;

function pick<T>(items: readonly T[], random: Random): T {
	const draw = random();
	const value = Number.isFinite(draw) ? draw : 0;
	const index = Math.min(items.length - 1, Math.max(0, Math.floor(value * items.length)));
	return items[index];
}

function shuffled<T>(items: readonly T[], random: Random): T[] {
	const copy = [...items];
	for (let index = copy.length - 1; index > 0; index--) {
		const draw = random();
		const value = Number.isFinite(draw) ? draw : 0;
		const target = Math.min(index, Math.max(0, Math.floor(value * (index + 1))));
		[copy[index], copy[target]] = [copy[target], copy[index]];
	}
	return copy;
}

export function isSampleEntry(entry: Pick<Login, "tags">): boolean {
	return entry.tags.includes(SAMPLE_TAG);
}

export function hasSampleEntries(entries: readonly Pick<Login, "tags">[]): boolean {
	return entries.some(isSampleEntry);
}

/** Builds `count` clearly labelled examples with fresh ids and freshly generated passwords. */
export function buildSampleEntries(count = SAMPLE_COUNT, random: Random = Math.random): Login[] {
	const size = Math.min(services.length, Math.max(1, Math.trunc(count)));
	return shuffled(services, random).slice(0, size).map(service => ({
		id: crypto.randomUUID(),
		title: service.title,
		username: `${pick(accounts, random)}@example.invalid`,
		password: generatePassword(20),
		url: `https://${service.host}`,
		notes: "Beispieldaten von HeavenKey. Der Eintrag gehört zu keinem echten Konto und lässt sich in den Ersten Schritten wieder entfernen.",
		totp: "",
		tags: [SAMPLE_TAG],
		favorite: false,
	}));
}

/** Keeps real entries untouched and never overwrites a stored example twice. */
export function withSampleEntries(entries: readonly Login[], samples: readonly Login[]): Login[] {
	const used = new Set(entries.map(entry => entry.id));
	return [...entries, ...samples.filter(sample => !used.has(sample.id))];
}

export function withoutSampleEntries(entries: readonly Login[]): Login[] {
	return entries.filter(entry => !isSampleEntry(entry));
}
