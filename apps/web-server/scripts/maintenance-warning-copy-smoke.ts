// Smoke for the maintenance warning copy (apps/web-ui/src/maintenance-warnings.ts):
// the one place server warning vocabulary becomes sentences a person reads.
// Pins that every warning a maintenance run can emit has a sentence of its own —
// engine strings ("assessment missing Deep Memory change bullets", "the proposal
// was drafted again once (first draft: …)") must never reach the screen with a
// capital letter glued on — and that a warning nobody has translated yet still
// arrives, capitalised, rather than disappearing.

import { describeMaintenanceWarning, meaningfulMaintenanceWarnings } from "../../web-ui/src/maintenance-warnings.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The exact shapes the server emits (absorb-consolidation.ts writes the first
// two, persistent-agents.ts composes the retry disclosures).
const MISSING_SECTION = "assessment missing Deep Memory change bullets";
const MISSING_PROPOSAL_SECTION = "proposal missing Compression Metrics";
const REGENERATED = "the assessment was regenerated once (first attempt: assessment missing What to remember bullets; assessment missing What to forget bullets)";
const REDRAFTED = "the proposal was drafted again once (first draft: the candidate is over the room's memory budget by ~4100 estimated tokens)";
const REDRAFT_FAILED = "the proposal could not be drafted again (the provider returned 503), so the first draft is shown";

// 1. A section the assessment came back without reads as a sentence.
{
	const sentence = describeMaintenanceWarning(MISSING_SECTION);
	assert(!sentence.startsWith("Assessment missing"), `the server prefix must not reach the screen (got: ${sentence})`);
	assert(sentence.startsWith('The assessment\'s "Deep Memory" section came back empty'), `the sentence names the section a person knows (got: ${sentence})`);
	assert(sentence.includes("The rest of the assessment is intact."), "and it says what is still usable");
}

// 2. The section names a person reads are the product's, not the engine's.
{
	const sentence = describeMaintenanceWarning("assessment missing What to forget bullets");
	assert(sentence.includes("What can be cleared from recent sessions"), `the engine's section name is translated (got: ${sentence})`);
}

// 3. A regenerated assessment says why, in the reasons a person can act on.
{
	const sentence = describeMaintenanceWarning(REGENERATED);
	assert(!sentence.startsWith("The assessment was regenerated"), `the server string must not reach the screen (got: ${sentence})`);
	assert(sentence.startsWith("The first assessment draft was"), `the sentence owns the subject (got: ${sentence})`);
	assert(sentence.includes('"What should be preserved"') && sentence.includes('"What can be cleared from recent sessions"'), "and it names the sections in the product's words");
	const notBetter = describeMaintenanceWarning(`${REGENERATED}, but the second attempt was not better, so the first is shown`);
	assert(notBetter.includes("The second attempt was no better, so the first is shown."), `a second attempt that did not help is said out loud (got: ${notBetter})`);
}

// 4. The budget redraft disclosures read as sentences, both ways round.
{
	const redrafted = describeMaintenanceWarning(REDRAFTED);
	assert(redrafted.startsWith("The first draft came back over the room’s memory budget"), `a budget redraft names the budget (got: ${redrafted})`);
	const failed = describeMaintenanceWarning(REDRAFT_FAILED);
	assert(failed.startsWith("A second draft could not be generated (the provider returned 503)"), `a redraft that never happened keeps the cause (got: ${failed})`);
	assert(describeMaintenanceWarning(MISSING_PROPOSAL_SECTION) === 'The draft is missing its "Compression Metrics" section.', "a proposal section that never arrived is named");
}

// 5. Unknown warnings pass through, and the status line is not a warning.
{
	assert(describeMaintenanceWarning("something nobody translated yet") === "Something nobody translated yet", "an unknown warning passes through capitalised, never dropped");
	assert(meaningfulMaintenanceWarnings([MISSING_SECTION, "no memory has been written"]).length === 1, "the non-mutation status line is not a warning");
	assert(meaningfulMaintenanceWarnings([REGENERATED])[0].startsWith("The first assessment draft was"), "the list translates through the same branch");
}

console.log("maintenance warning copy smoke passed");
