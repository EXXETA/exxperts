import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The room pane's ONE outcome table (apps/web-ui/src/room-instructions-outcome.ts)
// says what the room does after Save, the Save of an empty box (a removal on the
// server) or a flip of the global switch.
// This smoke holds those sentences to the server's real behaviour: for every
// (and the hint under the switch, switchHint, from the same module). For every
// combination of this room's file (text / absent / a folder / a dangling link), the global file (absent /
// text / a folder) and the switch (on / off), the sentence about a conversation
// that is already open must agree with whether the per-turn section speaks, and
// the sentence about new conversations with what a fresh boot carries.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-global-instructions-pane-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-global-instructions-pane-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
delete process.env.EXXPERTS_STATE_HOME;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const { globalOutcomeAfter, outcomeAfter, switchHint } = await import("../../web-ui/src/room-instructions-outcome.js");
// A namespace import: on a tree without the Clear and Undo helper this smoke fails at an assertion, not at the loader.
const paneShared = await import("../../web-ui/src/components/instructions-pane-shared.js") as Record<string, unknown>;
const { buildPersistentRoomCurrentInstructionsSection, composePersistentRoomInstructions, globalInstructionsPath, persistentRoomInstructionsPath, writeGlobalInstructions, writePersistentRoomInstructions, GLOBAL_INSTRUCTIONS_SECTION_HEADING } = await import("../src/persistent-room-instructions.js");
const { writePersistentRoomGlobalInstructionsEnabled } = await import("../src/persistent-room-global-instructions-setting.js");
const { buildPersistentAgentBootContext, createPersistentAgentFromScaffoldInput, getPersistentRoomInstructionsView } = await import("../src/persistent-agents.js");

const agentId = "global-instructions-pane-smoke";
const model = { provider: "anthropic", model: "claude-sonnet-5" };
const roomText = "Answer in German.";
const globalText = "Be terse.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

type FileState = "text" | "folder" | "absent" | "link";
function setFile(file: string, state: FileState, text: string): void {
	fs.rmSync(file, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(file), { recursive: true });
	if (state === "text") fs.writeFileSync(file, `${text}\n`, "utf-8");
	if (state === "folder") fs.mkdirSync(file);
	if (state === "link") fs.symlinkSync(path.join(path.dirname(file), "no-such-target.md"), file);
}

function freshBoot(): { hasLayer: boolean; hasGlobal: boolean; hasRoom: boolean } {
	const layer = buildPersistentAgentBootContext({ agentId, conversationId: "conv", sessionId: null, model }).layers.find((entry) => entry.id === "instructions")?.content ?? "";
	return { hasLayer: layer.length > 0, hasGlobal: layer.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING), hasRoom: layer.includes(roomText) || layer.includes("saved now") };
}

