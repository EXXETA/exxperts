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

// Validator errors on a blocked approval are the last engine strings a person
// could meet; they describe the candidate memory, so they get sentences too.
export function describeValidationError(error: string): string {
	if (/Candidate (review target )?(L1b )?is empty/i.test(error)) return "The draft came back without the memory text.";
	if (/must not (include|contain) (Chronos|Recent Context)|must carry the Chronos section through unchanged|Chronos was not restored|Recent Context was not restored/i.test(error)) return "The draft touched a part of memory it must leave alone (the room's timeline or recent sessions).";
	if (/must not contain a Dropped material section/i.test(error)) return "The draft placed its list of dropped material inside the memory text, where approving would have saved that list into memory.";
	if (/topology|section.*order differs|order differs|must contain exactly/i.test(error)) return "The draft changed the set or order of memory sections, which is not allowed.";
	const growth = /grows .*?by ([\d.]+)%/i.exec(error);
	if (growth) return `The draft makes deep memory about ${growth[1]}% larger; Review is meant to tighten it.`;
	if (/must clear all Recent Context entries/i.test(error)) return "The draft left the recent sessions in place; Memorize is meant to clear them into deep memory.";
	if (/scaffolding/i.test(error)) return "The draft copied in its drafting instructions instead of memory content.";
	const missing = /missing (?:mandatory section: )?(Recent Context|Deep Memory|Active Items|Chronos)/i.exec(error);
	if (missing) return `The draft is missing a required memory section (${sectionLabel(missing[1])}).`;
	return error.charAt(0).toUpperCase() + error.slice(1);
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
	// The budget-enforcement retry disclosures (slice 4). The reason inside the
	// parentheses is the server's own size line; the sentence carries the part
	// a person needs — the draft landed over budget and was tried again.
	// [\s\S] not .: the parenthesized reason can be a provider error spanning
	// lines, and a non-match here would put the raw engine string on screen.
	const proposalRedrafted = /^the proposal was drafted again once \(first draft: ([\s\S]+?)\)(, but the second draft was not better, so the first is shown)?$/.exec(warning);
	if (proposalRedrafted) {
		const base = /memory budget/.test(proposalRedrafted[1])
			? "The first draft came back over the room’s memory budget, so it was drafted again to bring it back under."
			: "The first draft was not accepted, so it was drafted again.";
		return proposalRedrafted[2] ? `${base} The second draft was no better, so the first is shown.` : base;
	}
	const proposalNotRedrafted = /^the proposal could not be drafted again \(([\s\S]+)\), so the first draft is shown$/.exec(warning);
	if (proposalNotRedrafted) return `A second draft could not be generated (${proposalNotRedrafted[1]}), so the first draft is shown.`;
	const missingProposal = /^proposal missing (.+)$/.exec(warning);
	if (missingProposal) return `The draft is missing its "${missingProposal[1]}" section.`;
	if (/^proposal mode is not /.test(warning)) return "The draft came back in the wrong mode; review it with extra care or draft again.";
	if (/discussion token budget is approaching the limit/.test(warning)) return "This discussion is approaching its size limit.";
	return warning.charAt(0).toUpperCase() + warning.slice(1);
}
