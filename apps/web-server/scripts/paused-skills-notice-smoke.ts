// Smoke: the notice for skills a room paused because they changed
// (apps/web-ui/src/paused-skills.ts). A changed skill is not used until it is
// reviewed, and the room now says so on entering: once per change, in plain
// words, with the count for one or several. Each skill version is remembered
// per room once shown, so reviewing one of two does not repeat the notice for
// the other, and a further change of the same skill shows it again.

import assert from "node:assert/strict";
import { pausedSkills, pausedSkillsDecision, pausedSkillsWords } from "../../web-ui/src/paused-skills.js";
import type { PersistentRoomEnabledSkillStatus } from "../../web-ui/src/persistent-room-management-api.js";

const skill = (name: string, status: PersistentRoomEnabledSkillStatus["status"], currentSha256: string | null = `${name}-v2`): PersistentRoomEnabledSkillStatus => ({
	name,
	sha256: `${name}-v1`,
	currentSha256,
	status,
	executeState: "none",
});

// Only changed skills count: not the ones in use, not removed ones.
const mixed = [skill("pdf", "hash-mismatch"), skill("docx", "ok", "docx-v1"), skill("gone", "missing", null)];
assert.deepEqual(pausedSkills(mixed).map((s) => s.name), ["pdf"]);
assert.equal(pausedSkillsWords([]), null, "nothing paused, nothing said");

// The words, for one and for several.
assert.deepEqual(pausedSkillsWords(pausedSkills(mixed)), { text: "A skill changed, so this room paused it.", sub: "Review the new version to use it again." });
// One skill the server names is named, as the Skills pane names it.
assert.deepEqual(pausedSkillsWords([{ ...skill("meeting-notes", "hash-mismatch"), displayName: "Meeting notes" } as any]), { text: "“Meeting notes” changed, so this room paused it.", sub: "Review the new version to use it again." });
const two = [skill("pdf", "hash-mismatch"), skill("xlsx", "hash-mismatch")];
assert.deepEqual(pausedSkillsWords(two), { text: "2 skills changed, so this room paused them.", sub: "Review the new versions to use them again." });

// Once per change: the first entry shows it, the next does not.
const first = pausedSkillsDecision("room-a", two, []);
assert.ok(first.show, "shown on the first entry after the change");
assert.deepEqual(first.remember, ["room-a:pdf@pdf-v2", "room-a:xlsx@xlsx-v2"]);
assert.equal(pausedSkillsDecision("room-a", two, first.remember).show, null, "not again on the next entry");

// Reviewing one leaves the other paused, already shown: no repeat.
const oneLeft = [skill("pdf", "ok", "pdf-v2"), skill("xlsx", "hash-mismatch")];
assert.equal(pausedSkillsDecision("room-a", oneLeft, first.remember).show, null, "a review does not bring the notice back");

// A further change of a paused skill is news again.
const changedAgain = [skill("xlsx", "hash-mismatch", "xlsx-v3")];
const again = pausedSkillsDecision("room-a", changedAgain, first.remember);
assert.deepEqual(again.show?.text, "A skill changed, so this room paused it.");
assert.ok(again.remember.includes("room-a:xlsx@xlsx-v3"));

// Reference-only repository updates have distinct package versions even when instructions match.
const referenceChange = { ...skill("brand", "hash-mismatch", "same-manifest"), currentPackageSha256: "package-v2" };
const firstPackage = pausedSkillsDecision("room-a", [referenceChange], []);
assert.ok(firstPackage.show, "a reference-only update is announced");
assert.equal(pausedSkillsDecision("room-a", [referenceChange], firstPackage.remember).show, null, "the same package is not announced twice");
const nextPackage = { ...referenceChange, currentPackageSha256: "package-v3" };
assert.ok(pausedSkillsDecision("room-a", [nextPackage], firstPackage.remember).show, "another reference-only update is announced despite identical instructions");

// Another room with the same change has its own notice.
assert.ok(pausedSkillsDecision("room-b", two, first.remember).show, "each room says it for itself");

// What is remembered stays bounded, newest kept.
const many = Array.from({ length: 400 }, (_, i) => `room-x:s${i}@v`);
const bounded = pausedSkillsDecision("room-a", two, many).remember;
assert.equal(bounded.length, 300);
assert.deepEqual(bounded.slice(-2), ["room-a:pdf@pdf-v2", "room-a:xlsx@xlsx-v2"]);

console.log("paused skills notice smoke: ok");
