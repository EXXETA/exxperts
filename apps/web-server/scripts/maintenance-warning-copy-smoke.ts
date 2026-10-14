// Smoke for the maintenance warning copy (apps/web-ui/src/maintenance-warnings.ts).
// Server warnings are engine vocabulary: none reaches the screen, every one
// goes to the console. A save that failed says what happened in plain words,
// with no status code and no raw detail.

import { formatAbsorbRunSaveError, isStaleMaintenanceMessage, logMaintenanceWarnings } from "../../web-ui/src/maintenance-warnings.js";
import * as warningCopy from "../../web-ui/src/maintenance-warnings.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// 1. Warnings go to the console, never the screen; the status line is not logged.
{
	const logged: string[] = [];
	const info = console.info;
	console.info = (line: string) => { logged.push(line); };
	try { logMaintenanceWarnings(["assessment missing Deep Memory change bullets", "no memory has been written"]); } finally { console.info = info; }
	assert(logged.length === 1 && logged[0].includes("assessment missing"), `one warning logged, got ${JSON.stringify(logged)}`);
	assert(!("meaningfulMaintenanceWarnings" in warningCopy) && !("describeMaintenanceWarning" in warningCopy), "nothing turns a warning into a line on screen");
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
	assert(!/HTTP|502/.test(http) && http.includes("Nothing was saved."), `a bare HTTP failure is a plain sentence (got: ${http})`);
	const other = formatAbsorbRunSaveError("ENOENT: something raw");
	assert(other.includes("Your memory is unchanged") && !/ENOENT|Details/.test(other), `anything else keeps the reassurance, never the detail (got: ${other})`);
	for (const message of ["this memory proposal is stale", "the conversation this proposal came from is missing; this memory proposal is stale", "Request failed (413)", "assessmentHandoff.text is too large", "memory budget changed", "token growth exceeds the limit", "The file could not be saved to this room's Files."]) {
		const own = formatAbsorbRunSaveError(message).replace(message, "");
		assert(!/proposal|draft/i.test(own), `no save sentence says proposal or draft (got: ${own})`);
	}
}

console.log("maintenance warning copy smoke passed");
