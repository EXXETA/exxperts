// Smoke for the words the Memorize and Review cards add when the demotion
// order carries a reason on every row (apps/web-ui/src/memory-surface-copy.ts).
// Two sentences are pinned: the one the card shows when open items were kept
// while the limit was still not met, and the History label of an archived
// note, which now carries the ranking's reason after the archive reason. The
// older label and the archive list's meta line must not move.
//
// Run: npx tsx scripts/memory-card-copy-smoke.ts

import { archivedLabel, archiveRowMeta, protectedOpenItemsSentence } from "../../web-ui/src/memory-surface-copy.js";

let checks = 0;
let failed = 0;

function check(condition: unknown, message: string): void {
	checks += 1;
	if (condition) return;
	failed += 1;
	console.error(`FAIL: ${message}`);
}

check(protectedOpenItemsSentence(0) === "", `no open items were held back: no sentence (got: ${JSON.stringify(protectedOpenItemsSentence(0))})`);
check(protectedOpenItemsSentence(1) === "1 open item is kept; close it to free room.", `one open item, singular (got: ${JSON.stringify(protectedOpenItemsSentence(1))})`);
check(protectedOpenItemsSentence(3) === "3 open items are kept; close them to free room.", `several open items, plural (got: ${JSON.stringify(protectedOpenItemsSentence(3))})`);
check(protectedOpenItemsSentence(1200) === "1,200 open items are kept; close them to free room.", `a large count reads with its thousands separator (got: ${JSON.stringify(protectedOpenItemsSentence(1200))})`);

check(archivedLabel("budget") === "archived · to make room", `an archived note without a reason reads as before (got: ${JSON.stringify(archivedLabel("budget"))})`);
check(archivedLabel(undefined) === "archived" && archivedLabel(null) === "archived" && archivedLabel("") === "archived", "an archived note with no archive reason says only that it was");
check(archivedLabel("budget", "not touched since 2 Mar, never recalled") === "archived · to make room · not touched since 2 Mar, never recalled", `the ranking's reason follows the archive reason (got: ${JSON.stringify(archivedLabel("budget", "not touched since 2 Mar, never recalled"))})`);
check(archivedLabel("superseded", "") === "archived · replaced", `an empty reason leaves no trailing separator (got: ${JSON.stringify(archivedLabel("superseded", ""))})`);
check(archivedLabel("superseded", "   ") === "archived · replaced", `a blank reason leaves no trailing separator (got: ${JSON.stringify(archivedLabel("superseded", "   "))})`);
check(archivedLabel(undefined, "done item from May, never recalled") === "archived · done item from May, never recalled", `a reason without an archive reason still follows the word (got: ${JSON.stringify(archivedLabel(undefined, "done item from May, never recalled"))})`);

check(archiveRowMeta("2026-09-13", "budget") === "archived 13 Sep · to make room", `the archive list's meta line is unchanged (got: ${JSON.stringify(archiveRowMeta("2026-09-13", "budget"))})`);
check(archiveRowMeta("2026-09-13", "superseded") === "archived 13 Sep · replaced", `the archive list's meta line names the archive reason only (got: ${JSON.stringify(archiveRowMeta("2026-09-13", "superseded"))})`);

console.log(`memory-card-copy-smoke: ${checks - failed}/${checks} checks passed`);
if (failed > 0) process.exit(1);
