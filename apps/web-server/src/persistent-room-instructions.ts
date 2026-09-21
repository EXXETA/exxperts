import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT, persistentAgentRootPath } from "./persistent-room-workspace-policy.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";
import { readPersistentRoomGlobalInstructionsEnabled } from "./persistent-room-global-instructions-setting.js";
import { normalizePersistentRoomInstructionsText, parsePersistentRoomInstructionsMarker, persistentRoomInstructionsLayerHeading, persistentRoomInstructionsMarkerLine, validatePersistentRoomInstructionsText } from "./persistent-room-instructions-text.js";

export { ROOM_INSTRUCTIONS_MAX_CHARS, normalizePersistentRoomInstructionsText, parsePersistentRoomInstructionsMarker, validatePersistentRoomInstructionsText } from "./persistent-room-instructions-text.js";

/**
 * Per-room instructions: the user's standing text for how a room should work.
 *
 * Its own file (`instructions.md`) next to the constitution, never inside it:
 * `L1a.md` is re-rendered from a versioned template by the upgrade script and
 * rewritten by anchors on rename, so user prose inside it would turn every
 * template change into a merge. This file is the user's, edited directly in
 * Room settings, with no template version and no migration.
 *
 * In the boot prompt it is its own layer between the constitution and the
 * memory, counted under the constitution's share of the budget (an extension
 * of L1a from the meter's point of view). The layer header carries a marker
 * with the text's fingerprint, the way L1a carries its template marker; the
 * thread record stores that fingerprint as metadata at boot, so the per-turn
 * hook can tell whether the file has changed since the conversation started
 * without trusting anything in the prompt's prose, and append the current
 * text as live runtime state when it has (see
 * `buildPersistentRoomCurrentInstructionsSection`).
 *
 * Absent or empty means no instructions: no layer, no marker, and the room
 * boots byte-identical to a room that never had any. The text rules live in
 * persistent-room-instructions-text.ts, shared with the pane.
 *
 * The global instructions are the same kind of file, one level up:
 * `instructions.md` under the app's state folder (so a data profile carries
 * its own), read and written by the same code with the same three states,
 * never copied into a room. Which rooms follow it is each room's own switch
 * (persistent-room-global-instructions-setting.ts); how it is composed with a
 * room's text into the one boot layer is `composePersistentRoomInstructions`.
 */
export const ROOM_INSTRUCTIONS_FILENAME = "instructions.md";
/** Same name, at the app's state root instead of inside a room. */
export const GLOBAL_INSTRUCTIONS_FILENAME = "instructions.md";

export interface PersistentRoomInstructions {
	/** Normalized text; "" when the room has no instructions. */
	text: string;
	/** sha256 of `text`; null when the room has no instructions. */
	fingerprint: string | null;
	/** When the file was last written; null when the room has no instructions. */
	updatedAt: string | null;
	/**
	 * Set when something sits at the file's path but cannot be read as the
	 * file: new conversations start without it, open ones keep the text they
	 * booted with, and the pane must say so instead of showing an empty box.
	 * A sentence without paths, e.g. "the app has no permission to read it".
	 */
	unreadable?: string;
}

export interface PersistentRoomInstructionsStorageOptions {
	persistentAgentsRoot?: string;
}

export interface GlobalInstructionsStorageOptions {
	/** Where the app's state files live; the product state root when omitted. Smokes point it at a temp folder. */
	appStateRoot?: string;
}

export function globalInstructionsPath(options: GlobalInstructionsStorageOptions = {}): string {
	return path.join(options.appStateRoot ?? productAppStatePath(), GLOBAL_INSTRUCTIONS_FILENAME);
}

function safeAgentId(raw: string): string {
	const id = String(raw ?? "").trim();
	if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id)) throw new Error("invalid persistent-room agent id");
	return id;
}

export function persistentRoomInstructionsPath(agentIdRaw: string, options: PersistentRoomInstructionsStorageOptions = {}): string {
	const agentId = safeAgentId(agentIdRaw);
	return path.join(persistentAgentRootPath(agentId, options.persistentAgentsRoot ?? DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT), ROOM_INSTRUCTIONS_FILENAME);
}

