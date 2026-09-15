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
