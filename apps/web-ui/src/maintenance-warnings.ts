// Server warnings and validator errors are engine vocabulary ("assessment
// missing Deep Memory change bullets") written for logs and smokes; this
// module is the one place they are turned into sentences before a person
// reads them. Unknown warnings pass through with a capital letter, never
// dropped.

export function meaningfulMaintenanceWarnings(warnings: string[]): string[] {
	return warnings.filter((warning) => !/no memory has been written/i.test(warning)).map((warning) => describeMaintenanceWarning(warning));
}

export function sectionLabel(section: string): string {
	switch (section) {
		case "Recent Context": return "Recent Sessions";
		case "What to remember": return "What should be preserved";
		case "What to forget": return "What can be cleared from recent sessions";
		default: return section;
	}
}

export function describeMaintenanceWarning(warning: string): string {
	const missingAssessment = /^assessment missing (.+?)(?: change)?(?: bullets)?$/.exec(warning);
	if (missingAssessment) return `The assessment's "${sectionLabel(missingAssessment[1])}" section came back empty, so it shows as empty here. The rest of the assessment is intact.`;
	const regenerated = /^the assessment was regenerated once \(first attempt: (.+?)\)(, but the second attempt was not better, so the first is shown)?$/.exec(warning);
	if (regenerated) {
		const reasons: string[] = [];
		if (/characters long/.test(regenerated[1])) reasons.push("too long");
		const missing = [...regenerated[1].matchAll(/assessment missing (.+?)(?: change)?(?: bullets)?(?=;|$)/g)].map((match) => `"${sectionLabel(match[1])}"`);
		if (missing.length) reasons.push(`missing its ${missing.join(" and ")} ${missing.length === 1 ? "section" : "sections"}`);
		const base = `The first assessment draft was ${reasons.join(" and ") || "incomplete"}, so it was regenerated once.`;
		return regenerated[2] ? `${base} The second attempt was no better, so the first is shown.` : base;
	}
	const notRegenerated = /^the assessment could not be regenerated \(([\s\S]+)\), so the first attempt is shown$/.exec(warning);
	if (notRegenerated) return `A second assessment draft could not be generated (${notRegenerated[1]}), so the first attempt is shown.`;
	if (/discussion token budget is approaching the limit/.test(warning)) return "This discussion is approaching its size limit.";
	return warning.charAt(0).toUpperCase() + warning.slice(1);
}

// Matches only the server's actual concurrent-change messages; bare substrings
// like "stale" or "source" would misclassify unrelated transient errors.
export function isStaleMaintenanceMessage(message: string): boolean {
	return /fingerprint changed|source is stale|proposal is stale/i.test(message);
}

// A Memorize save that failed lands back on the run's card, so every sentence
// names a way out that exists from there: start Memorize again, or try the
// save again. The save's request is only the run's id, so none of the first
// read's or the discussion's refusals can reach it.
export function formatAbsorbRunSaveError(message: string): string {
	if (isStaleMaintenanceMessage(message)) return "Memory changed while this update was open. Nothing was saved. Start Memorize again to work from the latest memory.";
	// The server's own refusal that already names the way out (a run that is gone).
	if (/Start Memorize again\.?$/.test(message)) return message;
	const httpStatus = /Request failed \((\d+)\)/.exec(message);
	if (httpStatus) return `The server could not save this update (HTTP ${httpStatus[1]}). Nothing was saved. Try again in a moment.`;
	return `The memory update could not be saved. Your memory is unchanged and this update is still here. Details: ${message}`;
}
