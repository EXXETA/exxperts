// Smoke for the maintenance warning copy (apps/web-ui/src/maintenance-warnings.ts):
// the one place server warning vocabulary becomes sentences a person reads.
// Pins that every warning a maintenance run can emit has a sentence of its own —
// engine strings ("assessment missing Deep Memory change bullets", "the
// assessment was regenerated once (first attempt: …)") must never reach the
// screen with a capital letter glued on, and that a warning nobody has translated yet still
// arrives, capitalised, rather than disappearing.

import { describeMaintenanceWarning, formatAbsorbRunSaveError, isStaleMaintenanceMessage, meaningfulMaintenanceWarnings } from "../../web-ui/src/maintenance-warnings.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The exact shapes the server emits (absorb-consolidation.ts writes the first,
// persistent-agents.ts composes the retry disclosure).
const MISSING_SECTION = "assessment missing Deep Memory change bullets";
const REGENERATED = "the assessment was regenerated once (first attempt: assessment missing What to remember bullets; assessment missing What to forget bullets)";

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

// 4. Unknown warnings pass through, and the status line is not a warning.
{
	assert(describeMaintenanceWarning("something nobody translated yet") === "Something nobody translated yet", "an unknown warning passes through capitalised, never dropped");
	assert(meaningfulMaintenanceWarnings([MISSING_SECTION, "no memory has been written"]).length === 1, "the non-mutation status line is not a warning");
	assert(meaningfulMaintenanceWarnings([REGENERATED])[0].startsWith("The first assessment draft was"), "the list translates through the same branch");
}

// 5. A Memorize save that failed lands on the run's card, which has no draft
// and no proposal: every sentence names a way out that screen has.
{
	const stale = formatAbsorbRunSaveError("Recent Context proposal fingerprint changed; this memory proposal is stale");
	assert(stale.startsWith("Memory changed while this update was open. Nothing was saved."), `a stale save says what happened (got: ${stale})`);
	assert(stale.includes("Start Memorize again"), `and names the way out (got: ${stale})`);
	assert(!isStaleMaintenanceMessage("Recent Context entry count changed"), "a sentence no server writes any more is not read as a stale save");
	const gone = "That memory update is no longer open. Start Memorize again.";
	assert(formatAbsorbRunSaveError(gone) === gone, "the server's own sentence that names the way out passes through");
	const http = formatAbsorbRunSaveError("Request failed (502)");
	assert(http.includes("HTTP 502") && http.includes("Nothing was saved."), `a bare HTTP failure is a sentence (got: ${http})`);
	const other = formatAbsorbRunSaveError("This memory update has nothing to save.");
	assert(other.includes("Your memory is unchanged") && other.includes("Details: This memory update has nothing to save."), `anything else keeps the reassurance and the detail (got: ${other})`);
	for (const message of ["this memory proposal is stale", "the conversation this proposal came from is missing; this memory proposal is stale", "Request failed (413)", "assessmentHandoff.text is too large", "memory budget changed", "token growth exceeds the limit", "The file could not be saved to this room's Files."]) {
		const own = formatAbsorbRunSaveError(message).replace(message, "");
		assert(!/proposal|draft/i.test(own), `no save sentence says proposal or draft (got: ${own})`);
	}
}

console.log("maintenance warning copy smoke passed");
