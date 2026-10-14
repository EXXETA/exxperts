// What a person agreed in the Review discussion, carried into the run as instructions.

export interface ReviewGuidance {
	/** Notes or topics to leave exactly as they are. */
	keepAsIs: string[];
	/** Notes or topics to make shorter. */
	shorten: string[];
	/** Notes or topics to move to the archive, with the person's reason when given. */
	remove: string[];
	/** Answers the person gave to the first read's questions. */
	answers: string[];
	/** Any other instruction, one sentence each. */
	instructions: string[];
	/** Topic titles the tidy should cover; empty means every topic the first read flagged. */
	topics: string[];
}

export function emptyReviewGuidance(): ReviewGuidance {
	return { keepAsIs: [], shorten: [], remove: [], answers: [], instructions: [], topics: [] };
}

export function reviewGuidanceIsEmpty(guidance: ReviewGuidance): boolean {
	return Object.values(guidance).every((list) => list.length === 0);
}

export function reviewGuidanceFromWire(raw: unknown): ReviewGuidance {
	const out = emptyReviewGuidance();
	if (!raw || typeof raw !== "object") return out;
	for (const key of Object.keys(out) as Array<keyof ReviewGuidance>) {
		const value = (raw as Record<string, unknown>)[key];
		if (Array.isArray(value)) out[key] = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()).slice(0, 40);
	}
	return out;
}

const NOTE_ID = /\bm-\d{3,}\b/g;
const QUOTED = /["“‘]([^"”’]+)["”’]/g;
const wordsKey = (text: string) => text.toLowerCase().replace(/^\s*-\s*/, "").replace(/\*\*must-keep\*\*/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The "move to the archive" lines the run did not carry out: a line that names
 * a note (by its id, or by quoted words that start the note or are its words
 * before the colon) whose note is still in memory, and open if it is an item. A
 * line that names no one note claims nothing either way and is not listed. A
 * line is judged by its first id: a later one is in its reason.
 */
export function reviewRemovalsNotDone(remove: readonly string[], named: ReadonlyArray<{ id: string; text: string }>, after: ReadonlyArray<{ id: string; open: boolean }>): string[] {
	const stillThere = new Set(after.filter((entry) => entry.open).map((entry) => entry.id));
	return remove.filter((line) => {
		// The note the line names is its first id: a later one is in its reason ("already in [m-0010]").
		let ids = [...line.matchAll(NOTE_ID)].map((match) => match[0]).slice(0, 1);
		if (ids.length === 0) {
			const quoted = [...line.matchAll(QUOTED)].map((match) => wordsKey(match[1]!.replace(/(…|\.\.\.)\s*$/, ""))).filter((key) => key.length >= 8);
			const matches = named.filter((entry) => {
				const first = wordsKey(entry.text.split("\n")[0]!);
				const colon = entry.text.split("\n")[0]!.indexOf(":");
				const label = colon > 0 ? wordsKey(entry.text.split("\n")[0]!.slice(0, colon)) : "";
				return quoted.some((key) => first === key || label === key || first.startsWith(`${key} `));
			});
			if (matches.length !== 1) return false;
			ids = [matches[0]!.id];
		}
		return ids.some((id) => stillThere.has(id));
	});
}
