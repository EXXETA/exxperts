import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Isolated HOME (the global text and the room locks live under the
// product state path) and an isolated agents root, so nothing here touches
// the developer's rooms or their own global instructions.
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-global-instructions-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-global-instructions-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
delete process.env.EXXPERTS_STATE_HOME;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	buildPersistentRoomCurrentInstructionsSection,
	buildPersistentRoomInstructionsLayer,
	composePersistentRoomInstructions,
	fingerprintPersistentRoomInstructions,
	GLOBAL_INSTRUCTIONS_SECTION_HEADING,
	globalInstructionsPath,
	readGlobalInstructions,
	ROOM_INSTRUCTIONS_SECTION_HEADING,
	writeGlobalInstructions,
	writePersistentRoomInstructions,
} = await import("../src/persistent-room-instructions.js");
const { parsePersistentRoomInstructionsMarker, persistentRoomInstructionsMarkerLine, ROOM_INSTRUCTIONS_MAX_CHARS } = await import("../src/persistent-room-instructions-text.js");
const {
	persistentRoomGlobalInstructionsSettingPath,
	readPersistentRoomGlobalInstructionsEnabled,
	readPersistentRoomGlobalInstructionsSetting,
	writePersistentRoomGlobalInstructionsEnabled,
} = await import("../src/persistent-room-global-instructions-setting.js");
const {
	assertPersistentAgentBootPromptFitsWindow,
	buildPersistentAgentBootContext,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentRoomInstructionsView,
	persistentAgentPlatformKernel,
	readPersistentAgentBootPromptSnapshot,
	savePersistentRoomGlobalInstructionsEnabled,
	savePersistentRoomInstructions,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { buildConsultPrompt } = await import("../src/consult.js");
const { preparePersistentRoomBackgroundExecution } = await import("../src/persistent-room-background-execution.js");
const { classifyRemoteRoute } = await import("../src/remote-route-policy.js");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const roomLock = createRequire(import.meta.url)(path.join(__dirname, "..", "..", "..", "bin", "lib", "room-lock.cjs")) as {
	tryAcquire: (agentId: string, owner: { surface: string; pid?: number; lockId?: string }) => { ok: boolean };
	release: (agentId: string, owner: { surface: string; pid?: number; lockId?: string }) => void;
};

const roomA = "global-instructions-smoke-a";
const roomB = "global-instructions-smoke-b";
const model = { provider: "anthropic", model: "claude-sonnet-5" };
const stamp = new Date("2026-09-17T10:00:00.000Z");

/** The framing's sentence on memory, word for word, and where it must stand: after the working-style sentence, before the kernel and Limits sentence. */
const OVER_MEMORY = "Where a note in this room's memory disagrees with these instructions about how to work (language, format, style, when to ask), these instructions apply; memory still decides what is true.";
function ranksOverMemoryInOrder(layerText: string): boolean {
	const style = layerText.indexOf("these instructions win.");
	const memory = layerText.indexOf(OVER_MEMORY);
	const kernel = layerText.indexOf("The platform kernel and the constitution's Limits still come first");
	const latest = layerText.indexOf("the user's latest message in the conversation takes precedence over any standing instruction");
	return style >= 0 && memory > style && kernel > memory && latest > kernel && layerText.indexOf(OVER_MEMORY, memory + 1) === -1;
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function assertThrows(fn: () => unknown, expectedMessage: string, label: string): Error {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(message.includes(expectedMessage), `${label}: expected error to include "${expectedMessage}", got "${message}"`);
		return error as Error;
	}
	throw new Error(`${label}: expected an error`);
}

function boot(agentId: string) {
	return buildPersistentAgentBootContext({ agentId, conversationId: "conv-1", sessionId: null, model });
}

/** Everything the boot prompt says except the runtime envelope, which carries the clock. */
function bootWithoutL2(context: ReturnType<typeof boot>): string {
	return context.layers.filter((layer) => layer.id !== "l2").map((layer) => layer.content).join("\n\n---\n\n");
}

function instructionsLayer(context: ReturnType<typeof boot>): string | null {
	return context.layers.find((layer) => layer.id === "instructions")?.content ?? null;
}

const overflowMessage = (run: () => unknown): string => {
	try { run(); } catch (error) { return String((error as Error).message); }
	throw new Error("expected a refusal");
};

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Global Instructions Smoke A", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	createPersistentAgentFromScaffoldInput({ displayName: "Global Instructions Smoke B", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const globalFile = globalInstructionsPath();
	assert(globalFile === path.join(tempHome, ".exxperts", "app", "instructions.md"), "the global text lives under the app's state folder, named like a room's");
	const roomText = "Answer in German. Open every answer with ERSTENS.";
	const globalText = "Be terse. Ask before assuming. Never invent a date.";

	// --- The global store: same three states, same rules, its own path ---
	const noneGlobal = readGlobalInstructions();
	assert(noneGlobal.text === "" && noneGlobal.fingerprint === null && noneGlobal.updatedAt === null && noneGlobal.unreadable === undefined, "an absent global file reads as none");
	assert(!fs.existsSync(globalFile), "reading must not create it");
	const writtenGlobal = writeGlobalInstructions(`\r\n${globalText}\r\n`, {}, stamp);
	assert(writtenGlobal.text === globalText && writtenGlobal.fingerprint === fingerprintPersistentRoomInstructions(globalText) && writtenGlobal.updatedAt === stamp.toISOString(), "the global write normalizes, fingerprints and stamps like a room's");
	assert(fs.readFileSync(globalFile, "utf-8") === `${globalText}\n`, "the file holds the normalized text");
	assertThrows(() => writeGlobalInstructions("z".repeat(ROOM_INSTRUCTIONS_MAX_CHARS + 1)), "the limit is 8,000", "the global text has the same cap");
	assert(readGlobalInstructions().text === globalText, "a refused save leaves the previous global text");
	assertThrows(() => writeGlobalInstructions("a\x00b"), "invisible control character", "and the same control-character rule");
	assert(writeGlobalInstructions("").fingerprint === null && !fs.existsSync(globalFile), "an empty save removes the global file");
	fs.mkdirSync(globalFile);
	try {
		assert(readGlobalInstructions().unreadable === "it is a folder, not a file", "a folder at the global path reads as unreadable, with the same sentence");
		const overFolder = assertThrows(() => writeGlobalInstructions("replace it"), "there is a folder where the global instructions file belongs; remove that folder, then try again", "a save over that folder is refused with a remedy that names which file");
		assert((overFolder as any).statusCode === 400, "and is the client's to fix");
	} finally {
		fs.rmdirSync(globalFile);
	}

	// --- The switch: absent is on, a record only after a flip, nonsense reads as the default ---
	const switchFile = persistentRoomGlobalInstructionsSettingPath(roomA);
	assert(switchFile === path.join(tempAgentsRoot, roomA, "runtime", "global-instructions.json"), "the switch is a small file in the room's runtime folder");
	assert(!fs.existsSync(switchFile) && readPersistentRoomGlobalInstructionsEnabled(roomA) === true && readPersistentRoomGlobalInstructionsSetting(roomA) === null, "a room that never flipped the switch is on, with no record");
	assertThrows(() => writePersistentRoomGlobalInstructionsEnabled(roomA, "off"), "enabled must be true or false", "the switch takes a boolean only");
	const off = writePersistentRoomGlobalInstructionsEnabled(roomA, false, {}, stamp);
	assert(off.enabled === false && off.updatedAt === stamp.toISOString() && readPersistentRoomGlobalInstructionsEnabled(roomA) === false, "off is stored and read back");
	assert(writePersistentRoomGlobalInstructionsEnabled(roomA, true).enabled === true && readPersistentRoomGlobalInstructionsEnabled(roomA) === true && fs.existsSync(switchFile), "on after a flip keeps its record");
	fs.writeFileSync(switchFile, "{not json", "utf-8");
	assert(readPersistentRoomGlobalInstructionsEnabled(roomA) === true && readPersistentRoomGlobalInstructionsSetting(roomA) === null, "a record nobody can read is the default, not an invented state");
	fs.writeFileSync(switchFile, JSON.stringify({ schemaVersion: 1, enabled: "no" }), "utf-8");
	assert(readPersistentRoomGlobalInstructionsEnabled(roomA) === true, "a record with a non-boolean is the default too");
	fs.rmSync(switchFile);
	assert(readPersistentRoomGlobalInstructionsEnabled(roomB) === true, "room B is on by default as well");

	// --- Composition: every permutation of the two texts and the switch, on the boot ---
	const neither = boot(roomA);
	assert(neither.layers.map((layer) => layer.id).join(",") === "l0,l1a,l1b,l2" && parsePersistentRoomInstructionsMarker(neither.systemPrompt) === null, "no text anywhere: the four classic layers, no marker");
	assert(neither.instructionsParts.includesGlobal === false && neither.instructionsParts.layerEstimatedTokens === null && neither.instructionsParts.globalEstimatedTokens === null && neither.instructionsParts.roomEstimatedTokens === null, "and the parts say so");
	const composedNeither = composePersistentRoomInstructions(roomA);
	assert(composedNeither.body === "" && composedNeither.fingerprint === null && composedNeither.includesGlobal === false && composedNeither.globalEnabled === true, "nothing composes to nothing");

	writeGlobalInstructions(globalText, {}, stamp);
	const globalOnly = boot(roomA);
	assert(globalOnly.layers.map((layer) => layer.id).join(",") === "l0,l1a,instructions,l1b,l2", "the global text alone gives the room an instructions layer in the usual place");
	const globalOnlyLayer = instructionsLayer(globalOnly)!;
	const composedGlobalOnly = composePersistentRoomInstructions(roomA);
	assert(ranksOverMemoryInOrder(globalOnlyLayer), "global only: the framing ranks the instructions over a memory note about how to work, once and in its place");
	assert(composedGlobalOnly.includesGlobal && composedGlobalOnly.body === `${GLOBAL_INSTRUCTIONS_SECTION_HEADING}\n\n${globalText}` && composedGlobalOnly.fingerprint === fingerprintPersistentRoomInstructions(composedGlobalOnly.body), "every-room only: the body is the global section, the fingerprint is the body's");
	assert(globalOnlyLayer.startsWith(`# Global Instructions Smoke A Instructions\n\n${persistentRoomInstructionsMarkerLine(composedGlobalOnly.fingerprint!)}\n`), "the layer opens with the room's heading and the composed fingerprint's marker");
	assert(parsePersistentRoomInstructionsMarker(globalOnly.systemPrompt) === composedGlobalOnly.fingerprint, "the boot prompt carries that marker");
	assert(globalOnlyLayer.includes("written in Settings for every room that has not switched them off; this room has none of its own on top"), "the framing says the text is for every room and this room adds nothing");
	assert(globalOnlyLayer.includes(`${GLOBAL_INSTRUCTIONS_SECTION_HEADING}\n\n${globalText}`) && !globalOnlyLayer.includes(ROOM_INSTRUCTIONS_SECTION_HEADING) && !globalOnlyLayer.includes("## Instructions\n\n"), "one section, headed for every room; no bare Instructions heading");
	assert(globalOnly.instructionsParts.includesGlobal && globalOnly.instructionsParts.globalEstimatedTokens! > 0 && globalOnly.instructionsParts.roomEstimatedTokens === null, "the parts name the global text and no room text");
	assert(globalOnly.promptBudget.l1aEstimatedTokens > neither.promptBudget.l1aEstimatedTokens && globalOnly.promptBudget.l1bEstimatedTokens === neither.promptBudget.l1bEstimatedTokens, "counted under the constitution's share, not the memory's");
	assert(instructionsLayer(boot(roomB)) === globalOnlyLayer.replace("Global Instructions Smoke A", "Global Instructions Smoke B"), "room B gets the same layer under its own name");

	savePersistentRoomInstructions(roomA, roomText);
	const both = boot(roomA);
	const bothLayer = instructionsLayer(both)!;
	const composedBoth = composePersistentRoomInstructions(roomA);
	assert(ranksOverMemoryInOrder(bothLayer), "both: the framing ranks the instructions over a memory note about how to work, once and in its place");
	assert(composedBoth.body === `${GLOBAL_INSTRUCTIONS_SECTION_HEADING}\n\n${globalText}\n\n${ROOM_INSTRUCTIONS_SECTION_HEADING}\n\n${roomText}`, "both: the global section first, this room's second");
	assert(bothLayer.indexOf(GLOBAL_INSTRUCTIONS_SECTION_HEADING) < bothLayer.indexOf(ROOM_INSTRUCTIONS_SECTION_HEADING), "and the prompt keeps that order");
	assert(bothLayer.includes("Where the two disagree, this room's own instructions apply.") && bothLayer.includes("say whether a rule is global or this room's own"), "the framing says the room's own wins and that the room can say which section a rule came from");
	assert(both.instructionsParts.globalEstimatedTokens! > 0 && both.instructionsParts.roomEstimatedTokens! > 0 && both.instructionsParts.layerEstimatedTokens! > both.instructionsParts.globalEstimatedTokens! + both.instructionsParts.roomEstimatedTokens!, "the parts carry both texts and the layer is more than their sum (framing)");
	assert(both.promptBudget.l1aEstimatedTokens > globalOnly.promptBudget.l1aEstimatedTokens, "the room's text grows the same share");
	const bothB = instructionsLayer(boot(roomB))!;
	assert(!bothB.includes(roomText) && bothB.includes(globalText), "room A's text stays in room A");

	writePersistentRoomGlobalInstructionsEnabled(roomA, false);
	const roomOnly = boot(roomA);
	const composedRoomOnly = composePersistentRoomInstructions(roomA);
	assert(ranksOverMemoryInOrder(instructionsLayer(roomOnly)!), "room only: the framing ranks the instructions over a memory note about how to work, once and in its place");
	assert(composedRoomOnly.includesGlobal === false && composedRoomOnly.globalEnabled === false && composedRoomOnly.global.text === globalText, "switched off: the global text is read but not composed");
	assert(composedRoomOnly.body === roomText && composedRoomOnly.fingerprint === fingerprintPersistentRoomInstructions(roomText), "room only: the body is the bare text and the fingerprint is the text's own, as thread records from before the global text already store");
	assert(instructionsLayer(roomOnly)!.includes("## Instructions\n\n" + roomText) && !instructionsLayer(roomOnly)!.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING), "the layer is the one a room always had");
	assert(roomOnly.instructionsParts.includesGlobal === false && roomOnly.instructionsParts.globalEnabled === false && roomOnly.instructionsParts.globalEstimatedTokens === null, "the parts say the global text is off here");
	assert(instructionsLayer(boot(roomB))!.includes(globalText), "room B still follows it: the switch is this room's alone");
	writeGlobalInstructions("");
	assert(instructionsLayer(boot(roomA)) === instructionsLayer(roomOnly), "switched off with the global text present is byte-identical to the global text not existing");
	writeGlobalInstructions(globalText, {}, stamp);
	writePersistentRoomGlobalInstructionsEnabled(roomA, true);
	assert(instructionsLayer(boot(roomA)) === bothLayer, "switched back on: the composed layer again, byte for byte");

	savePersistentRoomInstructions(roomA, "");
	writePersistentRoomGlobalInstructionsEnabled(roomA, false);
	const offAndEmpty = boot(roomA);
	assert(bootWithoutL2(offAndEmpty) === bootWithoutL2(neither) && offAndEmpty.promptBudget.l1aEstimatedTokens === neither.promptBudget.l1aEstimatedTokens, "switched off with no text of its own: byte-identical to a room that never had any (envelope aside)");
	writePersistentRoomGlobalInstructionsEnabled(roomA, true);
	writeGlobalInstructions("");
	savePersistentRoomInstructions(roomA, roomText);
	assert(instructionsLayer(boot(roomA)) === instructionsLayer(roomOnly), "an empty global text with the switch on: the room-only layer, unchanged");
	writeGlobalInstructions(globalText, {}, stamp);

	// --- Per-turn: any of the three changes reaches an open conversation, on the composition's fingerprint ---
	// Booted with the room's text alone (a record from before the global text existed), then the global text was written.
	const bootedRoomOnly = roomOnly;
	const gained = buildPersistentRoomCurrentInstructionsSection(roomA, bootedRoomOnly.systemPrompt, { bootedFingerprint: fingerprintPersistentRoomInstructions(roomText) });
	assert(gained.startsWith("\n\n## Current instructions\n") && gained.includes("changed the instructions this room follows after this conversation started"), "the global text written after the boot is a change to what this room follows");
	assert(gained.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING) && gained.includes(ROOM_INSTRUCTIONS_SECTION_HEADING) && gained.includes("Where the global instructions and this room's own disagree, this room's own apply."), "the section carries both headed texts and the one disagreement rule");
	assert(gained.trimEnd().endsWith(roomText), "this room's text comes last");
	assert(buildPersistentRoomCurrentInstructionsSection(roomA, both.systemPrompt, { bootedFingerprint: composedBoth.fingerprint }) === "", "booted with the composition as it is now: silent, no prompt growth");
	// Flip the switch off under a conversation that booted with both.
	writePersistentRoomGlobalInstructionsEnabled(roomA, false);
	const flippedOff = buildPersistentRoomCurrentInstructionsSection(roomA, both.systemPrompt, { bootedFingerprint: composedBoth.fingerprint });
	assert(flippedOff.includes("changed the instructions this room follows") && flippedOff.includes("## Instructions\n\n" + roomText) && !flippedOff.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING) && !flippedOff.includes("disagree"), "switched off mid-conversation: the section is this room's text alone, under the plain heading, with no disagreement rule to state");
	writePersistentRoomGlobalInstructionsEnabled(roomA, true);
	// Every-room text removed under a conversation that booted with it alone.
	savePersistentRoomInstructions(roomA, "");
	writeGlobalInstructions("");
	const removedGlobal = buildPersistentRoomCurrentInstructionsSection(roomA, globalOnly.systemPrompt, { bootedFingerprint: composedGlobalOnly.fingerprint });
	assert(removedGlobal.includes("removed the instructions this room followed") && removedGlobal.includes("no longer applies") && !removedGlobal.includes(globalText), "the global text removed with nothing of the room's own: a removal, carrying no text");
	// With the global text alone there is no disagreement to rule on.
	writeGlobalInstructions(globalText, {}, stamp);
	const globalOnlyGained = buildPersistentRoomCurrentInstructionsSection(roomA, neither.systemPrompt, { bootedFingerprint: null });
	assert(globalOnlyGained.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING) && !globalOnlyGained.includes("disagree"), "the per-turn section states the disagreement rule only when this room has text of its own");
	writeGlobalInstructions("");
	writeGlobalInstructions(globalText, {}, stamp);
	// Switched off under a conversation that booted with the global text alone: the same removal.
	writePersistentRoomGlobalInstructionsEnabled(roomA, false);
	assert(buildPersistentRoomCurrentInstructionsSection(roomA, globalOnly.systemPrompt, { bootedFingerprint: composedGlobalOnly.fingerprint }).includes("removed the instructions this room followed"), "switched off with no text of its own: a removal too");
	writePersistentRoomGlobalInstructionsEnabled(roomA, true);
	// A thread that booted without any (the prose fallback) is told the composition as it stands.
	const fallback = buildPersistentRoomCurrentInstructionsSection(roomA, neither.systemPrompt);
	assert(fallback.includes("started without instructions in its prompt") && fallback.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING) && fallback.includes(globalText), "a thread from before is told the global text on its next message");
	// The global file unreadable: silence, never a removal; the boot degrades to the room's own text.
	savePersistentRoomInstructions(roomA, roomText);
	fs.rmSync(globalFile);
	fs.mkdirSync(globalFile);
	try {
		assert(buildPersistentRoomCurrentInstructionsSection(roomA, both.systemPrompt, { bootedFingerprint: composedBoth.fingerprint }) === "", "an unreadable global file: the per-turn section says nothing rather than claiming a change");
		assert(instructionsLayer(boot(roomA)) === instructionsLayer(roomOnly), "and the boot degrades to this room's own text, never fails");
		assert(composePersistentRoomInstructions(roomA).global.unreadable === "it is a folder, not a file", "while the pane can still say what happened");
		writePersistentRoomGlobalInstructionsEnabled(roomA, false);
		assert(buildPersistentRoomCurrentInstructionsSection(roomA, both.systemPrompt, { bootedFingerprint: composedBoth.fingerprint }).includes("## Instructions\n\n" + roomText), "a room that switched it off does not care that the file is unreadable");
		writePersistentRoomGlobalInstructionsEnabled(roomA, true);
	} finally {
		fs.rmdirSync(globalFile);
	}
	writeGlobalInstructions(globalText, {}, stamp);

	// --- The thread record carries the composed fingerprint; a scheduled resume follows a change of the global text ---
	const threadModel = { provider: "openai-codex", model: "gpt-5.6-sol" };
	const resumeThreadId = "smoke-resume-composed";
	const resumeWrite = writePersistentAgentThread(roomA, resumeThreadId, { state: "standby", origin: "home", model: threadModel, items: [] }, {
		createRuntime: ({ instance, threadId, model: m }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId, model: m, cwd: tempAgentsRoot }),
	});
	assert(resumeWrite.thread.runtime.kind === "pi-session-jsonl" && resumeWrite.thread.runtime.instructionsFingerprint === composePersistentRoomInstructions(roomA).fingerprint, "the thread record stores the composed fingerprint");
	const frozenSnapshot = readPersistentAgentBootPromptSnapshot(roomA, resumeWrite.thread.runtime);
	assert(frozenSnapshot.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING) && frozenSnapshot.includes(roomText), "the frozen snapshot carries both texts");
	const unchangedRun = preparePersistentRoomBackgroundExecution({ roomId: roomA, target: { kind: "resume-thread", threadId: resumeThreadId }, prompt: "hello", executionId: "smoke-exec-1", cwd: tempAgentsRoot }, threadModel);
	assert(unchangedRun.rawSystemPrompt === frozenSnapshot, "unchanged: the scheduled run gets the frozen snapshot as it is");
	writeGlobalInstructions("Be verbose.", {}, stamp);
	const changedRun = preparePersistentRoomBackgroundExecution({ roomId: roomA, target: { kind: "resume-thread", threadId: resumeThreadId }, prompt: "hello", executionId: "smoke-exec-2", cwd: tempAgentsRoot }, threadModel);
	assert(changedRun.rawSystemPrompt!.startsWith(frozenSnapshot) && changedRun.rawSystemPrompt!.includes("## Current instructions") && changedRun.rawSystemPrompt!.includes("Be verbose.") && changedRun.rawSystemPrompt!.trimEnd().endsWith(roomText), "the global text changed: the scheduled run is told the new composition");
	writeGlobalInstructions(globalText, {}, stamp);

	// --- Consult: the consulted room answers with its composition; refusals name each text ---
	const consultBoot = boot(roomA);
	const consultLayer = instructionsLayer(consultBoot)!;
	const l0 = persistentAgentPlatformKernel();
	const l1aText = fs.readFileSync(path.join(tempAgentsRoot, roomA, "L1a.md"), "utf-8");
	const l1bText = fs.readFileSync(path.join(tempAgentsRoot, roomA, "L1b", "current.md"), "utf-8");
	const base = { targetAgentId: roomA, targetDisplayName: "Global Instructions Smoke A", question: "What is the plan?", l0, l1a: l1aText, l1b: l1bText, model, now: stamp };
	const consulted = buildConsultPrompt({ ...base, instructions: consultLayer });
	assert(consulted.prompt.includes(GLOBAL_INSTRUCTIONS_SECTION_HEADING) && consulted.prompt.includes(ROOM_INSTRUCTIONS_SECTION_HEADING), "the consult prompt carries both sections");
	const parts = { roomEstimatedTokens: consultBoot.instructionsParts.roomEstimatedTokens, globalEstimatedTokens: consultBoot.instructionsParts.globalEstimatedTokens };
	const consultBoth = overflowMessage(() => buildConsultPrompt({ ...base, instructions: consultLayer, instructionsParts: parts, promptTokenBudget: 10 }));
	assert(/The consulted room's instructions and the global instructions are ~\d+ of those tokens together \(~\d+ that room's, ~\d+ global\)/.test(consultBoth) && consultBoth.includes("Settings → Instructions") && consultBoth.includes("switching the global instructions off for that room"), "consult refusal with both: each text with its size, both panes, and the switch");
	const consultGlobalOnly = overflowMessage(() => buildConsultPrompt({ ...base, instructions: globalOnlyLayer, instructionsParts: { roomEstimatedTokens: null, globalEstimatedTokens: 7 }, promptTokenBudget: 10 }));
	assert(/The global instructions are ~\d+ of those tokens/.test(consultGlobalOnly) && consultGlobalOnly.includes("switching them off for that room"), "consult refusal with the global text alone: its pane and the room's switch");
	const consultRoomOnly = overflowMessage(() => buildConsultPrompt({ ...base, instructions: consultLayer, promptTokenBudget: 10 }));
	assert(/The consulted room's instructions are ~\d+ of those tokens: shortening them in that room's Room settings/.test(consultRoomOnly), "without parts (a room-only layer), the sentence a consult always had");
	const tinyWindow = { contextWindow: 2000, maxOutputTokens: 1000 };
	const bootBoth = overflowMessage(() => assertPersistentAgentBootPromptFitsWindow({ agentId: roomA, model, systemPrompt: consultBoot.systemPrompt, window: tinyWindow }));
	assert(/This room's instructions and the global instructions are ~\d+ of those tokens together \(~\d+ this room's, ~\d+ global\)/.test(bootBoth) && bootBoth.includes("Room settings → Instructions") && bootBoth.includes("Settings → Instructions") && bootBoth.includes("switching the global instructions off for this room") && bootBoth.includes("then choosing Forget"), "the boot refusal with both: each text with its size, both panes, the switch, and Forget");
	savePersistentRoomInstructions(roomA, "");
	const bootGlobalOnly = overflowMessage(() => assertPersistentAgentBootPromptFitsWindow({ agentId: roomA, model, systemPrompt: consultBoot.systemPrompt, window: tinyWindow }));
	assert(/The global instructions are ~\d+ of those tokens/.test(bootGlobalOnly) && bootGlobalOnly.includes("switching them off for this room in Room settings → Instructions"), "the boot refusal with the global text alone: its pane and this room's switch");
	const namedTokens = Number(/global instructions are ~(\d+) of those tokens/.exec(bootGlobalOnly)![1]);
	assert(Math.abs(namedTokens - boot(roomA).instructionsParts.layerEstimatedTokens!) <= 1, "the size named is the layer's, framing included");
	const bothTotal = Number(/are ~(\d+) of those tokens together/.exec(bootBoth)![1]);
	assert(Math.abs(bothTotal - consultBoot.instructionsParts.layerEstimatedTokens!) <= 1, "with both texts the size named first is the layer's too, the parts in parentheses");
	writePersistentRoomGlobalInstructionsEnabled(roomA, false);
	const bootNone = overflowMessage(() => assertPersistentAgentBootPromptFitsWindow({ agentId: roomA, model, systemPrompt: consultBoot.systemPrompt, window: tinyWindow }));
	assert(!bootNone.includes("instructions are ~") && !bootNone.includes("global instructions are ~"), "switched off with no text of its own: the refusal speaks of memory alone");
	writePersistentRoomGlobalInstructionsEnabled(roomA, true);
	savePersistentRoomInstructions(roomA, roomText);

	// --- The room-level view and the switch's save: holds, refusals, and the global write that no hold refuses ---
	const view = getPersistentRoomInstructionsView(roomA);
	assert(view.instructions.text === roomText && view.global.instructions.text === globalText && view.global.enabled === true && typeof view.global.updatedAt === "string", "the view carries this room's text, the global text and the switch with when it last flipped");
	fs.rmSync(persistentRoomGlobalInstructionsSettingPath(roomA));
	assert(getPersistentRoomInstructionsView(roomA).global.updatedAt === null, "a room that never flipped reports no flip time");
	const missing = assertThrows(() => savePersistentRoomGlobalInstructionsEnabled("no-such-room", false), "not found", "the switch refuses an unknown room");
	assert((missing as any).statusCode === 404, "unknown room is 404");
	const notBoolean = assertThrows(() => savePersistentRoomGlobalInstructionsEnabled(roomA, "off"), "enabled must be true or false", "the switch refuses a non-boolean");
	assert((notBoolean as any).statusCode === 400 && readPersistentRoomGlobalInstructionsEnabled(roomA) === true, "as the client's fault, leaving the state");
	const cliOwner = { surface: "cli", pid: process.pid };
	assert(roomLock.tryAcquire(roomA, cliOwner).ok, "smoke acquires room A as a CLI session");
	try {
		const held = assertThrows(() => savePersistentRoomGlobalInstructionsEnabled(roomA, false), "open in a CLI session; switch the global instructions off for it when that session ends", "a CLI session blocks the switch, naming the remedy in the words of the flip");
		assert((held as any).statusCode === 409 && readPersistentRoomGlobalInstructionsEnabled(roomA) === true, "a held room is a conflict and the state is unchanged");
		assert(writeGlobalInstructions("Written while room A is held.", {}, stamp).text === "Written while room A is held.", "the global text has no hold: it is in no room's folder");
		assert(buildPersistentRoomCurrentInstructionsSection(roomA, both.systemPrompt, { bootedFingerprint: composedBoth.fingerprint }).includes("Written while room A is held."), "and the held room follows it on its next message like any other");
	} finally {
		roomLock.release(roomA, cliOwner);
	}
	writeGlobalInstructions(globalText, {}, stamp);
	const schedulerOwner = { surface: "scheduler", pid: process.pid, lockId: "smoke-run" };
	assert(roomLock.tryAcquire(roomA, schedulerOwner).ok, "smoke acquires room A as a scheduler run");
	try {
		assertThrows(() => savePersistentRoomGlobalInstructionsEnabled(roomA, true), "working on a scheduled background task; switch the global instructions on for it when that finishes", "a scheduled run blocks the switch too");
	} finally {
		roomLock.release(roomA, schedulerOwner);
	}
	const webOwner = { surface: "web", pid: process.pid };
	assert(roomLock.tryAcquire(roomA, webOwner).ok, "smoke opens room A in the web app");
	try {
		assert(savePersistentRoomGlobalInstructionsEnabled(roomA, false).global.enabled === false, "a room open in the web app accepts the flip");
		assert(savePersistentRoomGlobalInstructionsEnabled(roomA, true).global.enabled === true, "in both directions");
	} finally {
		roomLock.release(roomA, webOwner);
	}
	// A write that fails on the file system is the server's failure, tagged
	// 500 so the route answers with its own path-free sentence instead of the
	// file system's; the room still reads as on.
	const switchPath = persistentRoomGlobalInstructionsSettingPath(roomA);
	fs.rmSync(switchPath);
	fs.mkdirSync(switchPath);
	try {
		const failed = assertThrows(() => savePersistentRoomGlobalInstructionsEnabled(roomA, false), "", "a folder where the switch record goes fails the flip");
		assert((failed as any).statusCode === 500, `a failed switch write is a server error, got ${(failed as any).statusCode}`);
		assert(readPersistentRoomGlobalInstructionsEnabled(roomA) === true, "and the room's setting is unchanged");
	} finally {
		fs.rmSync(switchPath, { recursive: true });
	}

	// --- Route policy: the three routes are classified like the room's own ---
	assert(classifyRemoteRoute("GET", "/api/settings/instructions") === "read", "reading the global text is a read");
	assert(classifyRemoteRoute("PUT", "/api/settings/instructions") === "write", "writing it is a write");
	assert(classifyRemoteRoute("PUT", "/api/persistent-agents/:id/instructions/global") === "write", "the switch is a write");

	// --- No layer text for nothing, whatever the switch says ---
	assert(buildPersistentRoomInstructionsLayer({ displayName: "X", composed: { ...composedNeither, globalEnabled: false } }) === null, "nothing composed → no layer");

	console.log("global-instructions smoke: ok");
} finally {
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
}