let checks = 0;
try {
	createPersistentAgentFromScaffoldInput({ displayName: "Global Instructions Pane Smoke", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const roomFile = persistentRoomInstructionsPath(agentId);
	const globalFile = globalInstructionsPath();
	const actions = ["save", "saveEmpty", "on", "off"] as const;
	for (const roomBefore of ["text", "absent", "folder", "link"] as FileState[]) {
		for (const globalState of ["absent", "text", "folder"] as FileState[]) {
			for (const switchBefore of [true, false]) {
				for (const action of actions) {
					// A save, empty or not, over a folder is refused by the writer with its own sentence, so the
					// result sentence is never shown; over a dangling link or a file the app may not read it
					// goes through, and those rows are exactly the ones that must be checked.
					if (roomBefore === "folder" && (action === "save" || action === "saveEmpty")) continue;
					const label = `room=${roomBefore} global=${globalState} switch=${switchBefore ? "on" : "off"} action=${action}`;
					setFile(roomFile, roomBefore, roomText);
					setFile(globalFile, globalState, globalText);
					writePersistentRoomGlobalInstructionsEnabled(agentId, switchBefore);
					const before = composePersistentRoomInstructions(agentId);
					// The action, with the real writers.
					if (action === "save") writePersistentRoomInstructions(agentId, `${roomText} And saved now.`);
					if (action === "saveEmpty") writePersistentRoomInstructions(agentId, "");
					if (action === "on") writePersistentRoomGlobalInstructionsEnabled(agentId, true);
					if (action === "off") writePersistentRoomGlobalInstructionsEnabled(agentId, false);
					const viewAfter = getPersistentRoomInstructionsView(agentId);
					const sentence = outcomeAfter(viewAfter, action);
					const after = composePersistentRoomInstructions(agentId);
					// What an open conversation booted before the action is told now.
					const section = buildPersistentRoomCurrentInstructionsSection(agentId, "", { bootedFingerprint: before.fingerprint });
					const changed = before.fingerprint !== after.fingerprint;
					const claimsOpenKeeps = /open conversation keeps its text|open conversation catches up/.test(sentence);
					const claimsNextMessage = /next message/.test(sentence);
					// The lead says what was done, and the plain rows are the short sentences, word for word.
					const lead = action === "on" ? "Switched on." : action === "off" ? "Switched off." : "Saved.";
					assert(sentence.startsWith(`${lead} `) || sentence === lead, `${label}: the result must open with "${lead}" (${sentence})`);
					if (action === "saveEmpty") {
						assert(sentence.startsWith("Saved. This room has no instructions of its own."), `${label}: an empty save says the room has no instructions of its own (${sentence})`);
						assert(!viewAfter.instructions.text && !viewAfter.instructions.unreadable, `${label}: an empty save leaves no text and nothing unreadable`);
						assert(!claimsNextMessage, `${label}: an empty save says what is left, not a timing (${sentence})`);
					}
					if (!claimsOpenKeeps && action !== "saveEmpty" && !/No global instructions are written yet/.test(sentence)) assert(sentence === `${lead} Applies from the next message.`, `${label}: a plain row is the lead and the one timing sentence (${sentence})`);
					if (changed) {
						assert(claimsOpenKeeps === (section === ""), `${label}: the sentence about an open conversation must match the per-turn section (section ${section === "" ? "silent" : "speaks"}, sentence: ${sentence})`);
						if (claimsNextMessage) assert(section !== "", `${label}: "next message" promised but the per-turn section is silent`);
					}
					// What a new conversation carries.
					const boot = freshBoot();
					if (/start without instructions/.test(sentence) || sentence === "Saved. This room has no instructions of its own.") assert(!boot.hasLayer, `${label}: the sentence says nothing is left but a fresh boot carries a layer`);
					if (/follows? the global instructions/.test(sentence)) assert(boot.hasGlobal, `${label}: the sentence names the global instructions but a fresh boot has none (${sentence})`);
					if (/follow(s)? (these|this room's own) instructions/.test(sentence)) assert(boot.hasRoom, `${label}: the sentence names this room's text but a fresh boot has none`);
					if (/It follows the global instructions/.test(sentence)) assert(!boot.hasRoom, `${label}: "no instructions of its own" but the room's text boots`);
					if (/No global instructions are written yet/.test(sentence)) assert(!boot.hasGlobal && !changed, `${label}: "none written yet" but they are in the boot or the flip changed what the room follows`);
					// The hint under the switch, on the same view the result came from: its claims about new
					// conversations against the fresh boot, and its "keeps what it started with" against the
					// per-turn section when the action was an edit of this room's text.
					const hint = switchHint(viewAfter);
					if (/New conversations start without instructions/.test(hint)) assert(!boot.hasLayer, `${label}: the hint says new conversations start without instructions but a fresh boot carries a layer`);
					if (/start with this room's own instructions/.test(hint)) assert(boot.hasRoom && !boot.hasGlobal, `${label}: the hint says new conversations start with this room's own text but a fresh boot disagrees`);
					if (/this room's own instructions win|^This room follows them\.$/.test(hint)) assert(boot.hasGlobal, `${label}: the hint says the room follows the global instructions but a fresh boot has none`);
					if (/this room's own instructions win/.test(hint)) assert(boot.hasRoom, `${label}: the hint speaks of this room's own instructions but a fresh boot has none`);
					if (/^This room follows them\.$/.test(hint)) assert(!boot.hasRoom, `${label}: the hint names only the global instructions but this room's text boots`);
					if (/follows only its own instructions/.test(hint)) assert(!boot.hasGlobal, `${label}: the hint says only its own but the global text boots`);
					if (/None are written yet/.test(hint)) assert(!boot.hasGlobal && !viewAfter.global.instructions.text, `${label}: the hint says none are written but there is a global text`);
					if (/keeps what it started with/.test(hint) && changed && (action === "save" || action === "saveEmpty")) assert(section === "", `${label}: the hint says an open conversation keeps its text through a room edit, but the per-turn section speaks`);
					checks += 1;
				}
			}
		}
	}
	// The older-server shape: no global field at all reads as no global text.
	assert(outcomeAfter({ instructions: { text: "", fingerprint: null, updatedAt: null } }, "saveEmpty") === "Saved. This room has no instructions of its own.", "an older server's view saves empty to nothing");
	assert(outcomeAfter(null, "save") === "Saved. Applies from the next message.", "no view yet: the plain sentence");
	// Settings → Instructions, from the same module: a save, then the empty save the server treats as a removal.
	setFile(roomFile, "absent", roomText);
	setFile(globalFile, "absent", globalText);
	writePersistentRoomGlobalInstructionsEnabled(agentId, true);
	assert(globalOutcomeAfter(writeGlobalInstructions(globalText).text) === "Saved. Applies from the next message." && freshBoot().hasGlobal, "a global save applies and boots");
	assert(globalOutcomeAfter(writeGlobalInstructions("").text) === "Saved. There are no global instructions." && !freshBoot().hasLayer, "an empty global save leaves no global instructions");
	// Clear turns into Undo: the rule both panes share, as plain values.
	type Box = { draft: string; remembered: string | null };
	type BoxEvent = { type: "link" } | { type: "type"; value: string } | { type: "save" } | { type: "reload"; value: string };
	type Link = { label: string; disabled: boolean } | null;
	assert(typeof paneShared.reduceInstructionsBox === "function" && typeof paneShared.instructionsClearLink === "function", "the panes' shared module exports the Clear and Undo rule (reduceInstructionsBox, instructionsClearLink)");
	const reduce = paneShared.reduceInstructionsBox as (state: Box, event: BoxEvent) => Box;
	const link = paneShared.instructionsClearLink as (state: Box, saving: boolean) => Link;
	const emptyBox = paneShared.EMPTY_INSTRUCTIONS_BOX as Box;
	assert(emptyBox.draft === "" && emptyBox.remembered === null && link(emptyBox, false) === null, "an empty box with nothing remembered shows no link");
	assert(reduce(emptyBox, { type: "link" }) === emptyBox, "a click with no link changes nothing");
	// Clear then Undo: the exact draft, an unsaved edit and odd bytes included.
	const oddDraft = "Answer in German.\r\n\tIndented, then an emoji \u{1F600} and an unsaved edit \n\n";
	const loadedBox = reduce(emptyBox, { type: "reload", value: "Answer in German." });
	const editedBox = reduce(loadedBox, { type: "type", value: oddDraft });
	assert(link(editedBox, false)?.label === "Clear" && link(editedBox, false)?.disabled === false, "a box with text reads Clear");
	const clearedBox = reduce(editedBox, { type: "link" });
	assert(clearedBox.draft === "" && clearedBox.remembered === oddDraft, "Clear empties the box and remembers what it held, the unsaved edit included");
	assert(link(clearedBox, false)?.label === "Undo" && link(clearedBox, false)?.disabled === false, "after Clear the link reads Undo");
	const undoneBox = reduce(clearedBox, { type: "link" });
	assert(undoneBox.draft === oddDraft && Buffer.from(undoneBox.draft, "utf-8").equals(Buffer.from(oddDraft, "utf-8")) && undoneBox.remembered === null, "Undo puts the text back byte for byte and drops what was remembered");
	assert(link(undoneBox, false)?.label === "Clear", "after Undo the link reads Clear again");
	// Typing after Clear ends the offer, and the link follows the box.
	const typedBox = reduce(clearedBox, { type: "type", value: "N" });
	assert(typedBox.draft === "N" && typedBox.remembered === null && link(typedBox, false)?.label === "Clear", "typing after Clear ends the offer: Clear for the new text");
	const typedEmptyBox = reduce(typedBox, { type: "type", value: "" });
	assert(typedEmptyBox.remembered === null && link(typedEmptyBox, false) === null, "typed back to empty after the offer ended: no link, and no Undo for the old text");
	// A second Clear after typing remembers the new text, not the first.
	const secondClearBox = reduce(reduce(clearedBox, { type: "type", value: "New text.\n" }), { type: "link" });
	assert(secondClearBox.draft === "" && secondClearBox.remembered === "New text.\n" && reduce(secondClearBox, { type: "link" }).draft === "New text.\n", "a second Clear after typing remembers the new text");
	// Save after Clear ends the offer, before the request and whatever its result; so does a reload.
	const savedBox = reduce(clearedBox, { type: "save" });
	assert(savedBox.draft === "" && savedBox.remembered === null && link(savedBox, false) === null, "Save after Clear ends the offer and leaves the box as it is");
	assert(reduce(editedBox, { type: "save" }).draft === oddDraft, "Save with nothing remembered leaves the draft alone");
	const reloadedBox = reduce(clearedBox, { type: "reload", value: "From another tab." });
	assert(reloadedBox.draft === "From another tab." && reloadedBox.remembered === null && link(reloadedBox, false)?.label === "Clear", "a reload ends the offer and sets the box from the server");
	// Disabled while saving, in both words; never hidden by saving.
	assert(link(editedBox, true)?.label === "Clear" && link(editedBox, true)?.disabled === true, "Clear is disabled while saving");
	assert(link(clearedBox, true)?.label === "Undo" && link(clearedBox, true)?.disabled === true, "Undo is disabled while saving");
	assert(link(emptyBox, true) === null, "no link while saving an empty box with nothing remembered");
	console.log(`global-instructions pane copy smoke: ok (${checks} state/action combinations)`);
} finally {
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
}
