// The "/" list's rules in a room's message box, run in plain node against the
// page's own module (apps/web-ui/src/skill-pick-list.ts): it opens only while
// the caret is in a "/" word at the very start of the draft; it offers the
// skills on in the room whose files can be read, a by-hand one with its tag;
// it filters by name, ignoring case, those that start with the text first;
// and a pick makes the first word "/name " and keeps the rest. The list in a
// live room is skill-pick-ui-smoke.ts. Offline.
import { draftAfterSkillPick, filterSkillPicks, skillPickEntries, skillPickQuery, type SkillPickEntry } from "../../web-ui/src/skill-pick-list.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
	assert(JSON.stringify(actual) === JSON.stringify(expected), `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// 1. Where it opens: a "/" word at the start, the caret in it.
same(skillPickQuery("/", 1), "", "a lone slash opens it with nothing typed");
same(skillPickQuery("/pd", 3), "pd", "the text after the slash");
same(skillPickQuery("/pdf fill the form", 2), "p", "the caret in the first word: the text before the caret");
same(skillPickQuery("/pdf fill the form", 5), null, "the caret past the first word closes it");
same(skillPickQuery("fill /pdf", 9), null, "a slash later in the text never opens it");
same(skillPickQuery(" /pdf", 5), null, "a slash after a space is not at the start");
same(skillPickQuery("/etc/hosts", 10), null, "a path's second slash closes it");
same(skillPickQuery("/etc", 4), "etc", "a path's first word still looks like a name");
same(skillPickQuery("", 0), null, "an empty box");
console.log("  ok  it opens only while the caret is in a '/' word at the draft's start");

// 2. What it offers: on in the room, readable, in the library's order; the tag from either side.
const library = [
	{ name: "pdf", description: "Fill PDF forms." },
	{ name: "letters", description: "Drafts the quarterly letter.", disableModelInvocation: true },
	{ name: "broken", description: "", unreadable: true },
	{ name: "off-skill", description: "Off in this room." },
	{ name: "marked-in-room", description: "The room's view says by hand." },
];
const room = [
	{ name: "marked-in-room", status: "ok", manualOnly: true },
	{ name: "letters", status: "ok", manualOnly: true },
	{ name: "pdf", status: "ok" },
	{ name: "broken", status: "unreadable" },
	{ name: "gone-from-library", status: "ok" },
];
const entries = skillPickEntries(library, room);
same(entries, [
	{ name: "pdf", description: "Fill PDF forms.", byHand: false },
	{ name: "letters", description: "Drafts the quarterly letter.", byHand: true },
	{ name: "marked-in-room", description: "The room's view says by hand.", byHand: true },
], "the skills on in the room, readable, in the library's order");
same(skillPickEntries(library, []), [], "nothing on: nothing offered");
same(skillPickEntries([{ name: "pdf", description: "x", unreadable: true }], [{ name: "pdf", status: "ok" }]), [], "the library can't read it, though the room's view says ok: not offered");
console.log("  ok  it offers the skills on in the room whose files can be read, a by-hand one marked");

// 3. Filtering: ignoring case, starts-with first, then holds.
const pool: SkillPickEntry[] = ["report-pdf", "pdf", "letters", "PDF-tools"].map((name) => ({ name, description: "", byHand: false }));
same(filterSkillPicks(pool, "").map((entry) => entry.name), ["report-pdf", "pdf", "letters", "PDF-tools"], "nothing typed: every skill, in order");
same(filterSkillPicks(pool, "pdf").map((entry) => entry.name), ["pdf", "PDF-tools", "report-pdf"], "names that start with it, then names that hold it");
same(filterSkillPicks(pool, "Let").map((entry) => entry.name), ["letters"], "case is ignored");
same(filterSkillPicks(pool, "zzz"), [], "nothing fits: no list");
console.log("  ok  it filters by name, ignoring case, starts-with first");

// 4. A pick: the first word becomes "/name ", the rest stays, the caret after the space.
same(draftAfterSkillPick("/pd", "pdf"), { draft: "/pdf ", caret: 5 }, "a pick on a bare word");
same(draftAfterSkillPick("/pd fill the form", "pdf"), { draft: "/pdf fill the form", caret: 5 }, "the rest stays, one space between");
same(draftAfterSkillPick("/   fill it", "letters"), { draft: "/letters fill it", caret: 9 }, "the spaces after the word go");
same(draftAfterSkillPick("/x\nsecond line", "pdf"), { draft: "/pdf \nsecond line", caret: 5 }, "a line break after the word stays");
console.log("  ok  a pick puts '/name ' first and keeps the rest");

console.log("skill-pick-list smoke: all rows passed");
