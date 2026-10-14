// Server warnings are engine vocabulary ("assessment missing Deep Memory
// change bullets") written for logs and smokes. How the app got somewhere is
// for the diagnostics, never the screen: every warning goes to the console,
// and none is shown.

export function logMaintenanceWarnings(warnings: string[]): void {
	for (const warning of warnings) if (!/no memory has been written/i.test(warning)) console.info(`[maintenance] ${warning}`);
}

export function sectionLabel(section: string): string {
	switch (section) {
		case "Recent Context": return "Recent Sessions";
		case "What to remember": return "What should be preserved";
		case "What to forget": return "What can be cleared from recent sessions";
		default: return section;
	}
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
	if (/Request failed \(\d+\)/.test(message)) return "The server could not save this update. Nothing was saved. Try again in a moment.";
	console.info(`[maintenance] save: ${message}`);
	return "The memory update could not be saved. Your memory is unchanged and this update is still here. Try again in a moment.";
}