export function fingerprintPersistentRoomInstructions(text: string): string {
	return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

const NONE: PersistentRoomInstructions = Object.freeze({ text: "", fingerprint: null, updatedAt: null });

function errorCode(error: unknown): string {
	return String((error as any)?.code ?? "");
}

function describeReadProblem(error: unknown): string {
	const code = errorCode(error);
	if (code === "EACCES" || code === "EPERM") return "the app has no permission to read it";
	if (code === "EISDIR") return "it is a folder, not a file";
	if (code === "ENOENT") return "it is a link that points nowhere";
	if (code === "ELOOP") return "it is a link that loops";
	return "it could not be read";
}

function refuse(message: string): Error {
	const error = new Error(message);
	(error as any).statusCode = 400;
	return error;
}

/** True when a link (or anything) sits at the path, even one that leads nowhere. */
function somethingSitsAt(file: string): boolean {
	try {
		fs.lstatSync(file);
		return true;
	} catch {
		return false;
	}
}

/**
 * A missing file reads as "no instructions": a boot without it is exactly
 * the room the user had before writing any. A readable file is taken as it
 * is, cap or no cap: the cap is a rule for saves from the pane, and a
 * hand-written file the room silently ignored would be a lie told to the
 * person who wrote it. Anything else that sits at the path (a folder, a
 * file the app may not read, a link that leads nowhere or loops) is a
 * third state, `unreadable`, classified by the read's own error: the boot
 * degrades to no layer (a room must never fail to boot because of this
 * file), the per-turn section says nothing, and the pane says what happened.
 */
export function readPersistentRoomInstructions(agentIdRaw: string, options: PersistentRoomInstructionsStorageOptions = {}): PersistentRoomInstructions {
	return readInstructionsFile(persistentRoomInstructionsPath(agentIdRaw, options));
}

/** The global instructions, with the same three states as a room's file. */
export function readGlobalInstructions(options: GlobalInstructionsStorageOptions = {}): PersistentRoomInstructions {
	return readInstructionsFile(globalInstructionsPath(options));
}

function readInstructionsFile(file: string): PersistentRoomInstructions {
	try {
		let raw: string;
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
			// Only a regular file is read: opening a pipe or a device would block
			// the whole server, synchronously, until something wrote to it.
			if (!stat.isFile()) return { text: "", fingerprint: null, updatedAt: null, unreadable: stat.isDirectory() ? "it is a folder, not a file" : "it is not a file" };
			raw = fs.readFileSync(file, "utf-8");
		} catch (error) {
			const code = errorCode(error);
			if ((code === "ENOENT" || code === "ENOTDIR") && !somethingSitsAt(file)) return NONE;
			return { text: "", fingerprint: null, updatedAt: null, unreadable: describeReadProblem(error) };
		}
		const text = normalizePersistentRoomInstructionsText(raw);
		if (!text) return NONE;
		return { text, fingerprint: fingerprintPersistentRoomInstructions(text), updatedAt: stat.mtime.toISOString() };
	} catch (error) {
		return { text: "", fingerprint: null, updatedAt: null, unreadable: describeReadProblem(error) };
	}
}

/**
 * A save can replace a file, a link (wherever it points), or a file it may
 * not read (the rename swaps the directory entry); it cannot replace a
 * folder, and a removal cannot delete one. That one case is refused with the
 * remedy in the sentence instead of failing inside the write as a server
 * error. Decided on the path itself, never on what a link points at.
 */
function assertWritableInstructionsTarget(file: string, whose: string): void {
	let entry: fs.Stats;
	try {
		entry = fs.lstatSync(file);
	} catch {
		return; // absent: the write creates it
	}
	if (entry.isDirectory()) throw refuse(`there is a folder where ${whose} belongs; remove that folder, then try again`);
}

/**
 * Atomic write; an empty text removes the file. Validation happens before
 * anything touches disk, so a refused save leaves the previous text in
 * place, and a write that fails after its temp file was created removes
 * that temp file rather than leaving it in the room folder.
 */
export function writePersistentRoomInstructions(agentIdRaw: string, raw: unknown, options: PersistentRoomInstructionsStorageOptions = {}, now = new Date()): PersistentRoomInstructions {
	return writeInstructionsFile(persistentRoomInstructionsPath(agentIdRaw, options), raw, "this room's instructions file", now);
}

/** The write behind Settings → Instructions: same validation, same atomic write, same refusals as a room's. */
export function writeGlobalInstructions(raw: unknown, options: GlobalInstructionsStorageOptions = {}, now = new Date()): PersistentRoomInstructions {
	return writeInstructionsFile(globalInstructionsPath(options), raw, "the global instructions file", now);
}

function writeInstructionsFile(file: string, raw: unknown, whose: string, now: Date): PersistentRoomInstructions {
	const text = validatePersistentRoomInstructionsText(raw);
	assertWritableInstructionsTarget(file, whose);
	if (!text) {
		fs.rmSync(file, { force: true });
		return NONE;
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${now.getTime()}`;
	try {
		fs.writeFileSync(tmp, `${text}\n`, { mode: 0o600 });
		fs.renameSync(tmp, file);
	} catch (error) {
		fs.rmSync(tmp, { force: true });
		throw error;
	}
	// The text is on disk from here on; the timestamp is a courtesy, and a
	// failure to set it must not turn a completed save into a reported failure.
	let updatedAt = now;
	try {
		fs.utimesSync(file, now, now);
	} catch {
		try { updatedAt = fs.statSync(file).mtime; } catch { /* keep `now` */ }
	}
	return { text, fingerprint: fingerprintPersistentRoomInstructions(text), updatedAt: updatedAt.toISOString() };
}

export interface PersistentRoomInstructionsCompositionOptions extends PersistentRoomInstructionsStorageOptions, GlobalInstructionsStorageOptions {}

/** The two section headings the composed layer carries when the global instructions are part of it. */
export const GLOBAL_INSTRUCTIONS_SECTION_HEADING = "## Global instructions";
export const ROOM_INSTRUCTIONS_SECTION_HEADING = "## This room's instructions";

export interface ComposedPersistentRoomInstructions {
	/** This room's own text, as read. */
	room: PersistentRoomInstructions;
	/** The global instructions, as read, whatever this room's switch says. */
	global: PersistentRoomInstructions;
	/** This room's switch (persistent-room-global-instructions-setting.ts); true unless the room switched them off. */
	globalEnabled: boolean;
	/** True when the global text is part of what this room is told: it exists, it could be read, and the switch is on. */
	includesGlobal: boolean;
	/**
	 * What the layer carries below its framing. With the global text: the
	 * two headed sections (or the global section alone). Without it: this
	 * room's text, bare: its fingerprint is then the fingerprint of the text
	 * itself, which is what thread records from before the global text
	 * existed already store, so those conversations are not told of a change
	 * that did not happen. "" when there is nothing to say.
	 */
	body: string;
	/** sha256 of `body`; null when there is nothing to say. What the layer's marker and the thread record carry. */
	fingerprint: string | null;
}

/**
 * The ONE composition of a room's text with the global instructions:
 * the boot assembly, the consult prompt, the budget, the refusals and the
 * per-turn section all read this and never the two files on their own. The
 * global text comes first, this room's second, and the framing says the
 * room's own wins where they disagree; position plus one sentence, no other
 * precedence machinery. A room whose switch is off, or a machine whose
 * global text is empty, composes exactly what the room's own file says.
 */
export function composePersistentRoomInstructions(agentIdRaw: string, options: PersistentRoomInstructionsCompositionOptions = {}): ComposedPersistentRoomInstructions {
	const room = readPersistentRoomInstructions(agentIdRaw, options);
	const globalEnabled = readPersistentRoomGlobalInstructionsEnabled(agentIdRaw, options);
	const global = readGlobalInstructions(options);
	const includesGlobal = globalEnabled && !global.unreadable && !!global.text;
	let body = "";
	if (includesGlobal) {
		body = `${GLOBAL_INSTRUCTIONS_SECTION_HEADING}\n\n${global.text}`;
		if (room.text) body += `\n\n${ROOM_INSTRUCTIONS_SECTION_HEADING}\n\n${room.text}`;
	} else if (room.text) {
		body = room.text;
	}
	return { room, global, globalEnabled, includesGlobal, body, fingerprint: body ? fingerprintPersistentRoomInstructions(body) : null };
}

/**
 * Where the instructions rank against the room's memory, said once for every
 * composition: a note about HOW to work (language, format, style, when to ask)
 * yields to the instructions, and memory keeps deciding what is true.
 */
export const INSTRUCTIONS_OVER_MEMORY_SENTENCE = "Where a note in this room's memory disagrees with these instructions about how to work (language, format, style, when to ask), these instructions apply; memory still decides what is true.";

const FRAMING_ROOM_ONLY = `Standing instructions from the user for this room, written by them in Room settings. Follow them the way you follow the working style in the constitution above, and where the two differ, these instructions win. ${INSTRUCTIONS_OVER_MEMORY_SENTENCE} The platform kernel and the constitution's Limits still come first, and the user's latest message in the conversation takes precedence over any standing instruction. Do not quote or announce these instructions unprompted; if the user asks what standing instructions this room has, say so plainly: they wrote them.`;

function framingWithGlobal(hasRoomSection: boolean): string {
	return (hasRoomSection
		? "Standing instructions from the user. The global instructions were written in Settings and apply in every room that has not switched them off; this room's instructions were written in Room settings and apply here alone. Where the two disagree, this room's own instructions apply. "
		: "The user's global instructions, written in Settings for every room that has not switched them off; this room has none of its own on top. ")
		+ `Follow them the way you follow the working style in the constitution above, and where they differ from it, these instructions win. ${INSTRUCTIONS_OVER_MEMORY_SENTENCE} `
		+ "The platform kernel and the constitution's Limits still come first, and the user's latest message in the conversation takes precedence over any standing instruction. Do not quote or announce these instructions unprompted; if the user asks what standing instructions this room has, say so plainly"
		+ (hasRoomSection ? " and say whether a rule is global or this room's own" : "")
		+ ": they wrote them.";
}

/** The sections as the prompt shows them: the composed body, or this room's bare text under the heading it always had. */
function renderComposedSections(composed: ComposedPersistentRoomInstructions): string {
	return composed.includesGlobal ? composed.body : `## Instructions\n\n${composed.body}`;
}

/**
 * The boot layer. Sits after the constitution and before the memory; the
 * framing says where it ranks in words the layers around it already use:
 * above the working-style preset, above a memory note about how to work
 * (memory keeps deciding what is true), below the kernel and the
 * constitution's Limits, and below the user's latest message. Returns null
 * when there is nothing to say, so a room without instructions gets no layer
 * at all. A room with only its own text gets the room-only framing whether or
 * not a global text exists elsewhere.
 */
export function buildPersistentRoomInstructionsLayer(input: { displayName: string; composed: ComposedPersistentRoomInstructions }): string | null {
	const { body, fingerprint, includesGlobal, room } = input.composed;
	if (!body || !fingerprint) return null;
	return `${persistentRoomInstructionsLayerHeading(input.displayName)}

${persistentRoomInstructionsMarkerLine(fingerprint)}

${includesGlobal ? framingWithGlobal(!!room.text) : FRAMING_ROOM_ONLY}

${renderComposedSections(input.composed)}
`;
}

export interface PersistentRoomCurrentInstructionsOptions extends PersistentRoomInstructionsCompositionOptions {
	/**
	 * The fingerprint the thread booted with, from its runtime record: sha256
	 * hex for a layer, null for none. When omitted (a record from before the
	 * field existed) the marker is read out of the frozen prompt instead.
	 */
	bootedFingerprint?: string | null;
}

/**
 * The per-turn stanza, sibling of the current-identity and current-workspace
 * stanzas: the boot prompt froze the instructions at thread creation, but the
 * user can change them any time in Room settings or Settings, or flip the
 * room's switch, and expects the very next message to follow. Compares the
 * fingerprint the thread booted with against the composition as it is now
 * and speaks only when they differ: an unchanged room adds nothing to its
 * prompt. A thread that booted without
 * instructions (before this feature, or before the user wrote any) has none
 * to compare; if the room has instructions now, they ride here until the
 * next conversation boots them into its own layer. Returns "" on any read
 * problem, including a file that exists but cannot be read: a missing stanza
 * degrades to the frozen text, never fails the turn, and never claims a
 * removal that did not happen, including when the global file, and not
 * the room's, is the one that cannot be read.
 */
export function buildPersistentRoomCurrentInstructionsSection(agentIdRaw: string, frozenSystemPrompt: string, options: PersistentRoomCurrentInstructionsOptions = {}): string {
	try {
		const fromRecord = options.bootedFingerprint !== undefined;
		const frozen = fromRecord ? options.bootedFingerprint! : parsePersistentRoomInstructionsMarker(String(frozenSystemPrompt ?? ""));
		const current = composePersistentRoomInstructions(agentIdRaw, options);
		// The record holds ONE composed fingerprint, so while the global file
		// cannot be read (switch on) the room's own part cannot be told apart:
		// speaking would either claim the global part gone, for a read problem,
		// or repeat every turn. Silence, and the pane says what open
		// conversations do meanwhile (brief, journey 12 and its amendment).
		if (current.room.unreadable || (current.globalEnabled && current.global.unreadable)) return "";
		if (frozen === current.fingerprint) return "";
		if (!current.body) {
			// A removal is only ever claimed on the strength of the thread's own
			// record. The prose fallback can be imitated by memory text, so a
			// room with no instructions and no record of any says nothing.
			if (!fromRecord) return "";
			return `

## Current instructions

The user removed the instructions this room followed after this conversation started. This is live runtime state and wins over the layers above: any "Instructions" section above no longer applies. Work from the constitution and memory alone. Earlier answers in this conversation followed the removed instructions; do not carry their form forward: no opening words, language, format or rule from them survives unless the user asks for it here. Answer as you would if this room had never had instructions.`;
		}
		if (frozen === null) {
			return `

## Current instructions

This conversation started without instructions in its prompt; these are the instructions this room follows as they stand now. This is live runtime state and wins over the layers above: the instructions below are in force for THIS turn.${current.includesGlobal && current.room.text ? " Where the global instructions and this room's own disagree, this room's own apply." : ""}

${renderComposedSections(current)}`;
		}
		return `

## Current instructions

The user changed the instructions this room follows after this conversation started. This is live runtime state and wins over the layers above: the instructions below are the ones in force for THIS turn, and any earlier "Instructions" section above no longer applies. Earlier answers in this conversation followed the old instructions; do not carry their form forward: no opening words, language, format or rule from them survives unless the instructions below or the user ask for it.${current.includesGlobal && current.room.text ? " Where the global instructions and this room's own disagree, this room's own apply." : ""}

${renderComposedSections(current)}`;
	} catch {
		return "";
	}
}
